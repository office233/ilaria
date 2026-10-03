from pathlib import Path

import pytest

from nexus_ilaria_benchmark_paths import ilaria_root, workspace_root


@pytest.mark.parametrize("relocated", [False, True])
def test_benchmark_locates_local_and_portable_sources(tmp_path: Path, relocated: bool):
    product = tmp_path / "nexus" / "ilaria"
    (product / "forge").mkdir(parents=True)
    (product / "forge" / "imc_model.py").write_text("# fixture\n", encoding="utf-8")
    benchmark = (
        product.parent / "ramasite" / "benchmarks" / "ilaria"
        if relocated else product / "bench"
    )
    source = benchmark / "probe" / "run.py"
    source.parent.mkdir(parents=True)
    source.write_text("# fixture\n", encoding="utf-8")
    assert ilaria_root(source) == product
    assert workspace_root(source) == product.parent


def test_missing_sources_are_reported(tmp_path: Path):
    with pytest.raises(FileNotFoundError, match="Cannot locate Ilaria"):
        ilaria_root(tmp_path / "missing.py")
