"""Fail-closed checks and Python-only probes for the isolated v7 Colab pilot.

No downloads, training or filesystem changes occur on import. Historical runs
remain read-only. The pilot reuses the reviewed v6 dataset, not a new corpus.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import sys
import unicodedata

from forge.tool_data import ENCODING_VERSION, encode_trajectory, load_trajectories, validate_splits

MODEL_ID = "microsoft/bitnet-b1.58-2B-4T"
MODEL_REVISION = "04c3b9ad9361b824064a1f25ea60a8be9599b127"
PARENT_NAME = "drafting-v5-150steps/adapter-step150"
PARENT_HASHES = {
    "json": "914a4411bbe34c78d606531ca8475e28ee92b3712464371960ac0a4f76fa2876",
    "safetensors": "1a275f6a5541da2cc942d25c6bd7530fcfbb74c17c501cf0e49a1efbca4e8446",
}
SETTINGS = {
    "steps": 50, "lr": 0.00002, "batch": 1, "accum": 8,
    "max_length": 2048, "rank": 16, "alpha": 32, "seed": 42,
    "checkpoint_every": 10, "log_every": 10, "max_runtime_minutes": 15,
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def write_new_json(path: Path, value: object) -> None:
    """Never replace an existing report, including an interrupted write."""
    with Path(path).open("x", encoding="utf-8", newline="\n") as target:
        json.dump(value, target, ensure_ascii=False, indent=2, allow_nan=False)
        target.write("\n")


def prompt_key(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def check_parent(prefix: Path, expected: dict[str, str] | None = None) -> dict[str, str]:
    expected = PARENT_HASHES if expected is None else expected
    actual = {}
    for suffix, digest in expected.items():
        path = Path(str(prefix) + "." + suffix)
        require(path.is_file(), f"Missing verified v5 parent: {path}")
        actual[suffix] = sha256_file(path)
        require(actual[suffix] == digest, f"Parent SHA256 mismatch: {path.name}")
    return actual


def check_dataset(directory: Path, system_prompt: str, probes: list[dict], tokenizer=None) -> dict:
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    rows, hashes = {}, {}
    normalized_system = system_prompt.replace("\r\n", "\n").strip()
    protected = {prompt_key(probe["prompt"]) for probe in probes}
    for split in ("train", "validation"):
        path = directory / f"{split}.jsonl"
        hashes[split] = sha256_file(path)
        require(hashes[split] == manifest[split]["sha256"], f"Dataset hash mismatch: {split}")
        rows[split] = load_trajectories(path, ("en",))
        require(len(rows[split]) == manifest[split]["rows"], f"Dataset count mismatch: {split}")
        for row in rows[split]:
            require(row["messages"][0]["content"].replace("\r\n", "\n").strip() == normalized_system,
                    f"Serving system prompt mismatch in {split}; review before training")
            require(not any(prompt_key(m["content"]) in protected for m in row["messages"] if m["role"] == "user"),
                    f"Frozen probe leakage in {split}")
    counts = validate_splits(rows["train"], rows["validation"])
    result = {"counts": counts, "sha256": hashes, "manifest_sha256": sha256_file(directory / "manifest.json")}
    if tokenizer is not None:
        require(tokenizer.eos_token_id is not None, "Tokenizer has no EOS token")
        end = tokenizer.encode("<|eot_id|>", add_special_tokens=False)
        require(len(end) == 1 and end[0] != getattr(tokenizer, "unk_token_id", None), "Invalid EOT token contract")
        lengths = [len(encode_trajectory(row, tokenizer, SETTINGS["max_length"])["input_ids"])
                   for split in rows.values() for row in split]
        result["max_tokens"] = max(lengths)
        result["eot_id"] = end[0]
    return result


def check_inputs(root: Path, work: Path, run_name: str, sources: dict[str, str],
                 system_prompt: str, probes: list[dict], tokenizer=None) -> dict:
    require(re.fullmatch(r"project-v7-pilot-[A-Za-z0-9_-]+", run_name) is not None, "Invalid isolated pilot run name")
    run = root / "runs" / run_name
    require(not run.exists() or (run.is_dir() and not any(run.iterdir())),
            "Run already contains artifacts; preserved. Select a new run name, not v5/v6")
    revision_file = root / "base_revision.txt"
    if revision_file.exists():
        require(revision_file.read_text(encoding="utf-8").strip() == MODEL_REVISION,
                "Drive base revision differs from the verified v5 base")
    source_hashes = {name: sha256_file(work / name) for name in sources}
    require(source_hashes == sources, "Source bundle changed after packaging")
    parent = check_parent(root / "runs" / PARENT_NAME)
    dataset = check_dataset(root / "datasets" / "project-v6", system_prompt, probes, tokenizer)
    require(dataset["counts"] == {"train": {"en": 1081}, "validation": {"en": 256}},
            "This pilot requires the reviewed 1081/256-row v6 corpus")
    return {"schema": 1, "run_name": run_name, "model_id": MODEL_ID, "model_revision": MODEL_REVISION,
            "parent_sha256": parent, "dataset": dataset, "sources": source_hashes,
            "system_sha256": hashlib.sha256(system_prompt.encode()).hexdigest(),
            "probes_sha256": hashlib.sha256(json.dumps(probes, sort_keys=True).encode()).hexdigest(),
            "settings": dict(SETTINGS), "encoding_version": ENCODING_VERSION,
            "evaluation_scope": "Python-only development probes; Go regression gate still required",
            "promoted": False}


def training_command(root: Path, model: Path, run_name: str) -> list[str]:
    require(re.fullmatch(r"project-v7-pilot-[A-Za-z0-9_-]+", run_name) is not None, "Invalid isolated pilot run name")
    data = root / "datasets" / "project-v6"
    command = [sys.executable, "-u", "-m", "forge.train_tools", "--train", str(data / "train.jsonl"),
               "--validation", str(data / "validation.jsonl"), "--llm-dir", str(model),
               "--out", str(root / "runs" / run_name), "--init-adapter", str(root / "runs" / PARENT_NAME),
               "--languages", "en", "--gradient-checkpointing"]
    for name, value in SETTINGS.items():
        command.extend(["--" + name.replace("_", "-"), str(value)])
    return command


def probe_adapter(model_dir: Path, prefix: Path, system_prompt: str, probes: list[dict], output: Path) -> str:
    """Record raw greedy generations, never execute model-proposed actions or score them."""
    import gc
    import torch
    from transformers import AutoTokenizer
    from forge.train_tools import initialize_adapter
    import lora_bitlinear as lb

    require(not output.exists(), f"Probe output already exists: {output}")
    require(torch.cuda.is_available() and torch.cuda.is_bf16_supported(), "A BF16 CUDA runtime is required")
    tokenizer = AutoTokenizer.from_pretrained(str(model_dir), local_files_only=True)
    model = lb.load_frozen_base("offline", str(model_dir)).to("cuda")
    try:
        lb.inject_lora(model, r=16, alpha=32, dropout=0)
        model.to("cuda")
        parent = initialize_adapter(model, str(prefix), lb, "offline", 16, 32)
        model.eval()
        answers = []
        stop = tokenizer.encode("<|eot_id|>", add_special_tokens=False)
        require(len(stop) == 1 and tokenizer.eos_token_id is not None, "Invalid inference EOT/EOS contract")
        for task in probes:
            # The assistant header is encoded separately, as in the SFT contract.
            context = "System: " + system_prompt.strip() + "<|eot_id|>User: " + task["prompt"] + "<|eot_id|>"
            tokens = tokenizer.encode(context, add_special_tokens=False) + tokenizer.encode("Assistant: ", add_special_tokens=False)
            ids = torch.tensor([tokens], device="cuda")
            with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                generated = model.generate(ids, attention_mask=torch.ones_like(ids), do_sample=False,
                    max_new_tokens=256, pad_token_id=tokenizer.eos_token_id,
                    eos_token_id=sorted(set(stop + [tokenizer.eos_token_id])))
            answer = {**task, "generation": tokenizer.decode(generated[0, len(tokens):], skip_special_tokens=True)}
            answers.append(answer)
            print(json.dumps(answer, ensure_ascii=False), flush=True)
        write_new_json(output, {"adapter": parent, "runtime": "Python/Transformers", "max_new_tokens": 256,
                              "tools_executed": False, "scored": False, "answers": answers})
        return sha256_file(output)
    finally:
        del model
        gc.collect()
        torch.cuda.empty_cache()
