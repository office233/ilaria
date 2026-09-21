"""ppl.py — measure the perplexity of a trained brain (transformer.nxtf +
tokenizer.json) against an arbitrary UTF-8 text file, on the PyTorch engine.

Definition (must match cmd/nxtf-ppl/main.go exactly):
  1. Tokenize the whole file. Documents are separated by blank lines (one or
     more empty lines); each document is encoded independently and an EOS id
     is appended after it — exactly like
     forge/hf_tokenizer.py:encode_jsonl does per JSONL record.
  2. Concatenate every document's [ids..., eos] into one token stream.
  3. Walk that stream in non-overlapping windows of --ctx tokens (default:
     the model's max_seq_len from the nxtf header). Each window of length w
     feeds tokens [0:w-1] through the model and scores them against targets
     [1:w] (teacher forcing) — the window's first token has no prediction. A
     final window shorter than 2 tokens is dropped.
  4. mean_nll is the mean over ALL predicted tokens in the file;
     perplexity = exp(mean_nll).
  5. --per-doc additionally attributes each predicted token's NLL back to the
     document that contains it (a window may straddle a document boundary —
     attribution is by target token, not by window) and reports
     per-document tokens/mean_nll/perplexity.

    python forge/ppl.py --brain data/forge/brain-a --text some.txt
    python forge/ppl.py --brain <fixture-dir-with-transformer.nxtf> --ids ids.txt

--ids/--text are mutually exclusive: --ids reads a whitespace-separated list
of integer token ids directly (bypassing the tokenizer entirely — the one
path fixtures without a tokenizer.json can use) and treats the whole file as
a single document.

Runs on CUDA in float32 when available (no autocast/bf16 anywhere in this
file) so its mean_nll matches the Go CPU float32 path to ~1e-3.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nxtf import load_nxtf  # noqa: E402
import hf_tokenizer  # noqa: E402


def split_documents(text: str) -> list[str]:
    """Split text into documents separated by blank lines (one or more
    consecutive empty-after-strip lines). Mirrors cmd/nxtf-ppl/main.go's
    splitDocuments exactly."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    docs: list[str] = []
    cur: list[str] = []
    for line in text.split("\n"):
        if line.strip() == "":
            if cur:
                docs.append("\n".join(cur))
                cur = []
        else:
            cur.append(line)
    if cur:
        docs.append("\n".join(cur))
    return docs


def build_ids_from_text(tok, text: str) -> tuple[list[int], list[tuple[int, int]]]:
    """Tokenize each document and append the EOS id after it, recording the
    [start,end) span of every document in the concatenated token stream."""
    docs = split_documents(text)
    eos = tok.token_to_id("<|endoftext|>")

    ids: list[int] = []
    spans: list[tuple[int, int]] = []
    for doc in docs:
        start = len(ids)
        ids.extend(tok.encode(doc, add_special_tokens=False).ids)
        ids.append(eos)
        spans.append((start, len(ids)))
    return ids, spans


def build_ids_from_ids_file(path: str) -> tuple[list[int], list[tuple[int, int]]]:
    """Read a whitespace-separated list of integer token ids and treat the
    whole file as a single document. This is the path the tiny dev fixtures
    (no tokenizer.json) use."""
    with open(path, encoding="utf-8") as f:
        fields = f.read().split()
    ids = [int(x) for x in fields]
    if not ids:
        return ids, []
    return ids, [(0, len(ids))]


