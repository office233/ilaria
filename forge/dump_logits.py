"""dump_logits.py — Python-side reference dump for the Go<->PyTorch
equivalence check on a REAL trained brain (see
cortex/forge_brain_equivalence_test.go).

This is the real-brain sibling of make_fixture.py: instead of a tiny
random model built in-process, it loads an already-exported brain
directory with forge/nxtf.py:load_nxtf (the SAME loader everything else
uses — this script does not reimplement the NXTF2BIN format), tokenizes
a fixed set of short Romanian/English prompts with the SAME byte-level
BPE tokenizer the Go engine loads (forge/hf_tokenizer.py:load, reading
<brain>/tokenizer.json), runs the model in float32 on CPU (deterministic
given fixed weights + fixed input — no dropout, no sampling except a
greedy argmax), and writes one JSON file the Go test consumes.

Per prompt, the JSON carries: the token ids, the full logits vector at
the LAST position, the argmax at EVERY position, and an 8-token greedy
continuation (mirrors cortex.MiniTransformer.GenerateFast(ids, 8,
0.0001, 1), which is greedy because top-k=1 leaves only one candidate).

Usage:
    python forge/dump_logits.py --brain data/forge/brain-a \
        --out data/forge/brain-a/logits_ref.json

    # Override the default 6-prompt list (one prompt per non-empty,
    # non-'#' line):
    python forge/dump_logits.py --brain <dir> --out <dir>/logits_ref.json \
        --prompts-file my_prompts.txt

    # A brain dir with no tokenizer.json (e.g. the tiny synthetic
    # fixture used by forge/make_fixture.py) has nothing to tokenize
    # text with. --ids-file bypasses tokenization entirely and feeds
    # raw token-id lists straight to the model:
    python forge/dump_logits.py --brain <fixture_dir> \
        --out <fixture_dir>/logits_ref.json --ids-file ids.json
    # ids.json: {"prompts": [{"name": "fixture", "ids": [2, 5, 11, 7, 4, 9, 13, 3, 6]}]}
    # (an entry may also carry "text" for record-keeping; the Go test
    # only re-tokenizes and checks entries that have non-empty "text".)
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nxtf import load_nxtf  # noqa: E402
import hf_tokenizer  # noqa: E402

# Fixed default prompt list: 3 Romanian, 3 English, all short so the
# reference dump stays small and the greedy continuation stays cheap.
DEFAULT_PROMPTS = [
    ("ro_1", "Capitala României este"),
    ("ro_2", "Astăzi este o zi frumoasă și"),
    ("ro_3", "Inteligența artificială poate"),
    ("en_1", "The capital of France is"),
    ("en_2", "Once upon a time there was"),
    ("en_3", "Artificial intelligence can"),
]

GREEDY_CONTINUATION_LEN = 8


def _round(xs) -> list[float]:
    """Round a tensor's values to 6 decimals for a compact JSON dump."""
    return [round(float(x), 6) for x in xs]


def _load_prompts_file(path: str) -> list[tuple[str, str]]:
    prompts = []
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            prompts.append((f"p{i}", line))
    if not prompts:
        sys.exit(f"--prompts-file {path} contained no usable prompt lines")
    return prompts


def _load_ids_file(path: str) -> list[tuple[str, str | None, list[int]]]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    entries = data.get("prompts", [])
    if not entries:
        sys.exit(f"--ids-file {path} has an empty/missing 'prompts' list")
    return [(p["name"], p.get("text"), list(p["ids"])) for p in entries]


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--brain", required=True, help="Dir with transformer.nxtf (+ tokenizer.json unless --ids-file)")
    ap.add_argument("--out", required=True, help="Output JSON path (e.g. <brain>/logits_ref.json)")
    ap.add_argument("--prompts-file", help="Override the default prompts: one prompt per non-empty, non-'#' line")
    ap.add_argument(
        "--ids-file",
        help="Bypass tokenization entirely: JSON {'prompts': [{'name', 'ids' [, 'text']}]}. "
        "For brains with no tokenizer.json, e.g. the tiny test fixture.",
    )
    args = ap.parse_args(argv)

    nxtf_path = os.path.join(args.brain, "transformer.nxtf")
    if not os.path.exists(nxtf_path):
        sys.exit(f"no transformer.nxtf in {args.brain}")
    model = load_nxtf(nxtf_path, device="cpu").eval()
    eos_id = model.cfg.eos_token_id

    entries: list[tuple[str, str | None, list[int]]]
    if args.ids_file:
        entries = _load_ids_file(args.ids_file)
    else:
        tok_path = os.path.join(args.brain, "tokenizer.json")
        if not os.path.exists(tok_path):
            sys.exit(
                f"no tokenizer.json in {args.brain} — pass --ids-file for a brain with no "
                "tokenizer (e.g. the tiny fixture)"
            )
        with open(tok_path, encoding="utf-8") as f:
            tok_meta = json.load(f)
        if not tok_meta.get("byte_level"):
            sys.exit(
                "dump_logits.py only supports byte-level tokenizers "
                "(tokenizer.json 'byte_level': true) — char-level Nexus "
                "tokenizers aren't wired up here"
            )
        tok = hf_tokenizer.load(tok_path)
        prompts = _load_prompts_file(args.prompts_file) if args.prompts_file else DEFAULT_PROMPTS
        entries = []
        for name, text in prompts:
            ids = tok.encode(text, add_special_tokens=False).ids
            entries.append((name, text, ids))

    results = []
    with torch.no_grad():
        for name, text, ids in entries:
            if not ids:
                sys.exit(f"prompt {name!r} tokenized to zero ids")
            logits = model(torch.tensor(ids, dtype=torch.long)[None, :])[0]  # [T, V]
            argmax_all = [int(v) for v in torch.argmax(logits, dim=-1).tolist()]
            continuation = model.generate_greedy(list(ids), GREEDY_CONTINUATION_LEN)[len(ids):]
            results.append(
                {
                    "name": name,
                    "text": text,
                    "ids": list(ids),
                    "logits_last": _round(logits[-1].tolist()),
                    "argmax_all": argmax_all,
                    "greedy_continuation": [int(v) for v in continuation],
                }
            )
            print(f"[dump_logits] {name}: {len(ids)} ids -> argmax_last={argmax_all[-1]} "
                  f"continuation={continuation}")

    out = {
        "brain_dir": os.path.abspath(args.brain),
        "vocab_size": model.cfg.vocab_size,
        "eos_token_id": eos_id,
        "prompts": results,
    }
    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[dump_logits] {len(results)} prompts -> {args.out}")


if __name__ == "__main__":
    main()
