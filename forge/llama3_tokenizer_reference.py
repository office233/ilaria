"""llama3_tokenizer_reference.py — reference ids for the Llama-3 / BitNet
tokenizer, generated with the real Hugging Face `tokenizers` library
(`tokenizers.Tokenizer.from_file`), for cross-checking against
cortex.LoadHFTokenizerJSON + BPETokenizer.Encode in Go
(cortex/tokenizer_llama3_test.go's TestLlama3Equivalence).

Why a separate script from forge/hf_tokenizer.py: that file builds and
exports a small from-scratch GPT-2-style vocab for training Ilaria; this
one only READS an existing tokenizer.json (BitNet-b1.58-2B-4T's, itself
Meta's Llama-3 tokenizer) and reports what the reference implementation
does with it — no training, no export.

    # one JSON-encoded string per line in, one JSON id-array per line out
    # (JSONL rather than raw text lines so a test line can itself contain
    # \\n, \\r, \\t, etc.)
    python forge/llama3_tokenizer_reference.py ids \\
        --tokenizer data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json \\
        --in corpus.jsonl --out ids.jsonl

    # render BitNet-2B4T's chat_template for one system+user turn and
    # report both the rendered string and its ids, as one JSON object
    python forge/llama3_tokenizer_reference.py chat \\
        --tokenizer data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json \\
        --config data/pretrained/bitnet-b1.58-2B-4T/tokenizer_config.json \\
        --system "You are a helpful assistant." --user "What is 2+2?"
"""

from __future__ import annotations

import argparse
import json
import sys


def _load_tokenizer(path: str):
    try:
        from tokenizers import Tokenizer
    except ImportError:
        sys.exit("pip install tokenizers")
    return Tokenizer.from_file(path)


def cmd_ids(args: argparse.Namespace) -> None:
    tok = _load_tokenizer(args.tokenizer)
    with open(args.in_path, encoding="utf-8") as fin, open(args.out, "w", encoding="utf-8", newline="\n") as fout:
        for line in fin:
            line = line.rstrip("\n")
            if line == "":
                continue
            text = json.loads(line)
            ids = tok.encode(text, add_special_tokens=False).ids
            fout.write(json.dumps(ids) + "\n")


def cmd_chat(args: argparse.Namespace) -> None:
    try:
        import jinja2
    except ImportError:
        sys.exit("pip install jinja2")
    tok = _load_tokenizer(args.tokenizer)
    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)
    template = cfg["chat_template"]
    env = jinja2.Environment()
    compiled = env.from_string(template)

    messages = []
    if args.system:
        messages.append({"role": "system", "content": args.system})
    messages.append({"role": "user", "content": args.user})
    rendered = compiled.render(messages=messages, add_generation_prompt=True)
    ids = tok.encode(rendered, add_special_tokens=False).ids
    print(json.dumps({"rendered": rendered, "ids": ids}))


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_ids = sub.add_parser("ids", help="encode one JSON string per input line, one JSON id-array per output line")
    p_ids.add_argument("--tokenizer", required=True)
    p_ids.add_argument("--in", dest="in_path", required=True)
    p_ids.add_argument("--out", required=True)
    p_ids.set_defaults(func=cmd_ids)

    p_chat = sub.add_parser("chat", help="render tokenizer_config.json's chat_template and encode it")
    p_chat.add_argument("--tokenizer", required=True)
    p_chat.add_argument("--config", required=True)
    p_chat.add_argument("--system", default="")
    p_chat.add_argument("--user", required=True)
    p_chat.set_defaults(func=cmd_chat)

    args = ap.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
