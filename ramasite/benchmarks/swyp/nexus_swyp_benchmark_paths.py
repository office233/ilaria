from pathlib import Path


def swyp_root(source: str | Path) -> Path:
    for parent in Path(source).resolve().parents:
        for candidate in (parent, parent / "swyp"):
            if (candidate / "go.mod").is_file() and (candidate / "internal" / "swyplang").is_dir():
                return candidate
    raise FileNotFoundError(f"Cannot locate Swyp sources from {source}")


def benchmark_root(source: str | Path) -> Path:
    for parent in Path(source).resolve().parents:
        if (parent / "nexus_swyp_benchmark_paths.py").is_file():
            return parent
    raise FileNotFoundError(f"Cannot locate Swyp benchmarks from {source}")
