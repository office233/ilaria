"""imc_data.py — build the English token stream for from-scratch IMC training.

    python -m forge.imc_data --out /content/imc-data --tokens 1200000000

Steps, all deterministic for a given --seed:
  1. stream each source from Hugging Face until its share of the character
     budget is collected (documents are kept whole);
  2. train a byte-level BPE tokenizer (default 65,536 tokens) on a sample of
     the collected documents, in proportion to the mix;
  3. shuffle documents across sources, tokenize, append EOS after each one,
     and write <out>/stream.bin (uint16) + stream.json, the format
     forge/train_ilaria.py --data <out>/stream reads.

Gated sources read the Hugging Face token from the HF_TOKEN environment
variable (on Colab: google.colab.userdata), never from arguments or files.
"""

from __future__ import annotations

import argparse
import hashlib
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


# English stage-1 style mix (SmolLM3 stage 1 is 85% web / 12% code / 3% math;
# math is raised here because small models learn it late).
MIX = (
    Source("fineweb-edu", "HuggingFaceFW/fineweb-edu", "sample-100BT", 0.40),
    Source("dclm", "mlfoundations/dclm-baseline-1.0", None, 0.40),
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


def collect(src: Source, char_budget: int, stream: Callable[[Source], Iterable[str]]) -> list[str]:
    """Whole documents from the start of the stream until char_budget is reached."""
    docs, chars = [], 0
    for text in stream(src):
        if chars >= char_budget:
            break
        docs.append(text)
        chars += len(text)
    if chars < char_budget:
        raise ValueError(f"{src.name}: source exhausted at {chars:,} of {char_budget:,} characters")
    return docs


def train_tokenizer(corpus: dict[str, list[str]], mix: Iterable[Source], vocab_size: int,
                    sample_chars: int, seed: int):
    from tokenizers import Tokenizer, decoders, models, pre_tokenizers, processors, trainers

    rng = random.Random(seed)
    sample: list[str] = []
    for src in mix:
        docs = list(corpus[src.name])
        rng.shuffle(docs)
        budget, used = int(sample_chars * src.share), 0
        for d in docs:
            if used >= budget:
                break
            sample.append(d)
            used += len(d)
    rng.shuffle(sample)
    tok = Tokenizer(models.BPE(byte_fallback=False))
    tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    tok.decoder = decoders.ByteLevel()
    tok.post_processor = processors.ByteLevel(trim_offsets=False)
    trainer = trainers.BpeTrainer(vocab_size=vocab_size, special_tokens=SPECIAL_TOKENS,
                                  initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),
                                  show_progress=False)
    tok.train_from_iterator(sample, trainer=trainer)
    return tok


def write_stream(corpus: dict[str, list[str]], tok, out: Path, seed: int, batch: int = 4096) -> dict:
    """Shuffle documents across sources and write uint16 tokens with EOS after each."""
    vocab = tok.get_vocab_size()
    if vocab > 65536:
        raise ValueError("uint16 stream needs a vocabulary of at most 65,536 tokens")
    eos = tok.token_to_id("<|endoftext|>")
    order = [(name, i) for name, docs in corpus.items() for i in range(len(docs))]
    random.Random(seed).shuffle(order)
    counts = {name: 0 for name in corpus}
    total = 0
    digest = hashlib.sha256()
    with open(out / "stream.bin", "wb") as f:
        for start in range(0, len(order), batch):
            chunk = order[start:start + batch]
            encoded = tok.encode_batch([corpus[n][i] for n, i in chunk])
            for (name, _), enc in zip(chunk, encoded):
                ids = np.asarray(enc.ids + [eos], dtype="<u2")
                data = ids.tobytes()
                f.write(data)
                digest.update(data)
                counts[name] += len(ids)
                total += len(ids)
    meta = {"dtype": "uint16", "vocab_size": vocab, "eos_id": eos, "tokens": total,
            "tokenizer": str(out / "tokenizer.json"), "sha256": digest.hexdigest(),
            "tokens_by_source": counts, "documents": len(order), "seed": seed}
    (out / "stream.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def build(out: Path, tokens: int, vocab_size: int, tokenizer_sample_chars: int, seed: int,
          mix: Iterable[Source] = MIX, stream: Callable[[Source], Iterable[str]] = hf_stream) -> dict:
    mix = list(mix)
    check_mix(mix)
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        raise FileExistsError(f"{out} is not empty")
    corpus = {}
    for src in mix:
        budget = int(tokens * src.share * src.chars_per_token)
        corpus[src.name] = collect(src, budget, stream)
        print(f"[imc-data] {src.name}: {len(corpus[src.name]):,} documents, {budget:,} characters", flush=True)
    tok = train_tokenizer(corpus, mix, vocab_size, tokenizer_sample_chars, seed)
    tok.save(str(out / "tokenizer.json"))
    meta = write_stream(corpus, tok, out, seed)
    meta["mix"] = {s.name: {"dataset": s.dataset, "config": s.config, "share": s.share} for s in mix}
    (out / "stream.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"[imc-data] {meta['tokens']:,} tokens -> {out / 'stream.bin'}", flush=True)
    return meta


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--tokens", type=int, required=True, help="approximate total token budget")
    ap.add_argument("--vocab-size", type=int, default=65536)
    ap.add_argument("--tokenizer-sample-chars", type=int, default=1_000_000_000)
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()
    build(Path(a.out), a.tokens, a.vocab_size, a.tokenizer_sample_chars, a.seed)


if __name__ == "__main__":
    main()
