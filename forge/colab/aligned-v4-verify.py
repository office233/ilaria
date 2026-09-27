from safetensors import safe_open
assert rc_v4 == 0
meta_v4 = json.loads((RUN_V4 / "adapter-step150.json").read_text())
assert meta_v4["contract"]["encoding_version"] == "assistant-header-split-v2"
assert meta_v4["contract"]["initial_adapter"]["weights_sha256"] == "e36695151882767c51d75af41f31ea5230b8772a28a75c021700182690f8f5b9"
with safe_open(str(RUN_V4 / "adapter-step150.safetensors"), framework="pt", device="cpu") as sf:
    assert len(list(sf.keys())) == 420
    for key in sf.keys():
        assert torch.isfinite(sf.get_tensor(key)).all()
artifacts_v4 = {name: hashlib.sha256((RUN_V4 / name).read_bytes()).hexdigest() for name in ["checkpoint.pt", "adapter-step150.json", "adapter-step150.safetensors"]}
(RUN_V4 / "artifact_manifest.json").write_text(json.dumps(artifacts_v4, indent=2))
print("VERIFIED: aligned v4, 150 steps, 420 finite tensors, encoding and lineage confirmed")
print("Validation:", meta_v4["validation_assistant_loss"])
print(json.dumps(artifacts_v4, indent=2))
from google.colab import files
files.download(str(RUN_V4 / "adapter-step150.json"))
files.download(str(RUN_V4 / "adapter-step150.safetensors"))
