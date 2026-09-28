"""Build Ilaria's Hugging Face instruction/tool mix (hfmix-v1) in the cortex.Runner protocol.

Every row is {language, source, messages} where messages use the exact
System/User/Assistant/Tool protocol validated by forge/tool_data.py:
  * tool use is one line "CALL <name>: <json args>" followed by a "tool" message;
  * the system prompt is the serving prompt with the example's own tool list,
    so the model learns to use whatever tools the host (SwypikOS) declares.

Only sources whose licence permits commercial use are included (see SOURCES).
Human-written sources are PII-scrubbed; rows containing control tokens are
dropped; prompts that appear in the frozen evaluation sets are excluded.

Run on Colab (needs `datasets`):
  python -m forge.hfmix.build_mix --out /content/drive/MyDrive/ilaria/swypikos-en/datasets/hfmix-v1 \
      --bench bench/swypik-v1/tasks.jsonl --extra-train <project-v6/train.jsonl>
"""
import argparse
import hashlib
import json
import random
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from forge.prepare_corpus import scrub_pii  # noqa: E402

# Serving prompt pieces; with SERVING_TOOLS this reproduces the pilot/serve prompt exactly.
PROMPT_HEAD = ('You are Ilaria, the local assistant for SwypikOS. Respond in English by default, unless the user '
               'explicitly requests another language. Never claim an action succeeded unless its tool result confirms '
               'success. Tool errors are failures, not evidence of completion.\n\nIf you need a tool, reply with EXACTLY '
               'one line in this form and nothing else — no words before it, no words after it, no explanation:\n'
               'CALL <tool>: <args>\n\nYou will then be given a line starting with "Tool:" carrying the result. Read it, '
               "then answer the user's question in plain language — do not just repeat the raw result verbatim if a full "
               'sentence reads better. If you do NOT need a tool, skip the CALL line entirely and answer directly in '
               'plain language.\n\nAvailable tools:\n')
PROMPT_TAIL = ('\n\nExamples:\n\nUser: What is 12 times 7?\nAssistant: CALL calc: 12*7\nTool: 84\nAssistant: 12 times 7 '
               'is 84.\n\nUser: What is the capital of France?\nAssistant: The capital of France is Paris.')
SERVING_TOOLS = [
    "- calc: <arithmetic expression> — exact arithmetic: + - * / ^, parentheses, sqrt(x)",
    "- time: (no args) — the current date and time, local and UTC, including day of week",
    "- convert: <N> <from-unit> to <to-unit> — unit conversion (km/mi, kg/lb, C/F, m/ft)",
]

SOURCES = {
    "glaive": ("glaiveai/glaive-function-calling-v2", "default", "apache-2.0", 20000),
    "hermes": ("NousResearch/hermes-function-calling-v1", "func_calling", "apache-2.0", 5000),
    "oasst2": ("OpenAssistant/oasst2", "default", "apache-2.0", 12000),
    "aya": ("CohereLabs/aya_dataset", "default", "apache-2.0", 10000),
    "gsm8k": ("openai/gsm8k", "main", "mit", 7473),
    "metamath": ("meta-math/MetaMathQA", "default", "mit", 8000),
    "magicoder": ("ise-uiuc/Magicoder-OSS-Instruct-75K", "default", "mit", 8000),
}
HUMAN_WRITTEN = {"oasst2", "aya"}
MAX_CHARS = 6000


def system_prompt(tool_lines=None):
    return PROMPT_HEAD + "\n".join(tool_lines or SERVING_TOOLS) + PROMPT_TAIL


