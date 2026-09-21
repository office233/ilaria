"""hf_tokenizer.py — train a GPT-2-style byte-level BPE with HuggingFace
`tokenizers` (fast, Rust) and export it in the Nexus tokenizer.json format
that the Go engine loads in byte-level mode (the same mode used for the
DistilGPT-2 import). Also tokenizes JSONL shards into uint16 streams with the
exact layout of cmd/corpus-tokenize (documents separated by <|endoftext|>).

Why: Colab sessions may have no Go toolchain and no access to the repo; this
file plus train_ilaria.py is everything the corpus/tokenizer side needs.

    python forge/hf_tokenizer.py train --input sample.txt --vocab 32000 --out tokenizer.json
    python forge/hf_tokenizer.py encode --tokenizer tokenizer.json --in shard.jsonl --out shard
    python forge/hf_tokenizer.py ids --tokenizer tokenizer.json < lines.txt   # one JSON id list per line
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

EOT = "<|endoftext|>"


def _hf():
    try:
        from tokenizers import Tokenizer, decoders, models, pre_tokenizers, processors, trainers
    except ImportError:
        sys.exit("pip install tokenizers")
    return Tokenizer, decoders, models, pre_tokenizers, processors, trainers


def build_tokenizer():
    Tokenizer, decoders, models, pre_tokenizers, processors, _ = _hf()
    tok = Tokenizer(models.BPE(unk_token=None))
    tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=True)
    tok.decoder = decoders.ByteLevel()
    tok.post_processor = processors.ByteLevel(trim_offsets=False)
    return tok


def train(input_paths, vocab_size: int, out_path: str, min_frequency: int = 2):
    _, _, _, pre_tokenizers, _, trainers = _hf()
    tok = build_tokenizer()
    trainer = trainers.BpeTrainer(
        vocab_size=vocab_size,
        min_frequency=min_frequency,
        special_tokens=[EOT],
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),
        show_progress=False,
    )
    tok.train(list(input_paths), trainer)
    export_nexus(tok, out_path)
    hf_path = os.path.splitext(out_path)[0] + ".hf.json"
    tok.save(hf_path)
    print(f"[hf_tokenizer] vocab {tok.get_vocab_size()} -> {out_path} (+ {hf_path})")
    return tok


def export_nexus(tok, out_path: str) -> None:
    """Write the Nexus byte-level tokenizer.json (vocab + merges + byte_level)."""
    vocab = tok.get_vocab()
    model = json.loads(tok.to_str())["model"]
    merges = []
    for m in model["merges"]:
        if isinstance(m, (list, tuple)):
            a, b = m
        else:
            a, b = m.split(" ", 1)
        merges.append({"a": a, "b": b})
    data = {"vocab_size": len(vocab), "merges": merges, "vocab": vocab, "byte_level": True}
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False)


def load(tok_path: str):
    Tokenizer, *_ = _hf()
    hf_path = os.path.splitext(tok_path)[0] + ".hf.json"
    if os.path.exists(hf_path):
        return Tokenizer.from_file(hf_path)
    # Rebuild from the Nexus JSON (vocab + merges) when only that exists.
    _, _, models, _, _, _ = _hf()
    with open(tok_path, encoding="utf-8") as f:
        data = json.load(f)
    tok = build_tokenizer()
    tok.model = models.BPE(vocab=data["vocab"], merges=[(m["a"], m["b"]) for m in data["merges"]], unk_token=None)
    tok.add_special_tokens([EOT])
    return tok


def encode_jsonl(tok, in_path: str, out_prefix: str, tok_name: str) -> dict:
    eos = tok.token_to_id(EOT)
    vocab = tok.get_vocab_size()
    dtype = np.uint16 if vocab <= 65535 else np.uint32
    docs = tokens = 0
    with open(in_path, encoding="utf-8") as f, open(out_prefix + ".bin", "wb") as out:
        buf = []
        for line in f:
            try:
                text = json.loads(line).get("text", "")
            except ValueError:
                continue
            if not text:
                continue
            ids = tok.encode(text, add_special_tokens=False).ids
            buf.extend(ids)
            buf.append(eos)
            docs += 1
            tokens += len(ids) + 1
            if len(buf) >= 1 << 20:
                np.asarray(buf, dtype=dtype).tofile(out)
                buf = []
        if buf:
            np.asarray(buf, dtype=dtype).tofile(out)
    meta = {"vocab_size": vocab, "eos_id": eos, "dtype": "uint16" if dtype is np.uint16 else "uint32",
            "tokens": tokens, "documents": docs, "tokenizer": tok_name, "byte_level": True}
    with open(out_prefix + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(f"[hf_tokenizer] {in_path}: {docs:,} docs -> {tokens:,} tokens -> {out_prefix}.bin")
    return meta


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--input", action="append", required=True)
    t.add_argument("--vocab", type=int, default=32000)
    t.add_argument("--out", required=True)
    e = sub.add_parser("encode")
    e.add_argument("--tokenizer", required=True)
    e.add_argument("--in", dest="in_path", required=True)
    e.add_argument("--out", required=True)
    i = sub.add_parser("ids")
    i.add_argument("--tokenizer", required=True)
    args = ap.parse_args(argv)
    if args.cmd == "train":
        train(args.input, args.vocab, args.out)
    elif args.cmd == "encode":
        encode_jsonl(load(args.tokenizer), args.in_path, args.out, args.tokenizer)
    else:
        tok = load(args.tokenizer)
        for line in sys.stdin:
            line = line.rstrip("\n")
            print(json.dumps(tok.encode(line, add_special_tokens=False).ids))


if __name__ == "__main__":
    main()
