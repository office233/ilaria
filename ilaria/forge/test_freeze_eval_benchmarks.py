from __future__ import annotations

import csv
import gzip
import json
from pathlib import Path

import pandas as pd

from freeze_eval_benchmarks import (
    REGRESSION_SEED,
    build_continual_regression,
    freeze_benchmarks,
)


def test_continual_regression_is_deterministic_and_unique():
    first = build_continual_regression(seed=REGRESSION_SEED, tasks=32)
    second = build_continual_regression(seed=REGRESSION_SEED, tasks=32)
    assert first == second
    assert len({row["prompt"] for row in first}) == 32
    assert {row["family"] for row in first} == {
        "modular_arithmetic",
        "bit_count",
        "sorted_select",
        "state_transition",
    }


def test_freeze_benchmarks_normalizes_all_inputs(tmp_path: Path):
    human = tmp_path / "human.jsonl.gz"
    with gzip.open(human, "wt", encoding="utf-8") as stream:
        stream.write(
            json.dumps(
                {
                    "task_id": "HumanEval/0",
                    "prompt": "def f(x):",
                    "entry_point": "f",
                    "canonical_solution": " return x",
                    "test": "assert f(1) == 1",
                }
            )
            + "\n"
        )
    gsm = tmp_path / "gsm.jsonl"
    gsm.write_text(
        json.dumps({"question": "1+1?", "answer": "2"}) + "\n",
        encoding="utf-8",
    )
    truthful = tmp_path / "truth.csv"
    with truthful.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=["Question", "Best Answer"])
        writer.writeheader()
        writer.writerow({"Question": "Q?", "Best Answer": "A"})
    arc = tmp_path / "arc.parquet"
    pd.DataFrame(
        [
            {
                "id": "arc-1",
                "question": "Science?",
                "choices": {"text": ["A", "B"], "label": ["A", "B"]},
                "answerKey": "A",
            }
        ]
    ).to_parquet(arc)

    manifest = freeze_benchmarks(
        human_eval_path=human,
        gsm8k_path=gsm,
        truthfulqa_path=truthful,
        arc_path=arc,
        revisions={
            "human_eval": "a" * 40,
            "gsm8k": "b" * 40,
            "truthfulqa": "c" * 40,
            "ai2_arc": "d" * 40,
        },
        out_dir=tmp_path / "out",
    )
    assert set(manifest["outputs"]) == {
        "general_truthfulqa",
        "code_humaneval",
        "math_gsm8k",
        "science_arc_challenge",
        "continual_regression",
    }
    assert manifest["outputs"]["code_humaneval"]["records"] == 1
    assert manifest["outputs"]["math_gsm8k"]["records"] == 1
    assert manifest["outputs"]["general_truthfulqa"]["records"] == 1
    assert manifest["outputs"]["science_arc_challenge"]["records"] == 1
