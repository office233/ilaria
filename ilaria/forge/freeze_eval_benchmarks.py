"""Freeze external/internal IMC-125M evaluation sets into auditable JSONL."""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import random
from pathlib import Path

import pandas as pd

try:
    from .data_contract import atomic_write_json, canonical_json_sha256, sha256_file
except ImportError:
    from data_contract import atomic_write_json, canonical_json_sha256, sha256_file


FORMAT = "imc-125m-frozen-eval-benchmarks-v1"
REGRESSION_SEED = 9_125_007
REGRESSION_TASKS = 256


def _write_jsonl(path: Path, rows: list[dict]) -> dict:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(
                json.dumps(
                    row,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                + "\n"
            )
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    return {
        "filename": path.name,
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
        "records": len(rows),
    }


def _human_eval(path: Path) -> list[dict]:
    rows: list[dict] = []
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                value = json.loads(line)
                rows.append(
                    {
                        "benchmark": "HumanEval",
                        "task_id": value["task_id"],
                        "prompt": value["prompt"],
                        "entry_point": value["entry_point"],
                        "canonical_solution": value["canonical_solution"],
                        "test": value["test"],
                    }
                )
    return rows


def _gsm8k(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open(encoding="utf-8") as stream:
        for index, line in enumerate(stream):
            if line.strip():
                value = json.loads(line)
                rows.append(
                    {
                        "benchmark": "GSM8K",
                        "id": index,
                        "question": value["question"],
                        "answer": value["answer"],
                    }
                )
    return rows


def _truthfulqa(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        for index, row in enumerate(reader):
            rows.append(
                {
                    "benchmark": "TruthfulQA",
                    "id": index,
                    **{str(key): str(value) for key, value in row.items()},
                }
            )
    return rows


def _arc(path: Path) -> list[dict]:
    frame = pd.read_parquet(path)
    rows: list[dict] = []
    for value in frame.to_dict(orient="records"):
        choices = value["choices"]
        texts = (
            choices["text"].tolist()
            if hasattr(choices["text"], "tolist")
            else list(choices["text"])
        )
        labels = (
            choices["label"].tolist()
            if hasattr(choices["label"], "tolist")
            else list(choices["label"])
        )
        rows.append(
            {
                "benchmark": "AI2-ARC-Challenge",
                "id": str(value["id"]),
                "question": str(value["question"]),
                "choices": [
                    {"label": str(label), "text": str(text)}
                    for label, text in zip(labels, texts)
                ],
                "answer_key": str(value["answerKey"]),
            }
        )
    return rows


def build_continual_regression(
    *, seed: int = REGRESSION_SEED, tasks: int = REGRESSION_TASKS
) -> list[dict]:
    if tasks < 4:
        raise ValueError("continual regression benchmark requires at least four tasks")
    rng = random.Random(seed)
    rows: list[dict] = []
    families = ("modular_arithmetic", "bit_count", "sorted_select", "state_transition")
    for index in range(tasks):
        family = families[index % len(families)]
        if family == "modular_arithmetic":
            a, b, c = (
                rng.randrange(101, 999),
                rng.randrange(101, 999),
                rng.randrange(11, 99),
            )
            modulus = rng.randrange(97, 503)
            answer = ((a * b) + c) % modulus
            prompt = f"Compute (({a} * {b}) + {c}) mod {modulus} exactly."
        elif family == "bit_count":
            value = rng.randrange(1 << 16, 1 << 31)
            answer = value.bit_count()
            prompt = f"How many 1 bits are in the base-2 representation of {value}?"
        elif family == "sorted_select":
            values = [rng.randrange(-5000, 5001) for _ in range(9)]
            rank = rng.randrange(1, 10)
            answer = sorted(values)[rank - 1]
            prompt = (
                f"Sort these integers ascending and return item #{rank}: "
                + ", ".join(str(item) for item in values)
            )
        else:
            state = rng.randrange(0, 17)
            mul = rng.randrange(2, 8)
            add = rng.randrange(1, 13)
            modulus = rng.randrange(19, 67)
            steps = rng.randrange(4, 10)
            start = state
            for _ in range(steps):
                state = (state * mul + add) % modulus
            answer = state
            prompt = (
                f"Start at state {start}. Repeat {steps} times: "
                f"state = (state * {mul} + {add}) mod {modulus}. Return the final state."
            )
        rows.append(
            {
                "benchmark": "IlariaContinualRegressionV1",
                "id": f"cr-{index:04d}",
                "family": family,
                "prompt": prompt,
                "answer": str(answer),
                "verifier": "exact_string_v1",
            }
        )
    return rows


def freeze_benchmarks(
    *,
    human_eval_path: str | Path,
    gsm8k_path: str | Path,
    truthfulqa_path: str | Path,
    arc_path: str | Path,
    revisions: dict[str, str],
    out_dir: str | Path,
) -> dict:
    inputs = {
        "human_eval": Path(human_eval_path),
        "gsm8k": Path(gsm8k_path),
        "truthfulqa": Path(truthfulqa_path),
        "ai2_arc": Path(arc_path),
    }
    missing = [name for name, path in inputs.items() if not path.is_file()]
    if missing:
        raise ValueError(f"benchmark inputs are missing: {missing}")
    if set(revisions) != set(inputs):
        raise ValueError("benchmark revision set mismatch")

    output = Path(out_dir)
    output.mkdir(parents=True, exist_ok=True)
    outputs = {
        "general_truthfulqa": _write_jsonl(
            output / "general_truthfulqa.jsonl",
            _truthfulqa(inputs["truthfulqa"]),
        ),
        "code_humaneval": _write_jsonl(
            output / "code_humaneval.jsonl",
            _human_eval(inputs["human_eval"]),
        ),
        "math_gsm8k": _write_jsonl(
            output / "math_gsm8k.jsonl",
            _gsm8k(inputs["gsm8k"]),
        ),
        "science_arc_challenge": _write_jsonl(
            output / "science_arc_challenge.jsonl",
            _arc(inputs["ai2_arc"]),
        ),
        "continual_regression": _write_jsonl(
            output / "continual_regression.jsonl",
            build_continual_regression(),
        ),
    }
    source_meta = {
        "human_eval": {
            "url": "https://github.com/openai/human-eval.git",
            "revision": revisions["human_eval"],
            "declared_license": "MIT",
        },
        "gsm8k": {
            "url": "https://github.com/openai/grade-school-math.git",
            "revision": revisions["gsm8k"],
            "declared_license": "MIT",
        },
        "truthfulqa": {
            "url": "https://github.com/sylinrl/TruthfulQA.git",
            "revision": revisions["truthfulqa"],
            "declared_license": "Apache-2.0",
        },
        "ai2_arc": {
            "url": "https://huggingface.co/datasets/allenai/ai2_arc",
            "revision": revisions["ai2_arc"],
            "declared_license": "CC-BY-SA-4.0",
        },
    }
    for name, path in inputs.items():
        source_meta[name]["input_filename"] = path.name
        source_meta[name]["input_sha256"] = sha256_file(path)
        source_meta[name]["input_bytes"] = path.stat().st_size

    manifest = {
        "format": FORMAT,
        "policy": "frozen-before-genesis-training-v1",
        "regression": {
            "seed": REGRESSION_SEED,
            "tasks": REGRESSION_TASKS,
            "generator_sha256": sha256_file(__file__),
        },
        "sources": source_meta,
        "outputs": outputs,
    }
    manifest["manifest_sha256"] = canonical_json_sha256(manifest)
    atomic_write_json(output / "frozen-benchmarks.manifest.json", manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--human-eval", required=True)
    parser.add_argument("--gsm8k", required=True)
    parser.add_argument("--truthfulqa", required=True)
    parser.add_argument("--arc", required=True)
    parser.add_argument("--human-eval-revision", required=True)
    parser.add_argument("--gsm8k-revision", required=True)
    parser.add_argument("--truthfulqa-revision", required=True)
    parser.add_argument("--arc-revision", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()
    manifest = freeze_benchmarks(
        human_eval_path=args.human_eval,
        gsm8k_path=args.gsm8k,
        truthfulqa_path=args.truthfulqa,
        arc_path=args.arc,
        revisions={
            "human_eval": args.human_eval_revision,
            "gsm8k": args.gsm8k_revision,
            "truthfulqa": args.truthfulqa_revision,
            "ai2_arc": args.arc_revision,
        },
        out_dir=args.out_dir,
    )
    print(
        f"[eval-freeze] {len(manifest['outputs'])} files "
        f"sha256={manifest['manifest_sha256']}"
    )


if __name__ == "__main__":
    main()
