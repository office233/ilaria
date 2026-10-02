from pathlib import Path
import stat
import zipfile

import pytest

from bundle_workspace import extract_code_bundle


def bundle(tmp_path, members):
    source = tmp_path / "source.zip"
    with zipfile.ZipFile(source, "w") as archive:
        for name, payload in members:
            # Construct explicit ZIP names: ZipInfo otherwise normalizes the
            # host separator on Windows and hides the unsafe-name test case.
            if isinstance(name, str):
                raw_name = name
                name = zipfile.ZipInfo(raw_name)
                name.filename = raw_name
                name.orig_filename = raw_name
            archive.writestr(name, payload)
    return source


def test_extracts_code_without_overwriting_workspaces(tmp_path):
    source = bundle(tmp_path, [("forge/train_ilaria.py", "# synthetic code, never run\n")])
    output = tmp_path / "new workspace"
    extract_code_bundle(source, output)
    before = (output / "forge/train_ilaria.py").read_bytes()
    with pytest.raises(ValueError, match="already exists"):
        extract_code_bundle(source, output)
    assert (output / "forge/train_ilaria.py").read_bytes() == before


@pytest.mark.parametrize("member", ["../outside.py", "/outside.py", "C:/outside.py", "forge/../outside.py",
                                   "forge\\outside.py", "forge//code.py", "./code.py", "NUL", "CON.py", "forge/file. "])
def test_unsafe_members_are_refused_before_workspace_creation(tmp_path, member):
    source = bundle(tmp_path, [(member, "test")])
    output = tmp_path / "workspace"
    with pytest.raises(ValueError, match="unsafe"):
        extract_code_bundle(source, output)
    assert not output.exists()


def test_symlinks_and_directory_conflicts_are_refused(tmp_path):
    link = zipfile.ZipInfo("link")
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    source = bundle(tmp_path, [(link, "outside")])
    with pytest.raises(ValueError, match="unsafe"):
        extract_code_bundle(source, tmp_path / "workspace")
    source = bundle(tmp_path, [("parent", "file"), ("parent/code.py", "test")])
    with pytest.raises(ValueError, match="overlaps"):
        extract_code_bundle(source, tmp_path / "workspace")
    assert not (tmp_path / "workspace").exists()


def test_case_aliased_members_are_refused(tmp_path):
    source = bundle(tmp_path, [("File.py", "first"), ("file.py", "second")])
    with pytest.raises(ValueError, match="case-aliased"):
        extract_code_bundle(source, tmp_path / "workspace")


def test_runtime_scripts_have_no_machine_specific_roots():
    root = Path(__file__).resolve().parents[1]
    names = [
        "imc_125m_gpu_smoke/colab_smoke.py",
        "imc_125m_gpu_smoke/colab_trainer_smoke_runner.py",
        "imc_125m_gpu_smoke/verify_remote_artifacts.py",
        "imc_125m_g4_probe/colab_g4_probe_runner.py",
        "imc_125m_g4_probe/colab_g4_full_step_runner.py",
        "imc_125m_g4_probe/g4_rmsnorm_ab.py",
        "imc_125m_g4_probe/g4_full_step_benchmark.py",
    ]
    for name in names:
        source = (root / "bench" / name).read_text(encoding="utf-8")
        assert '"/content' not in source
        assert "rmtree(" not in source
