"""Tool-loop evaluator for bench/swypik-v1 (and the frozen v7 probes).

Runs each task through the same CALL/Tool loop as cortex.Runner
(cortex/toolloop.go): the model either answers or writes one
"CALL <tool>: <args>" line; calc/convert/time are executed for real with
Python ports of cortex/calc.go and cortex/tools.go, the result is fed back as a
"Tool: ..." turn, and generation continues until a plain answer. Automatic
scoring mirrors cmd/ilaria-chat -eval (first tool tried, successful
execution, case-insensitive expect_substring) plus must_not_contain.

Rubrics are never scored here. `export_blind` writes every answer for every
model under shuffled anonymous ids with the model key in a separate file, so a
human or fixed judge grades without knowing which model answered.

No model code is imported at module import time; `load_adapter_generator`
needs Colab (CUDA, transformers, lora_bitlinear, forge.train_tools).
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import random
import re
from collections import defaultdict
from decimal import Decimal, getcontext
from fractions import Fraction
from pathlib import Path

EOT = "<|eot_id|>"
REFUSAL = "(no more tool calls allowed; answer now)"
SCHEMA = 1


# ── calc: port of cortex/calc.go (same grammar, same output format) ──

class CalcError(ValueError):
    pass


class _Calc:
    def __init__(self, src):
        self.s, self.i = src, 0

    def peek(self):
        self.i += len(self.s[self.i:]) - len(self.s[self.i:].lstrip())
        return self.s[self.i] if self.i < len(self.s) else ""

    def expr(self):
        v = self.term()
        while self.peek() and self.peek() in "+-":
            op = self.s[self.i]
            self.i += 1
            v = v + self.term() if op == "+" else v - self.term()
        return v

    def term(self):
        v = self.factor()
        while self.peek() and self.peek() in "*/":
            op = self.s[self.i]
            self.i += 1
            rhs = self.factor()
            if op == "/":
                if rhs == 0:
                    raise CalcError("division by zero")
                v = v / rhs
            else:
                v = v * rhs
        return v

    def factor(self):
        c = self.peek()
        if c == "+":
            self.i += 1
            return self.factor()
        if c == "-":
            self.i += 1
            return -self.factor()
        return self.power()

    def power(self):
        v = self.primary()
        if self.peek() == "^":
            self.i += 1
            e = self.factor()
            if isinstance(e, Fraction) and e.denominator == 1 and abs(e) <= 10000:
                if v == 0 and e < 0:
                    raise CalcError("division by zero")
                return Fraction(v) ** int(e)
            b, x = float(v), float(e)
            if b < 0 and x != int(x):
                raise CalcError("negative base with a fractional exponent is not a real number")
            try:
                return Fraction(b ** x)
            except (OverflowError, ValueError):
                raise CalcError("power result overflows")
        return v

    def primary(self):
        c = self.peek()
        if not c:
            raise CalcError("unexpected end of expression")
        if c == "(":
            self.i += 1
            v = self.expr()
            if self.peek() != ")":
                raise CalcError(f"expected ')' at position {self.i}")
            self.i += 1
            return v
        if self.s[self.i:self.i + 4].lower() == "sqrt":
            self.i += 4
            if self.peek() != "(":
                raise CalcError("expected '(' after sqrt")
            self.i += 1
            v = self.expr()
            if self.peek() != ")":
                raise CalcError("expected ')' to close sqrt(")
            self.i += 1
            if v < 0:
                raise CalcError("sqrt of a negative number is not real")
            getcontext().prec = 80
            return Fraction((Decimal(v.numerator) / Decimal(v.denominator)).sqrt())
        m = re.match(r"\d*\.?\d*", self.s[self.i:])
        text = m.group(0)
        if not text or text == "." or not any(ch.isdigit() for ch in text):
            raise CalcError(f"unexpected character {c!r} at position {self.i}")
        self.i += len(text)
        return Fraction(Decimal(text))


def format_number(v: Fraction) -> str:
    if v.denominator == 1:
        return str(v.numerator)
    getcontext().prec = 80
    q = (Decimal(v.numerator) / Decimal(v.denominator)).quantize(Decimal("1e-10"))
    s = format(q, "f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return "0" if s in ("", "-", "-0") else s


def calc(expr: str) -> str:
    if not expr.strip():
        raise CalcError("empty expression")
    p = _Calc(expr)
    v = p.expr()
    if p.peek():
        raise CalcError(f"unexpected input at position {p.i}: {p.s[p.i:]!r}")
    return format_number(v)


# ── convert: port of cortex/tools.go UnitConvertTool ──

_UNIT = r"(km|mi|miles?|kilometers?|kg|lbs?|pounds?|kilograms?|c|f|celsius|fahrenheit|m|ft|feet|meters?)"
_CONVERT = re.compile(r"(?i)([-+]?\d+(?:\.\d+)?)\s*" + _UNIT + r"\b.*?\b(?:to|in|en|spre)\b\s*" + _UNIT + r"\b")
_NORM = {"kilometer": "km", "kilometers": "km", "mile": "mi", "miles": "mi", "kilogram": "kg",
         "kilograms": "kg", "lb": "lb", "lbs": "lb", "pound": "lb", "pounds": "lb", "celsius": "c",
         "fahrenheit": "f", "meter": "m", "meters": "m", "ft": "ft", "feet": "ft"}
_FACTORS = {("km", "mi"): lambda v: v * 0.621371, ("mi", "km"): lambda v: v * 1.609344,
            ("m", "ft"): lambda v: v * 3.28084, ("ft", "m"): lambda v: v * 0.3048,
            ("km", "m"): lambda v: v * 1000, ("m", "km"): lambda v: v / 1000,
            ("kg", "lb"): lambda v: v * 2.20462, ("lb", "kg"): lambda v: v * 0.453592,
            ("c", "f"): lambda v: v * 9 / 5 + 32, ("f", "c"): lambda v: (v - 32) * 5 / 9}


def convert(args: str) -> str:
    m = _CONVERT.search(args)
    if m:
        v = float(m.group(1))
        a, b = (_NORM.get(u.lower(), u.lower()) for u in (m.group(2), m.group(3)))
        if a == b:
            return f"{v:.4g} {b}"
        if (a, b) in _FACTORS:
            return f"{_FACTORS[(a, b)](v):.4g} {b}"
    raise ValueError(f'could not parse a conversion from {args!r} (expected e.g. "72 miles to kilometers")')


def time_tool(_args: str, now: dt.datetime | None = None) -> str:
    now = now or dt.datetime.now().astimezone()
    utc = now.astimezone(dt.timezone.utc)
    fmt = "%A, {d} %B %Y %H:%M:%S"
    return "local: {} {} | utc: {} UTC".format(now.strftime(fmt.format(d=now.day)), now.strftime("%Z"),
                                               utc.strftime(fmt.format(d=utc.day)))


TOOLS = {"calc": calc, "convert": convert, "time": time_tool}


def parse_call(line: str):
    line = line.strip()
    if not line.startswith("CALL "):
        raise ValueError(f"not a CALL line: {line!r}")
    rest = line[5:]
    if ":" not in rest:
        raise ValueError(f"missing ':' after tool name in {line!r}")
    name, args = rest.split(":", 1)
    if not name.strip():
        raise ValueError(f"empty tool name in {line!r}")
    return name.strip(), args.strip()


# ── tool loop: mirrors cortex.Runner.UserTurn ──

def cut_segment(text: str):
    """Trim a raw generation the way Runner.generateSegment does."""
    text = text.replace(EOT, "")
    stripped = text.strip()
    if stripped.startswith("CALL ") and "\n" in stripped:
        return stripped.split("\n", 1)[0].strip(), True
    return stripped, stripped.startswith("CALL ")


def run_turn(generate, system: str, prompt: str, max_calls: int = 3, tools=None):
    """generate(messages) -> raw text of the next assistant segment.

    messages is the transcript so far as [{"role", "content"}], ending right
    before the "Assistant: " header the generator must append itself.
    """
    tools = TOOLS if tools is None else tools
    messages = [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
    calls, log, forced = 0, [], False
    for it in range(max_calls * 3 + 6 + 1):
        if it >= max_calls * 3 + 6:
            forced = True
        text, is_call = cut_segment(generate(messages))
        messages.append({"role": "assistant", "content": text})
        if forced or not is_call:
            return {"answer": text, "calls": calls, "tool_calls": log, "messages": messages}
        try:
            name, args = parse_call(text)
        except ValueError as err:
            result = "error: " + str(err)
            log.append({"tool": "", "args": text, "result": result, "ok": False})
        else:
            if calls >= max_calls:
                forced, result = True, REFUSAL
                log.append({"tool": name, "args": args, "result": result, "ok": False})
            elif name not in tools:
                result = f"error: unknown tool {name}; available: {', '.join(sorted(tools))}"
                log.append({"tool": name, "args": args, "result": result, "ok": False})
            else:
                calls += 1
                try:
                    result, ok = tools[name](args), True
                except Exception as err:  # tool errors are model-visible failures
                    result, ok = "error: " + str(err), False
                log.append({"tool": name, "args": args, "result": result, "ok": ok})
        messages.append({"role": "tool", "content": result})
    raise AssertionError("unreachable")


# ── scoring: mirrors cmd/ilaria-chat runEval, plus must_not_contain ──

def score(task: dict, turn: dict | None) -> dict:
    expected = task.get("expected_tool", "")
    if turn is None:
        return {"error": True, "tool_ok": False, "tool_executed": False, "false_call": False,
                "answer_ok": False if task.get("expect_substring") else None, "forbidden_ok": False,
                "auto_pass": False}
    calls = turn["tool_calls"]
    first = (calls[0]["tool"] or "(unparsed)") if calls else ""
    tool_ok = (not calls) if not expected else first == expected
    executed = bool(expected) and any(c["tool"] == expected and c["ok"] for c in calls)
    answer = turn["answer"].lower()
    sub = task.get("expect_substring", "")
    answer_ok = (sub.lower() in answer) if sub else None
    forbidden = [w for w in task.get("must_not_contain", []) if w.lower() in answer]
    auto = tool_ok and answer_ok is not False and not forbidden and (executed or not expected)
    return {"error": False, "first_tool": first, "tool_ok": tool_ok, "tool_executed": executed,
            "false_call": (not expected) and bool(calls), "answer_ok": answer_ok,
            "forbidden_hits": forbidden, "forbidden_ok": not forbidden, "auto_pass": auto}


def summarize(tasks: list[dict], scores: list[dict]) -> dict:
    by_cat = defaultdict(lambda: {"n": 0, "auto_pass": 0})
    tot = {"tool_needed": 0, "tool_ok": 0, "tool_executed": 0, "no_tool": 0, "false_calls": 0,
           "substring": 0, "substring_ok": 0, "forbidden_checked": 0, "forbidden_ok": 0, "errors": 0}
    for t, s in zip(tasks, scores):
        c = by_cat[t.get("category", "probe")]
        c["n"] += 1
        c["auto_pass"] += s["auto_pass"]
        tot["errors"] += s["error"]
        if t.get("expected_tool"):
            tot["tool_needed"] += 1
            tot["tool_ok"] += s["tool_ok"]
            tot["tool_executed"] += s["tool_executed"]
        else:
            tot["no_tool"] += 1
            tot["false_calls"] += s["false_call"] or s["error"]
        if t.get("expect_substring"):
            tot["substring"] += 1
            tot["substring_ok"] += bool(s["answer_ok"])
        if t.get("must_not_contain"):
            tot["forbidden_checked"] += 1
            tot["forbidden_ok"] += s["forbidden_ok"]
    return {"totals": tot, "by_category": dict(sorted(by_cat.items()))}


def evaluate(generate, system: str, tasks: list[dict], max_calls: int = 3, log=print) -> dict:
    results = []
    for task in tasks:
        try:
            turn = run_turn(generate, system, task["prompt"], max_calls)
        except Exception as err:  # inference failures stay in the denominator
            turn, error = None, f"{type(err).__name__}: {err}"
        else:
            error = None
        s = score(task, turn)
        row = {"id": task["id"], "category": task.get("category", "probe"), "prompt": task["prompt"],
               "answer": turn["answer"] if turn else None, "tool_calls": turn["tool_calls"] if turn else [],
               "score": s, "inference_error": error}
        results.append(row)
        if log:
            log(json.dumps({k: row[k] for k in ("id", "answer", "tool_calls")} | {"auto_pass": s["auto_pass"]},
                           ensure_ascii=False))
    return {"schema": SCHEMA, "system_sha256": hashlib.sha256(system.encode()).hexdigest(),
            "max_calls": max_calls, "summary": summarize(tasks, [r["score"] for r in results]),
            "results": results}


# ── blind rubric export / merge ──

def export_blind(reports: dict[str, dict], tasks: list[dict], seed: int = 0):
    """reports: model name -> evaluate() output. Returns (sheet, key)."""
    rubric = {t["id"]: t.get("rubric", "") for t in tasks}
    prompts = {t["id"]: t["prompt"] for t in tasks}
    items = [(m, r) for m, rep in reports.items() for r in rep["results"]]
    rng = random.Random(seed)
    rng.shuffle(items)
    sheet, key = [], {}
    for n, (model, r) in enumerate(items):
        blind = f"b{n:04d}"
        key[blind] = {"model": model, "id": r["id"]}
        sheet.append({"blind_id": blind, "task_id": r["id"], "prompt": prompts[r["id"]],
                      "rubric": rubric[r["id"]], "answer": r["answer"],
                      "tool_calls": [f"CALL {c['tool']}: {c['args']} -> {c['result']}" for c in r["tool_calls"]],
                      "pass": None, "note": ""})
    return sheet, key


def merge_rubric(sheet: list[dict], key: dict, tasks: list[dict]) -> dict:
    cat = {t["id"]: t.get("category", "probe") for t in tasks}
    out = defaultdict(lambda: defaultdict(lambda: {"graded": 0, "pass": 0}))
    missing = [row["blind_id"] for row in sheet if row["pass"] is None]
    for row in sheet:
        if row["pass"] is None:
            continue
        k = key[row["blind_id"]]
        cell = out[k["model"]][cat[k["id"]]]
        cell["graded"] += 1
        cell["pass"] += bool(row["pass"])
    return {"ungraded": missing, "by_model": {m: dict(v) for m, v in out.items()}}


def read_jsonl(path) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]


def write_new_json(path, value) -> None:
    with Path(path).open("x", encoding="utf-8", newline="\n") as f:
        json.dump(value, f, ensure_ascii=False, indent=2, allow_nan=False)
        f.write("\n")


# ── Colab generator (lazy imports) ──

def encode_context(tokenizer, messages) -> list[int]:
    """Same token layout as forge.tool_data.encode_trajectory, plus the open header."""
    ids = []
    for m in messages:
        content = m["content"].strip() + EOT
        if m["role"] == "assistant":
            ids += tokenizer.encode("Assistant: ", add_special_tokens=False)
            ids += tokenizer.encode(content, add_special_tokens=False)
        else:
            ids += tokenizer.encode(m["role"].capitalize() + ": " + content, add_special_tokens=False)
    return ids + tokenizer.encode("Assistant: ", add_special_tokens=False)


def load_adapter_generator(model_dir, prefix, max_new_tokens=256, rank=16, alpha=32):
    """Returns (generate, close, adapter_info). prefix=None evaluates the base model."""
    import gc
    import torch
    from transformers import AutoTokenizer
    import lora_bitlinear as lb
    from forge.train_tools import initialize_adapter

    tok = AutoTokenizer.from_pretrained(str(model_dir), local_files_only=True)
    model = lb.load_frozen_base("offline", str(model_dir)).to("cuda")
    info = None
    if prefix is not None:
        lb.inject_lora(model, r=rank, alpha=alpha, dropout=0)
        model.to("cuda")
        info = initialize_adapter(model, str(prefix), lb, "offline", rank, alpha)
    model.eval()
    stop = tok.encode(EOT, add_special_tokens=False)
    if len(stop) != 1 or tok.eos_token_id is None:
        raise ValueError("Invalid inference EOT/EOS contract")
    stops = sorted(set(stop + [tok.eos_token_id]))

    def generate(messages):
        ids = torch.tensor([encode_context(tok, messages)], device="cuda")
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
            out = model.generate(ids, attention_mask=torch.ones_like(ids), do_sample=False,
                                 max_new_tokens=max_new_tokens, pad_token_id=tok.eos_token_id, eos_token_id=stops)
        return tok.decode(out[0, ids.shape[1]:], skip_special_tokens=True)

    def close():
        nonlocal model
        del model
        gc.collect()
        torch.cuda.empty_cache()

    return generate, close, info


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--adapter", action="append", default=[], metavar="NAME=PREFIX",
                    help="repeatable; PREFIX without .json/.safetensors; NAME=base evaluates the base model")
    ap.add_argument("--tasks", required=True)
    ap.add_argument("--system-file", required=True, help="exact serving system prompt")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--max-calls", type=int, default=3)
    ap.add_argument("--max-new-tokens", type=int, default=256)
    a = ap.parse_args(argv)
    tasks = read_jsonl(a.tasks)
    system = Path(a.system_file).read_text(encoding="utf-8").replace("\r\n", "\n").strip()
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    reports = {}
    for spec in a.adapter:
        name, _, prefix = spec.partition("=")
        target = out / f"{name}.json"
        if target.exists():
            raise FileExistsError(f"{target} exists; results are never overwritten")
        gen, close, info = load_adapter_generator(a.model_dir, None if prefix in ("", "base") else prefix,
                                                  a.max_new_tokens)
        try:
            rep = evaluate(gen, system, tasks, a.max_calls)
        finally:
            close()
        rep.update({"model": name, "adapter": info, "tasks_sha256": hashlib.sha256(Path(a.tasks).read_bytes()).hexdigest(),
                    "runtime": "Python/Transformers greedy", "max_new_tokens": a.max_new_tokens})
        write_new_json(target, rep)
        reports[name] = rep
        print(name, json.dumps(rep["summary"], indent=1))
    sheet, key = export_blind(reports, tasks)
    write_new_json(out / "rubric-sheet.json", sheet)
    write_new_json(out / "rubric-key.json", key)


if __name__ == "__main__":
    main()
