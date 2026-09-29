"""imc_data.py — build the English token stream for from-scratch IMC training.

    python -m forge.imc_data --out /content/imc-data --tokens 10000000000

Steps, all deterministic for a given --seed, with memory independent of size:
  1. stream each source from Hugging Face into <out>/raw/<name>.jsonl until its
     share of the character budget is collected (documents are kept whole);
  2. train a byte-level BPE tokenizer (default 65,536 tokens) on a sample taken
     from the start of each raw file, in proportion to the mix;
  3. interleave documents from all sources at random (weighted by what is left
     in each), tokenize, append EOS after each one and write <out>/stream.bin
     (uint16) + stream.json, the format forge/train_ilaria.py --data <out>/stream
     reads. Interleaving keeps the trainer's tail validation split mixed.

Gated sources read the Hugging Face token from the HF_TOKEN environment
variable (on Colab: google.colab.userdata), never from arguments or files.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import os
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Iterator

import numpy as np


@dataclass(frozen=True)
class Source:
    name: str
    dataset: str
    config: str | None
    share: float
    chars_per_token: float = 4.2   # English prose; code and math compress worse
    split: str = "train"
    field: str = "text"


# English stage-1 style mix from the 2026-09-28 data research (SmolLM3 stage 1
# is 85% web / 12% code / 3% math; math is raised because small models learn
# it late). Nemotron-CC web joins when NVIDIA approves access.
MIX = (
    Source("dclm", "mlfoundations/dclm-baseline-1.0", None, 0.40),
    Source("fineweb-edu", "HuggingFaceFW/fineweb-edu", "sample-100BT", 0.40),
    Source("code-algorithmic", "OpenCoder-LLM/opc-annealing-corpus", "algorithmic_corpus", 0.06, 3.2),
    Source("code-snippets", "OpenCoder-LLM/opc-annealing-corpus", "synthetic_code_snippet", 0.03, 3.2),
    Source("code-web", "OpenCoder-LLM/opc-fineweb-code-corpus", None, 0.03, 3.6),
    Source("math-nemotron", "nvidia/Nemotron-CC-Math-v1", "4plus", 0.04, 3.4),
    Source("math-finemath", "HuggingFaceTB/finemath", "finemath-4plus", 0.04, 3.4),
)

SPECIAL_TOKENS = ["<|endoftext|>", "<|pad|>", "<|im_start|>", "<|im_end|>"]


def check_mix(mix: Iterable[Source]) -> None:
    mix = list(mix)
    total = sum(s.share for s in mix)
    if abs(total - 1.0) > 1e-9:
        raise ValueError(f"mix shares sum to {total}, not 1")
    names = [s.name for s in mix]
    if len(set(names)) != len(names):
        raise ValueError("duplicate source names")


def hf_stream(src: Source) -> Iterator[str]:
    from datasets import load_dataset
    ds = load_dataset(src.dataset, src.config, split=src.split, streaming=True,
                      token=os.environ.get("HF_TOKEN") or None)
    for row in ds:
        text = row.get(src.field)
        if isinstance(text, str) and text.strip():
            yield text


def collect(src: Source, char_budget: int, stream: Callable[[Source], Iterable[str]], path: Path) -> dict:
    """Write whole documents from the start of the stream to path (JSONL) until
    char_budget is reached."""
    docs, chars = 0, 0
    with open(path, "w", encoding="utf-8") as f:
        for text in stream(src):
            if chars >= char_budget:
                break
            f.write(json.dumps(text, ensure_ascii=False) + "\n")
            docs += 1
            chars += len(text)
    if chars < char_budget:
        raise ValueError(f"{src.name}: source exhausted at {chars:,} of {char_budget:,} characters")
    return {"documents": docs, "characters": chars}


def read_docs(path: Path) -> Iterator[str]:
    # JSONL split on "\n" only: json.dumps escapes every line separator inside strings.
    with open(path, encoding="utf-8", newline="\n") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def train_tokenizer(raw: dict[str, Path], mix: Iterable[Source], vocab_size: int, sample_chars: int):
    from tokenizers import Tokenizer, decoders, models, pre_tokenizers, processors, trainers

    def sample() -> Iterator[str]:
        for src in mix:
            budget, used = int(sample_chars * src.share), 0
            for d in read_docs(raw[src.name]):
                if used >= budget:
                    break
                used += len(d)
                yield d

    tok = Tokenizer(models.BPE(byte_fallback=False))
    tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    tok.decoder = decoders.ByteLevel()
    tok.post_processor = processors.ByteLevel(trim_offsets=False)
    trainer = trainers.BpeTrainer(vocab_size=vocab_size, special_tokens=SPECIAL_TOKENS,
                                  initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),
                                  show_progress=False)
    tok.train_from_iterator(sample(), trainer=trainer)
    return tok


def interleave(raw: dict[str, Path], counts: dict[str, int], seed: int) -> Iterator[tuple[str, str]]:
    """Every document exactly once; at each step a source is drawn with
    probability proportional to its remaining documents."""
    rng = random.Random(seed)
    iters = {name: read_docs(path) for name, path in raw.items()}
    left = dict(counts)
    while True:
        names = [n for n, k in left.items() if k > 0]
        if not names:
            return
        name = rng.choices(names, weights=[left[n] for n in names])[0]
        left[name] -= 1
        yield name, next(iters[name])


def write_stream(raw: dict[str, Path], counts: dict[str, int], tok, out: Path, seed: int,
                 batch: int = 8192) -> dict:
    vocab = tok.get_vocab_size()
    if vocab > 65536:
        raise ValueError("uint16 stream needs a vocabulary of at most 65,536 tokens")
    eos = tok.token_to_id("<|endoftext|>")
    by_source = {name: 0 for name in raw}
    total, documents = 0, 0
    digest = hashlib.sha256()
    pending: list[tuple[str, str]] = []

    def flush(f) -> None:
        nonlocal total, documents
        for (name, _), enc in zip(pending, tok.encode_batch([t for _, t in pending])):
            data = np.asarray(enc.ids + [eos], dtype="<u2").tobytes()
            f.write(data)
            digest.update(data)
            by_source[name] += len(data) // 2
            total += len(data) // 2
            documents += 1
        pending.clear()

    with open(out / "stream.bin", "wb") as f:
        for item in interleave(raw, counts, seed):
            pending.append(item)
            if len(pending) == batch:
                flush(f)
                if documents % (batch * 50) == 0:
                    print(f"[imc-data] tokenized {documents:,} documents, {total:,} tokens", flush=True)
        flush(f)
    return {"dtype": "uint16", "vocab_size": vocab, "eos_id": eos, "tokens": total,
            "tokenizer": str(out / "tokenizer.json"), "sha256": digest.hexdigest(),
            "tokens_by_source": by_source, "documents": documents, "seed": seed}


def build(out: Path, tokens: int, vocab_size: int, tokenizer_sample_chars: int, seed: int,
          mix: Iterable[Source] = MIX, stream: Callable[[Source], Iterable[str]] = hf_stream,
          keep_raw: bool = False, tokenizer: Path | None = None, skip: dict[str, int] | None = None) -> dict:
    """tokenizer: reuse an existing tokenizer.json instead of training one (a
    continuation stream must share its token ids). skip: documents to pass
    over at the start of each source, e.g. the documents_by_source of an
    earlier build, so the new stream does not repeat it."""
    mix = list(mix)
    check_mix(mix)
    skip = dict(skip or {})
    unknown = set(skip) - {s.name for s in mix}
    if unknown:
        raise ValueError(f"skip names unknown sources: {sorted(unknown)}")
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        raise FileExistsError(f"{out} is not empty")
    (out / "raw").mkdir()
    raw, counts = {}, {}
    for src in mix:
        raw[src.name] = out / "raw" / f"{src.name}.jsonl"
        n_skip = skip.get(src.name, 0)
        skipping = (lambda s, n=n_skip: itertools.islice(stream(s), n, None)) if n_skip else stream
        stats = collect(src, int(tokens * src.share * src.chars_per_token), skipping, raw[src.name])
        counts[src.name] = stats["documents"]
        print(f"[imc-data] {src.name}: {stats['documents']:,} documents, {stats['characters']:,} characters", flush=True)
    if tokenizer is not None:
        from tokenizers import Tokenizer
        tok = Tokenizer.from_file(str(tokenizer))
    else:
        tok = train_tokenizer(raw, mix, vocab_size, tokenizer_sample_chars)
    tok.save(str(out / "tokenizer.json"))
    print(f"[imc-data] tokenizer: {tok.get_vocab_size():,} tokens", flush=True)
    meta = write_stream(raw, counts, tok, out, seed)
    meta["mix"] = {s.name: {"dataset": s.dataset, "config": s.config, "share": s.share} for s in mix}
    meta["documents_by_source"] = counts
    meta["skipped_by_source"] = {s.name: skip.get(s.name, 0) for s in mix}
    (out / "stream.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    if not keep_raw:
        for path in raw.values():
            path.unlink()
        (out / "raw").rmdir()
    print(f"[imc-data] {meta['tokens']:,} tokens -> {out / 'stream.bin'}", flush=True)
    return meta


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--tokens", type=int, required=True, help="approximate total token budget")
    ap.add_argument("--vocab-size", type=int, default=65536)
    ap.add_argument("--tokenizer-sample-chars", type=int, default=2_000_000_000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--keep-raw", action="store_true", help="keep the downloaded JSONL documents")
    ap.add_argument("--tokenizer", default="", help="reuse this tokenizer.json (continuation streams must share ids)")
    ap.add_argument("--skip", default="", help='JSON {"source": documents} to pass over at the start of each source')
    a = ap.parse_args()
    build(Path(a.out), a.tokens, a.vocab_size, a.tokenizer_sample_chars, a.seed, keep_raw=a.keep_raw,
          tokenizer=Path(a.tokenizer) if a.tokenizer else None, skip=json.loads(a.skip) if a.skip else None)


if __name__ == "__main__":
    main()
