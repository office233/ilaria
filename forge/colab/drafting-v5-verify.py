from safetensors import safe_open
assert rc_v5 == 0
meta_v5 = json.loads((RUN_V5 / "adapter-step150.json").read_text())
assert meta_v5["contract"]["encoding_version"] == "assistant-header-split-v2"
assert meta_v5["contract"]["initial_adapter"]["weights_sha256"] == "b368303a7bf659a6bc76e4e5ec8a1b5f5c728d80f4f9bfea62de31dd6f81c966"
with safe_open(str(RUN_V5 / "adapter-step150.safetensors"), framework="pt", device="cpu") as sf:
    assert len(list(sf.keys())) == 420
    for key in sf.keys():
        assert torch.isfinite(sf.get_tensor(key)).all()
artifacts_v5 = {name: hashlib.sha256((RUN_V5 / name).read_bytes()).hexdigest() for name in ["checkpoint.pt", "adapter-step150.json", "adapter-step150.safetensors"]}
(RUN_V5 / "artifact_manifest.json").write_text(json.dumps(artifacts_v5, indent=2))
print("VERIFIED: aligned v5, 150 steps, 420 finite tensors, encoding and lineage confirmed")
print("Validation:", meta_v5["validation_assistant_loss"])
print(json.dumps(artifacts_v5, indent=2))
from google.colab import files
import shutil
for suffix in ["json", "safetensors"]:
    target = Path("/content/ilaria-drafting-v5." + suffix)
    shutil.copyfile(RUN_V5 / ("adapter-step150." + suffix), target)
    files.download(str(target))
