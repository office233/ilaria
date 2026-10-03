from pathlib import Path


def ilaria_root(source: str | Path) -> Path:
    for parent in Path(source).resolve().parents:
        for candidate in (parent, parent / "ilaria"):
            if (candidate / "forge" / "imc_model.py").is_file():
                return candidate
    raise FileNotFoundError(f"Cannot locate Ilaria sources from {source}")


def workspace_root(source: str | Path) -> Path:
    return ilaria_root(source).parent