def tool_line(fn):
    """One prompt line for a JSON-schema function: '- name: {"arg": type, ...} — description'.

    Malformed schemas raise ValueError; build() counts that example as invalid.
    """
    schema = fn.get("parameters") or {}
    params = schema.get("properties") or {} if isinstance(schema, dict) else None
    required = schema.get("required") or [] if isinstance(schema, dict) else None
    if (not isinstance(fn.get("name"), str) or not isinstance(params, dict)
            or not isinstance(required, list) or not all(isinstance(v, dict) for v in params.values())):
        raise ValueError("malformed function schema")
    required = set(map(str, required))
    args = ", ".join(f'"{k}": {v.get("type", "any")}{"" if k in required else "?"}' for k, v in params.items())
    desc = " ".join(str(fn.get("description", "")).split())
    return f"- {fn['name']}: {{{args}}} — {desc}"


def call_line(name, arguments):
    if isinstance(arguments, str):
        arguments = arguments.strip().strip("'")
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError:
            pass
    args = json.dumps(arguments, ensure_ascii=False, separators=(", ", ": ")) if not isinstance(arguments, str) else arguments
    return f"CALL {name}: {args}"


def clean(text):
    return text.replace("<|endoftext|>", "").strip()


def row(language, source, prompt, turns):
    return {"language": language, "source": source, "messages": [{"role": "system", "content": prompt}] + turns}


# ── converters: each takes one dataset record and returns a row or None ──

def convert_glaive(rec):
    system = rec["system"]
    start = system.find("{")
    tools = []
    if start >= 0:
        blob = system[start:]
        dec = json.JSONDecoder()
        pos = 0
        while pos < len(blob):
            blob_rest = blob[pos:].lstrip()
            if not blob_rest.startswith("{"):
                break
            obj, used = dec.raw_decode(blob_rest)
            tools.append(obj)
            pos = len(blob) - len(blob_rest) + used
    lines = [tool_line(t) for t in tools if "name" in t] or ["- (no tools are available in this conversation)"]
    parts = re.split(r"\n*(USER|ASSISTANT|FUNCTION RESPONSE): ", "\n" + rec["chat"])
    turns = []
    for speaker, text in zip(parts[1::2], parts[2::2]):
        text = clean(text)
        if not text:
            return None
        if speaker == "USER":
            turns.append({"role": "user", "content": text})
        elif speaker == "FUNCTION RESPONSE":
            turns.append({"role": "tool", "content": text})
        elif text.startswith("<functioncall>"):
            payload = text[len("<functioncall>"):].strip()
            m = re.match(r'\{"name":\s*"([^"]+)",\s*"arguments":\s*(.*)\}\s*$', payload, re.S)
            if not m:
                return None
            turns.append({"role": "assistant", "content": call_line(m.group(1), m.group(2))})
        else:
            turns.append({"role": "assistant", "content": text})
    return row("en", "glaive", system_prompt(lines), turns)