def compute_perplexity(
    ids: list[int],
    doc_spans: list[tuple[int, int]],
    ctx: int,
    model,
    device: torch.device,
) -> dict:
    """The windowing/NLL bookkeeping. Mirrors cmd/nxtf-ppl/main.go's
    computePerplexity: forward() (here, one no_grad model call per window)
    scores a window's input tokens, and the predicted range is split into
    contiguous per-document sub-ranges so a window that straddles a document
    boundary attributes each token's NLL to the document that owns it."""
    n = len(ids)
    doc_sum_nll = [0.0] * len(doc_spans)
    doc_tokens = [0] * len(doc_spans)

    total_nll = 0.0
    total_tokens = 0
    windows = 0
    doc_ptr = 0

    with torch.no_grad():
        start = 0
        while start < n:
            end = min(start + ctx, n)
            w = end - start
            if w < 2:
                break  # drop a final partial window shorter than 2 tokens
            window = ids[start:end]
            inp = torch.tensor(window[:-1], dtype=torch.long, device=device)[None, :]
            target = window[1:]
            logits = model(inp)[0].float()  # [w-1, V], force fp32 (no autocast used anyway)
            log_probs = F.log_softmax(logits, dim=-1)
            windows += 1

            if not doc_spans:
                tgt = torch.tensor(target, dtype=torch.long, device=device)
                nll = -log_probs[torch.arange(w - 1, device=device), tgt]
                total_nll += float(nll.sum().item())
                total_tokens += w - 1
                start += ctx
                continue

            # Walk the predicted range [start+1, end) in contiguous
            # per-document sub-ranges (same algorithm as the Go tool).
            gpos = start + 1
            while gpos < end and doc_ptr < len(doc_spans):
                while doc_ptr < len(doc_spans) - 1 and gpos >= doc_spans[doc_ptr][1]:
                    doc_ptr += 1
                seg_end = min(end, doc_spans[doc_ptr][1])
                seg_len = seg_end - gpos
                if seg_len <= 0:
                    break
                offset = gpos - (start + 1)  # row index into log_probs/target for this window
                seg_target = torch.tensor(target[offset:offset + seg_len], dtype=torch.long, device=device)
                seg_logp = log_probs[offset:offset + seg_len]
                seg_nll = -seg_logp[torch.arange(seg_len, device=device), seg_target]
                seg_sum = float(seg_nll.sum().item())

                total_nll += seg_sum
                total_tokens += seg_len
                doc_sum_nll[doc_ptr] += seg_sum
                doc_tokens[doc_ptr] += seg_len

                gpos = seg_end

            start += ctx

    result: dict = {"tokens": total_tokens, "windows": windows, "mean_nll": 0.0, "perplexity": 0.0}
    if total_tokens > 0:
        mean_nll = total_nll / total_tokens
        result["mean_nll"] = mean_nll
        result["perplexity"] = math.exp(mean_nll)

    per_doc = []
    for i in range(len(doc_spans)):
        if doc_tokens[i] == 0:
            continue
        mean = doc_sum_nll[i] / doc_tokens[i]
        per_doc.append({"doc": i, "tokens": doc_tokens[i], "mean_nll": mean, "perplexity": math.exp(mean)})
    result["per_doc"] = per_doc
    return result


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--brain", required=True, help="Dir with transformer.nxtf (+ tokenizer.json unless --ids)")
    ap.add_argument("--text", help="UTF-8 text file to score")
    ap.add_argument("--ids", help="Whitespace-separated token-id file (bypasses the tokenizer; single document)")
    ap.add_argument("--ctx", type=int, default=0, help="Window size in tokens (default: model's max_seq_len)")
    ap.add_argument("--per-doc", action="store_true", help="Also print per-document perplexity")
    ap.add_argument("--json", help="Write the full result as JSON to this path")
    args = ap.parse_args(argv)

    if (args.text is None) == (args.ids is None):
        sys.exit("error: exactly one of --text or --ids is required")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = load_nxtf(os.path.join(args.brain, "transformer.nxtf"), device=str(device))
    model.eval()
    # load_nxtf builds parameters as float32 and only copies float32 data in
    # (nxtf.py:load_nxtf) — assert instead of silently casting, so a future
    # change there can't quietly put us on bf16/fp16.
    assert next(model.parameters()).dtype == torch.float32, "model must be float32 for Go-parity NLL"

    ctx = args.ctx if args.ctx and args.ctx > 0 else model.cfg.max_seq_len
    if ctx > model.cfg.max_seq_len:
        print(f"[ppl] warning: --ctx {ctx} exceeds model max_seq_len {model.cfg.max_seq_len}, clamping", file=sys.stderr)
        ctx = model.cfg.max_seq_len
    if ctx < 2:
        sys.exit(f"error: ctx must be >= 2 (got {ctx})")

    if args.ids:
        ids, spans = build_ids_from_ids_file(args.ids)
    else:
        tok = hf_tokenizer.load(os.path.join(args.brain, "tokenizer.json"))
        with open(args.text, encoding="utf-8") as f:
            text = f.read()
        ids, spans = build_ids_from_text(tok, text)

    if len(ids) < 2:
        sys.exit(f"error: fewer than 2 tokens ({len(ids)}) — nothing to score")

    result = compute_perplexity(ids, spans, ctx, model, device)

    print(f"[ppl] tokens={result['tokens']} windows={result['windows']} "
          f"mean_nll={result['mean_nll']:.6f} ppl={result['perplexity']:.6f}")
    if args.per_doc:
        for d in result["per_doc"]:
            print(f"[ppl] doc={d['doc']} tokens={d['tokens']} mean_nll={d['mean_nll']:.6f} ppl={d['perplexity']:.6f}")

    if args.json:
        out = dict(result)
        if not args.per_doc:
            out.pop("per_doc", None)
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2)


if __name__ == "__main__":
    main()
