from workspace_paths import benchmark_root


def test_relocated_benchmarks_are_selected(tmp_path):
    root = tmp_path / "nexus" / "ilaria"
    root.mkdir(parents=True)
    relocated = root.parent / "ramasite" / "benchmarks" / "ilaria"
    relocated.mkdir(parents=True)
    assert benchmark_root(root) == relocated


def test_portable_bundle_paths_remain_unchanged(tmp_path):
    root = tmp_path / "portable"
    root.mkdir()
    assert benchmark_root(root) == root / "bench"