def convert_hermes(rec):
    conv = rec["conversations"]
    tools = json.loads(rec["tools"]) if isinstance(rec.get("tools"), str) and rec["tools"].strip().startswith("[") else []
    lines = [tool_line(t.get("function", t)) for t in tools]
    if not lines:
        return None
    turns = []
    for msg in conv:
        who, text = msg["from"], msg["value"]
        if who == "system":
            continue
        if who == "human":
            turns.append({"role": "user", "content": text.strip()})
        elif who == "gpt":
            calls = re.findall(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", text, re.S)
            if calls:
                turns.append({"role": "assistant", "content": "\n".join(
                    call_line(json.loads(c)["name"], json.loads(c).get("arguments", {})) for c in calls)})
            else:
                turns.append({"role": "assistant", "content": text.strip()})
        elif who == "tool":
            turns.append({"role": "tool", "content": "\n".join(
                r.strip() for r in re.findall(r"<tool_response>(.*?)</tool_response>", text, re.S)) or text.strip()})
    # The runner executes one CALL per assistant turn: split multi-call turns into CALL/Tool pairs.
    out = []
    i = 0
    while i < len(turns):
        t = turns[i]
        if t["role"] == "assistant" and t["content"].startswith("CALL ") and "\n" in t["content"]:
            calls = t["content"].split("\n")
            results = turns[i + 1]["content"].split("\n") if i + 1 < len(turns) and turns[i + 1]["role"] == "tool" else []
            if len(results) != len(calls):
                return None
            for c, r in zip(calls, results):
                out += [{"role": "assistant", "content": c}, {"role": "tool", "content": r}]
            i += 2
            continue
        out.append(t)
        i += 1
    return row("en", "hermes", system_prompt(lines), out)


def oasst_threads(records):
    """Best-ranked reviewed path of every oasst2 tree (prompter/assistant alternation)."""
    by_id = {r["message_id"]: r for r in records if not r.get("deleted") and r.get("review_result") is not False}
    children = defaultdict(list)
    for r in by_id.values():
        if r["parent_id"] in by_id:
            children[r["parent_id"]].append(r)
    for root in (r for r in by_id.values() if r["parent_id"] is None):
        path, node = [root], root
        while children.get(node["message_id"]):
            node = min(children[node["message_id"]], key=lambda c: (c.get("rank") is None, c.get("rank") or 0))
            path.append(node)
        if path[-1]["role"] != "assistant":
            path = path[:-1]
        if len(path) >= 2:
            turns = [{"role": "user" if m["role"] == "prompter" else "assistant", "content": m["text"].strip()} for m in path]
            yield row(root["lang"] or "en", "oasst2", system_prompt(), turns)


def convert_aya(rec):
    lang = rec.get("language_code") or "und"
    return row(lang, "aya", system_prompt(), [{"role": "user", "content": rec["inputs"].strip()},
                                             {"role": "assistant", "content": rec["targets"].strip()}])


def convert_gsm8k(rec):
    work, _, final = rec["answer"].partition("####")
    work = re.sub(r"<<[^>]*>>", "", work).strip()
    return row("en", "gsm8k", system_prompt(), [{"role": "user", "content": rec["question"].strip()},
                                               {"role": "assistant", "content": f"{work}\nThe answer is {final.strip()}."}])


def convert_metamath(rec):
    return row("en", "metamath", system_prompt(), [{"role": "user", "content": rec["query"].strip()},
                                                  {"role": "assistant", "content": rec["response"].strip()}])


def convert_magicoder(rec):
    return row("en", "magicoder", system_prompt(), [{"role": "user", "content": rec["problem"].strip()},
                                                   {"role": "assistant", "content": rec["solution"].strip()}])


CONVERTERS = {"glaive": convert_glaive, "hermes": convert_hermes, "aya": convert_aya, "gsm8k": convert_gsm8k,
              "metamath": convert_metamath, "magicoder": convert_magicoder}


def prompt_key(text):
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def valid(r):
    msgs = r["messages"]
    if len(msgs) < 3 or msgs[-1]["role"] != "assistant" or msgs[-1]["content"].startswith("CALL "):
        return False
    prev = "system"
    allowed = {"system": ("user",), "user": ("assistant",), "assistant": ("user", "tool"), "tool": ("assistant",)}
    for i, m in enumerate(msgs):
        c = m["content"]
        if not isinstance(c, str) or not c.strip() or "<|" in c:
            return False
        if i == 0:
            continue
        if m["role"] not in allowed[prev]:
            return False
        if prev == "assistant" and (m["role"] == "tool") != msgs[i - 1]["content"].strip().startswith("CALL "):
            return False
        prev = m["role"]
    return sum(len(m["content"]) for m in msgs[1:]) <= MAX_CHARS


def finalize(r):
    if r["source"] in HUMAN_WRITTEN:
        for m in r["messages"][1:]:
            m["content"] = scrub_pii(m["content"])
    return r


def forbidden_prompts(paths):
    keys = set()
    for path in paths:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            if line.strip():
                item = json.loads(line)
                if "prompt" in item:
                    keys.add(prompt_key(item["prompt"]))
    return keys


def split_rows(rows, seed, val_fraction=0.02, val_cap=300):
    by_source = defaultdict(list)
    for r in rows:
        by_source[r["source"]].append(r)
    rng = random.Random(seed)
    train, val = [], []
    for src, items in sorted(by_source.items()):
        rng.shuffle(items)
        n_val = min(val_cap, max(1, int(len(items) * val_fraction)))
        val += items[:n_val]
        train += items[n_val:]
    # No initial prompt may appear in both splits.
    val_keys = {prompt_key(next(m["content"] for m in r["messages"] if m["role"] == "user")) for r in val}
    train = [r for r in train if prompt_key(next(m["content"] for m in r["messages"] if m["role"] == "user")) not in val_keys]
    rng.shuffle(train)
    rng.shuffle(val)
    return train, val


def safe_convert(convert, rec):
    """A record the converter cannot parse is invalid data, not a reason to abort the build."""
    try:
        return convert(rec)
    except (ValueError, TypeError, KeyError, AttributeError, IndexError):
        return None


def build(records_by_source, forbidden, seed=42):
    rows, stats = [], Counter()
    seen = set()
    for src, records in records_by_source.items():
        cap = SOURCES[src][3]
        produced = oasst_threads(records) if src == "oasst2" else (safe_convert(CONVERTERS[src], r) for r in records)
        kept = 0
        for r in produced:
            stats[f"{src}:seen"] += 1
            try:
                if r is None or not valid(r):
                    stats[f"{src}:invalid"] += 1
                    continue
            except Exception:
                stats[f"{src}:invalid"] += 1
                continue
            key = prompt_key(next(m["content"] for m in r["messages"] if m["role"] == "user"))
            if key in forbidden:
                stats[f"{src}:benchmark_leak"] += 1
                continue
            if key in seen:
                stats[f"{src}:duplicate"] += 1
                continue
            seen.add(key)
            rows.append(finalize(r))
            kept += 1
            if kept >= cap:
                break
        stats[f"{src}:kept"] = kept
    return split_rows(rows, seed), stats


def load_source(name):
    from datasets import load_dataset
    repo, config, _, _ = SOURCES[name]
    ds = load_dataset(repo, config if config != "default" else None, split="train")
    return ds.shuffle(seed=42) if name != "oasst2" else ds


def write_jsonl(path, rows):
    text = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
    path.write_bytes(text.encode("utf-8"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--bench", action="append", default=[], help="JSONL with 'prompt' fields to exclude (repeatable)")
    p.add_argument("--extra-train", action="append", default=[], help="Existing trajectory JSONL added to train (e.g. project-v6)")
    p.add_argument("--sources", default=",".join(SOURCES))
    args = p.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=False)
    records = {name: load_source(name) for name in args.sources.split(",")}
    (train, val), stats = build(records, forbidden_prompts(args.bench))
    for path in args.extra_train:
        extra = [json.loads(l) for l in Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]
        for r in extra:
            r.setdefault("source", "project-v6")
        train += extra
        stats["extra_train"] += len(extra)
    random.Random(7).shuffle(train)
    manifest = {
        "train": {"rows": len(train), "sha256": write_jsonl(out / "train.jsonl", train)},
        "validation": {"rows": len(val), "sha256": write_jsonl(out / "validation.jsonl", val)},
        "languages": sorted({r["language"] for r in train + val}),
        "sources": {k: {"repo": v[0], "config": v[1], "license": v[2], "cap": v[3]} for k, v in SOURCES.items()},
        "stats": dict(stats),
        "rows_by_source": dict(Counter(r["source"] for r in train)),
        "excluded_benchmarks": args.bench,
        "notes": "Commercially licensed sources only; oasst2/aya PII-scrubbed; one CALL per assistant turn.",
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({k: manifest[k] for k in ("train", "validation", "rows_by_source")}, indent=2))


if __name__ == "__main__":
    main()
