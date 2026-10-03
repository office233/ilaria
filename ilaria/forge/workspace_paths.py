"""Locate supporting files in a checkout or a portable Ilaria code bundle."""
from pathlib import Path


def benchmark_root(ilaria_root: Path | None = None) -> Path:
    if ilaria_root is None:
        root = Path(__file__).resolve().parents[1]
    else:
        root = Path(ilaria_root).resolve()
    relocated = root.parent / "ramasite" / "benchmarks" / "ilaria"
    return relocated if relocated.is_dir() else root / "bench"
