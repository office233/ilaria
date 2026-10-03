"""Data admission must fail before CUDA, DDP, model or optimizer allocation."""
import json
import sys
from pathlib import Path

import pytest
import torch.distributed

sys.path.insert(0, str(Path(__file__).resolve().parent))
import train_ilaria as trainer  # noqa: E402
from test_imc_model import _tiny_stream  # noqa: E402


@pytest.mark.parametrize("device", ["cpu", "cuda"])
@pytest.mark.parametrize("failure", [
    "stream_hash", "validation_identity", "tokenizer_hash", "manifest_rejected",
    "manifest_stream", "freeze_rejected", "freeze_source_lock",
])
def test_bad_data_never_allocates_accelerator_or_worker(tmp_path, monkeypatch, device, failure):
    train = _tiny_stream(tmp_path, "train", seed=0)
    validation = _tiny_stream(tmp_path, "validation", seed=1)
    tokenizer = tmp_path / "tokenizer.json"
    train_meta = json.loads((tmp_path / "train.json").read_text(encoding="utf-8"))
    val_meta = json.loads((tmp_path / "validation.json").read_text(encoding="utf-8"))
    manifest = {
        "dataset_manifest_sha256": "1" * 64,
        "streams": {"train": train_meta, "validation": val_meta},
        "tokenizer": {"sha256": train_meta["tokenizer_sha256"]},
        "rights": {"filename": "synthetic-rights.json"},
    }
    freeze = {"freeze_sha256": "2" * 64,
              "tokenizer": {"sha256": train_meta["tokenizer_sha256"]},
              "sample": {"source_lock": {"synthetic_fixture": True}}}

    if failure == "stream_hash":
        Path(str(train) + ".bin").write_bytes(b"\x00\x00" * train_meta["tokens"])
    elif failure == "validation_identity":
        val_meta["eos_id"] = 4
        (tmp_path / "validation.json").write_text(json.dumps(val_meta), encoding="utf-8")
    elif failure == "tokenizer_hash":
        tokenizer.write_text('{"changed":true}\n', encoding="utf-8")
    elif failure == "manifest_stream":
        manifest["streams"]["train"] = {"stream_sha256": "3" * 64}
    elif failure == "freeze_source_lock":
        freeze["sample"] = {}

    def manifest_check(_path):
        if failure == "manifest_rejected":
            raise ValueError("synthetic manifest admission rejected")
        return manifest

    def freeze_check(_path, **_kwargs):
        if failure == "freeze_rejected":
            raise ValueError("synthetic tokenizer freeze rejected")
        return freeze

    def forbidden(*_args, **_kwargs):
        pytest.fail("resource allocation happened before data rejection")

    monkeypatch.setattr(trainer, "validate_dataset_manifest_file", manifest_check)
    monkeypatch.setattr(trainer, "validate_freeze_manifest", freeze_check)
    monkeypatch.setattr(trainer.torch.cuda, "is_available", lambda: device == "cuda")
    monkeypatch.setattr(trainer.torch.cuda, "device_count", lambda: 1)
    monkeypatch.setattr(trainer.torch.cuda, "set_device", forbidden)
    monkeypatch.setattr(torch.distributed, "init_process_group", forbidden)
    monkeypatch.setattr(trainer, "ImcTransformer", forbidden)
    monkeypatch.setattr(trainer.torch.optim, "AdamW", forbidden)
    monkeypatch.setenv("WORLD_SIZE", "2")
    monkeypatch.setenv("RANK", "0")
    monkeypatch.setenv("LOCAL_RANK", "0")
    out = tmp_path / "never-created"
    monkeypatch.setattr(sys, "argv", ["train_ilaria.py", "--data", str(train),
        "--val-data", str(validation), "--out", str(out), "--ctx", "16",
        "--tokenizer", str(tokenizer), "--dataset-manifest", str(tmp_path / "manifest.json"),
        "--tokenizer-freeze", str(tmp_path / "freeze.json")])

    with pytest.raises(SystemExit) as rejected:
        trainer.main()
    assert rejected.value.code == 2
    assert not out.exists()


def test_valid_smoke_admission_reaches_resource_setup_after_checks(tmp_path, monkeypatch):
    train = _tiny_stream(tmp_path, "train", seed=0)
    validation = _tiny_stream(tmp_path, "validation", seed=1)
    events = []
    original_load = trainer.load_stream
    original_hash = trainer.file_sha256

    def checked_stream(prefix):
        result = original_load(prefix)
        events.append("train" if prefix == str(train) else "validation")
        return result

    def checked_hash(path):
        result = original_hash(path)
        if Path(path).name == "tokenizer.json":
            events.append("tokenizer")
        return result

    class ReachedResourceSetup(Exception):
        pass

    def resource_setup(_rank):
        assert events == ["train", "validation", "tokenizer"]
        raise ReachedResourceSetup()

    monkeypatch.setattr(trainer, "load_stream", checked_stream)
    monkeypatch.setattr(trainer, "file_sha256", checked_hash)
    monkeypatch.setattr(trainer.torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(trainer.torch.cuda, "device_count", lambda: 1)
    monkeypatch.setattr(trainer.torch.cuda, "set_device", resource_setup)
    for name in ("WORLD_SIZE", "RANK", "LOCAL_RANK"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(sys, "argv", ["train_ilaria.py", "--data", str(train),
        "--val-data", str(validation), "--out", str(tmp_path / "run"), "--ctx", "16",
        "--allow-unmanifested-data"])
    with pytest.raises(ReachedResourceSetup):
        trainer.main()
