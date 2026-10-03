from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest


RECIPE = Path(__file__).with_name("acquire_voxpopuli_ro.py")


def _load_recipe():
    spec = importlib.util.spec_from_file_location("voxpopuli_acquisition", RECIPE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_existing_outputs_are_preserved_before_archive_or_tokenizer_load(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    output_dir = tmp_path / "already-used-output"
    output_dir.mkdir()
    existing = {
        "voxpopuli-ro-asr-train.quarantine.jsonl": b"existing corpus bytes\n",
        "candidate-manifest.json": b"existing manifest bytes\n",
        "voxpopuli-ro-asr-train.quarantine.jsonl.tmp": b"existing temp bytes\n",
        "candidate-manifest.json.tmp": b"existing manifest temp bytes\n",
    }
    for filename, payload in existing.items():
        (output_dir / filename).write_bytes(payload)

    missing_source = tmp_path / "source-does-not-exist"
    monkeypatch.setattr(
        sys,
        "argv",
        [str(RECIPE), str(missing_source), str(output_dir)],
    )

    with pytest.raises(FileExistsError, match="choose a fresh path"):
        _load_recipe().main()

    assert not missing_source.exists()
    assert {
        filename: (output_dir / filename).read_bytes() for filename in existing
    } == existing
