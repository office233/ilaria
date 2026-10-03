"""Locate supporting files in a checkout or a portable Ilaria code bundle."""
from pathlib import Path


def benchmark_root(ilaria_root: Path) -> Path:
    root = ilaria_root.resolve()
    relocated = root.parent / "ramasite" / "benchmarks" / "ilaria"
    return relocated if relocated.is_dir() else root / "bench"
