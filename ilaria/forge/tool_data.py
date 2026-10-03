"""Validated multilingual tool trajectories; the first release trains English.

JSONL rows: {language: "en", messages: [{role, content}, ...]}.
Roles use the exact System/User/Assistant/Tool text protocol of cortex.Runner.
Supply the serving system prompt as the first message in every trajectory.
"""
import hashlib
import json
import unicodedata
from collections import Counter

ENCODING_VERSION = "assistant-header-split-v2"


def load_trajectories(path, languages=("en",)):
    rows = []
    with open(path, encoding="utf-8") as source:
        for number, line in enumerate(source, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            lang = row.get("language")
            if lang not in languages:
                raise ValueError(f"{path}:{number}: language {lang!r} is not enabled")
            messages = row.get("messages", [])
            if len(messages) < 3 or messages[0].get("role") != "system" or messages[-1].get("role") != "assistant":
                raise ValueError(f"{path}:{number}: expected system, conversation, final assistant answer")
            previous = "system"
            for i, message in enumerate(messages):
                role, content = message.get("role"), message.get("content")
                if not isinstance(content, str) or not content.strip() or "<|" in content:
                    raise ValueError(f"{path}:{number}: empty content or embedded control token")
                if i == 0:
                    continue
                allowed = {"system": ("user",), "user": ("assistant",),
                           "assistant": ("user", "tool"), "tool": ("assistant",)}[previous]
                if role not in allowed:
                    raise ValueError(f"{path}:{number}: invalid role transition {previous} -> {role}")
                prev_content = messages[i - 1]["content"].strip()
                if previous == "assistant" and (role == "tool") != prev_content.startswith("CALL "):
                    raise ValueError(f"{path}:{number}: each CALL requires a tool observation")
                previous = role
            if messages[-1]["content"].strip().startswith("CALL "):
                raise ValueError(f"{path}:{number}: missing tool observation/final answer")
            rows.append(row)
    if not rows:
        raise ValueError(f"{path}: empty dataset")
    return rows


def task_key(row):
    # Group paraphrases separately during curation; this catches exact prompt
    # duplicates even if their answers, tool observations or language tags differ.
    prompt = next(m["content"] for m in row["messages"] if m["role"] == "user")
    prompt = " ".join(unicodedata.normalize("NFKC", prompt).casefold().split())
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def validate_splits(train, validation):
    overlap = {task_key(r) for r in train} & {task_key(r) for r in validation}
    shared_ids = {r["task_id"] for r in train if r.get("task_id")} & {r["task_id"] for r in validation if r.get("task_id")}
    if shared_ids:
        raise ValueError(f"training/validation leakage: {len(shared_ids)} shared task IDs (including translations)")
    if overlap:
        raise ValueError(f"training/validation leakage: {len(overlap)} shared initial prompts")
    return {"train": dict(Counter(r["language"] for r in train)),
            "validation": dict(Counter(r["language"] for r in validation))}


def encode_trajectory(row, tokenizer, max_length):
    ids, labels = [], []
    for message in row["messages"]:
        role = message["role"]
        content = message["content"].strip() + "<|eot_id|>"
        if role == "assistant":
            # Go feeds the complete generation header before sampling. Encoding
            # header+answer together merges its trailing space into the first
            # answer token, creating a different prefix from live inference.
            header = tokenizer.encode("Assistant: ", add_special_tokens=False)
            answer = tokenizer.encode(content, add_special_tokens=False)
            ids.extend(header + answer)
            labels.extend([-100] * len(header) + answer)
        else:
            full = tokenizer.encode(role.capitalize() + ": " + content, add_special_tokens=False)
            ids.extend(full)
            labels.extend([-100] * len(full))
    if len(ids) > max_length:
        raise ValueError(f"trajectory has {len(ids)} tokens > {max_length}; curate it instead of truncating actions")
    return {"input_ids": ids, "labels": labels, "language": row["language"]}
