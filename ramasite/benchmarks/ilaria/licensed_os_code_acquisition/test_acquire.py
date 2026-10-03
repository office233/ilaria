import importlib.util
from pathlib import Path
import pytest

spec = importlib.util.spec_from_file_location("acquire", Path(__file__).with_name("acquire.py"))
acquire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acquire)


@pytest.mark.parametrize("name", ["/repo-sha/x.c", "repo-sha/../x.c", "repo-sha/a/../../x.c",
                                    "repo-sha/C:/x.c", "repo-sha/a\\x.c", "wrong/x.c"])
def test_archive_path_refuses_escape_or_wrong_snapshot(name):
    assert acquire.safe_member_path(name, "repo-sha") is None


def test_archive_path_accepts_relative_code():
    assert str(acquire.safe_member_path("repo-sha/drivers/a.c", "repo-sha")) == "drivers/a.c"


def test_atomic_metadata_refuses_overwrite(tmp_path):
    path = tmp_path / "manifest.json"
    acquire.write_json_new(path, {"one": 1})
    original = path.read_bytes()
    with pytest.raises(FileExistsError):
        acquire.write_json_new(path, {"two": 2})
    assert path.read_bytes() == original


def test_budget_refuses_over_limit_before_accounting():
    budget = acquire.Budget()
    with pytest.raises(ValueError, match="budget exceeded"):
        budget.check(network=acquire.NETWORK_CAP + 1)
    assert budget.network == 0
    with pytest.raises(ValueError, match="budget exceeded"):
        budget.check(disk=acquire.DISK_CAP + 1)
    assert budget.disk == 0


def test_code_body_dedup_preserves_case_and_indentation():
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from dedup_candidate import body_bytes
    one = {"path": "a.c", "spdx": "MIT", "text": "[FILE a.c SPDX=MIT]\nint Variable;"}
    two = {"path": "b.c", "spdx": "MIT", "text": "[FILE b.c SPDX=MIT]\nint variable;"}
    assert body_bytes(one) != body_bytes(two)
    two["text"] = "[FILE b.c SPDX=MIT]\nint Variable;"
    assert body_bytes(one) == body_bytes(two)
    two["text"] = "[FILE b.c SPDX=MIT]\n    int Variable;"
    assert body_bytes(one) != body_bytes(two)
    with pytest.raises(ValueError, match="prefix mismatch"):
        body_bytes({**one, "text": "unbound synthetic body"})


def test_tar_extract_skips_links_binary_agent_files_and_escapes(tmp_path):
    import io
    import tarfile
    archive = tmp_path / "source.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        for name, content in [
            ("repo-sha/src/good.c", b"int synthetic;"),
            ("repo-sha/src/nul.c", b"a\x00b"),
            ("repo-sha/src/nonutf8.c", b"\xff"),
            ("repo-sha/../outside.c", b"int escaped;"),
            ("repo-sha/AGENTS.md", b"synthetic agent instruction"),
            ("repo-sha/large.c", b"x" * (acquire.FILE_CAP + 1)),
        ]:
            info = tarfile.TarInfo(name)
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
        info = tarfile.TarInfo("repo-sha/link.c")
        info.type = tarfile.SYMTYPE
        info.linkname = "../../outside.c"
        tar.addfile(info)
    tree = tmp_path / "tree"
    report = acquire.extract_code(archive, tree, "repo-sha", acquire.Budget(),
                                 frozenset({"AGENTS.md"}), frozenset())
    assert [p.relative_to(tree).as_posix() for p in tree.rglob("*") if p.is_file()] == ["src/good.c"]
    assert report["extracted_utf8_code_files"] == 1
    assert report["binary_nul"] == report["non_utf8"] == report["unsafe_or_long_path"] == 1
    assert report["agent_instruction_file"] == report["non_regular_link_or_special"] == 1
    assert report["empty_or_oversize_no_truncation"] == 1
    assert not (tmp_path / "outside.c").exists()
