"""Build the deterministic code bundle uploaded to Colab training runtimes."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import zipfile


BUNDLE_FORMAT = "ilaria-colab-code-bundle-v1"
_FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)


def _benchmark_root(base: Path) -> Path:
    relocated = base.parent / "ramasite" / "benchmarks" / "ilaria"
    return relocated if relocated.is_dir() else base / "bench"


def _documentation_root(base: Path) -> Path:
    relocated = base.parent / "ramasite" / "docs" / "ilaria"
    return relocated if relocated.is_dir() else base / "docs"


def _bundle_relative(base: Path, path: Path) -> str:
    if base in path.parents:
        return path.relative_to(base).as_posix()
    benchmarks = _benchmark_root(base)
    if benchmarks in path.parents:
        return "bench/" + path.relative_to(benchmarks).as_posix()
    documentation = _documentation_root(base)
    if documentation in path.parents:
        return "docs/" + path.relative_to(documentation).as_posix()
    raise ValueError(f"File lies outside the declared Colab bundle roots: {path}")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def collect_files(root: str | Path) -> list[Path]:
    base = Path(root).resolve()
    files: set[Path] = set()

    for relative in ("AGENTS.md", "go.mod", "go.sum"):
        path = base / relative
        if path.is_file():
            files.add(path)

    for pattern in (
        "forge/**/*.py",
        "forge/config/*.json",
        "runtime/**/*.go",
        "generated/myriad/*.go",
        "specs/myriad.swyp",
        "specs/myriad.manifest.json",
    ):
        for path in base.glob(pattern):
            if not path.is_file():
                continue
            if "__pycache__" in path.parts:
                continue
            files.add(path.resolve())
    benchmarks = _benchmark_root(base)
    for pattern in (
        "imc_125m_g4_probe/*.py",
        "imc_125m_gpu_smoke/*.py",
        "nexus_ilaria_benchmark_paths.py",
    ):
        for path in benchmarks.glob(pattern):
            if path.is_file():
                files.add(path.resolve())
    runbook = _documentation_root(base) / "runbooks" / "IMC_125M_GPU_TRAINING.md"
    if runbook.is_file():
        files.add(runbook.resolve())
    return sorted(files, key=lambda path: _bundle_relative(base, path))


def build_bundle(
    root: str | Path,
    *,
    zip_path: str | Path,
    manifest_path: str | Path,
) -> dict:
    base = Path(root).resolve()
    destination = Path(zip_path).resolve()
    manifest_destination = Path(manifest_path).resolve()
    files = collect_files(base)
    if not files:
        raise ValueError("Colab bundle has no files")

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    with zipfile.ZipFile(
        temporary,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        for path in files:
            relative = _bundle_relative(base, path)
            info = zipfile.ZipInfo(relative, date_time=_FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
    temporary.replace(destination)

    records = [
        {
            "path": _bundle_relative(base, path),
            "bytes": path.stat().st_size,
            "sha256": _sha256(path),
        }
        for path in files
    ]
    manifest = {
        "format": BUNDLE_FORMAT,
        "files": records,
    }
    manifest_destination.parent.mkdir(parents=True, exist_ok=True)
    manifest_destination.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return {
        "format": BUNDLE_FORMAT,
        "files": len(records),
        "bytes": destination.stat().st_size,
        "zip_sha256": _sha256(destination),
        "manifest_sha256": _sha256(manifest_destination),
    }


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    default_dir = root / "data" / "colab"
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=str(root))
    parser.add_argument(
        "--zip",
        default=str(default_dir / "ilaria-live-training-bundle.zip"),
    )
    parser.add_argument(
        "--manifest",
        default=str(default_dir / "ilaria-live-training-bundle.manifest.json"),
    )
    args = parser.parse_args()
    result = build_bundle(
        args.root,
        zip_path=args.zip,
        manifest_path=args.manifest,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
