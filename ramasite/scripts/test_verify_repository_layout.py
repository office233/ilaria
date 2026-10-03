import importlib.util
from pathlib import Path


spec = importlib.util.spec_from_file_location("repository_layout", Path(__file__).with_name("verify-repository-layout.py"))
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)


def test_product_sources_and_relocated_support_are_allowed():
    assert layout.validate_paths([
        "ilaria/forge/imc_model.py", "swyp/internal/coreir/ir.go",
        "swypik-os/kernel/src/core/init.c", "ramasite/docs/swyp/SWYP_LANG.md",
        "ramasite/benchmarks/ilaria/go.mod", "ramasite/scripts/verify-effects.py",
    ]) == []


def test_obsolete_support_paths_are_refused():
    for prefix in layout.OBSOLETE_PREFIXES:
        assert layout.validate_paths([prefix + "fixture.md"])[0]["code"] == "obsolete_path"


def test_local_tools_and_restricted_names_are_refused():
    for path in ["ramasite/local/tools/zig.exe", ".tools/zig.exe", "app/.env", "app/.env.production", "weights/model.safetensors", "keys/id_ed25519", "keys/production.pem"]:
        assert layout.validate_paths([path])


def test_public_environment_examples_remain_allowed():
    assert layout.validate_paths(["app/.env.example", "app/.env.template"]) == []
