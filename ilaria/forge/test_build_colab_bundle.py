from __future__ import annotations

import hashlib
import json
from pathlib import Path
import zipfile

from build_colab_bundle import BUNDLE_FORMAT, build_bundle


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_bundle_is_deterministic_and_content_addressed(tmp_path: Path):
    root = tmp_path / "repo"
    (root / "forge" / "config").mkdir(parents=True)
    (root / "runtime" / "pce").mkdir(parents=True)
    (root / "AGENTS.md").write_text("rules\n", encoding="utf-8")
    (root / "forge" / "train.py").write_text("print('train')\n", encoding="utf-8")
    (root / "forge" / "config" / "recipe.json").write_text(
        '{"format":"fixture"}\n', encoding="utf-8"
    )
    (root / "runtime" / "pce" / "capsule.go").write_text(
        "package pce\n", encoding="utf-8"
    )

    first_zip = tmp_path / "one.zip"
    first_manifest = tmp_path / "one.json"
    second_zip = tmp_path / "two.zip"
    second_manifest = tmp_path / "two.json"
    first = build_bundle(root, zip_path=first_zip, manifest_path=first_manifest)
    second = build_bundle(root, zip_path=second_zip, manifest_path=second_manifest)

    assert first["zip_sha256"] == second["zip_sha256"]
    assert first_zip.read_bytes() == second_zip.read_bytes()
    manifest = json.loads(first_manifest.read_text(encoding="utf-8"))
    assert manifest["format"] == BUNDLE_FORMAT
    assert [item["path"] for item in manifest["files"]] == [
        "AGENTS.md",
        "forge/config/recipe.json",
        "forge/train.py",
        "runtime/pce/capsule.go",
    ]
    with zipfile.ZipFile(first_zip) as archive:
        assert sorted(archive.namelist()) == sorted(
            item["path"] for item in manifest["files"]
        )
        for item in manifest["files"]:
            assert hashlib.sha256(archive.read(item["path"])).hexdigest() == item["sha256"]
    assert first["manifest_sha256"] == sha256(first_manifest)


def test_relocated_benchmarks_keep_portable_bundle_paths(tmp_path: Path):
    root = tmp_path / "nexus" / "ilaria"
    (root / "forge").mkdir(parents=True)
    (root / "forge" / "imc_model.py").write_text("# fixture\n", encoding="utf-8")
    benchmark = root.parent / "ramasite" / "benchmarks" / "ilaria"
    (benchmark / "imc_125m_g4_probe").mkdir(parents=True)
    (benchmark / "imc_125m_g4_probe" / "runner.py").write_text(
        "print('benchmark')\n", encoding="utf-8"
    )
    (benchmark / "nexus_ilaria_benchmark_paths.py").write_text(
        "# benchmark path helper\n", encoding="utf-8"
    )
    documentation = root.parent / "ramasite" / "docs" / "ilaria" / "runbooks"
    documentation.mkdir(parents=True)
    (documentation / "IMC_125M_GPU_TRAINING.md").write_text(
        "# training fixture\n", encoding="utf-8"
    )
    destination = tmp_path / "relocated.zip"
    manifest_path = tmp_path / "relocated.json"
    build_bundle(root, zip_path=destination, manifest_path=manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = [
        "bench/imc_125m_g4_probe/runner.py",
        "bench/nexus_ilaria_benchmark_paths.py",
        "docs/runbooks/IMC_125M_GPU_TRAINING.md",
        "forge/imc_model.py",
    ]
    assert [record["path"] for record in manifest["files"]] == expected
    with zipfile.ZipFile(destination) as archive:
        assert archive.namelist() == expected


def test_standalone_bundle_keeps_legacy_benchmark_layout(tmp_path: Path):
    root = tmp_path / "standalone"
    (root / "forge").mkdir(parents=True)
    (root / "forge" / "train.py").write_text("print('train')\n", encoding="utf-8")
    benchmark = root / "bench" / "imc_125m_gpu_smoke"
    benchmark.mkdir(parents=True)
    (benchmark / "runner.py").write_text("print('smoke')\n", encoding="utf-8")
    manifest_path = tmp_path / "legacy.json"
    build_bundle(root, zip_path=tmp_path / "legacy.zip", manifest_path=manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert [record["path"] for record in manifest["files"]] == [
        "bench/imc_125m_gpu_smoke/runner.py",
        "forge/train.py",
    ]
