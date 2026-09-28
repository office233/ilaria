# v8 r3 cells, loaded by Ilaria_V8r3_HFMix_Launcher.ipynb (Drive colab-v7/, pinned by SHA-256).
# r3 (2026-09-28): every source file comes from one public commit (build_mix.py there already
# carries the r2 fixes, same SHA-256), and cell 3 drops rows over 2048 tokens into
# datasets/hfmix-v1-len2048 before training. r2 stopped on 540 such rows.
# %% cell 0
import os, sys, subprocess, json, hashlib, tempfile, urllib.request
from pathlib import Path
os.environ["TORCHDYNAMO_DISABLE"] = "1"
subprocess.run([sys.executable, "-m", "pip", "install", "--quiet",
    "transformers==5.3.0", "safetensors==0.8.0", "huggingface-hub==1.7.1",
    "tokenizers==0.22.2", "accelerate==1.13.0", "datasets", "numpy"], check=True)
# %% cell 1
from google.colab import drive
drive.mount("/content/drive", timeout_ms=900000)
ROOT = Path("/content/drive/MyDrive/ilaria/swypikos-en")
COLAB = ROOT / "colab-v7"
COMMIT = "cc688ddc90df6afc2d2ba42ed42f8f215727c550"  # public github.com/office233/ilaria
GITHUB_FILES = {
    "forge/train_tools.py": "a467ea3229ca98aa6554e0ed27b1c6326cd7e7a195d9524d5f719ab342fc8848",
    "forge/tool_data.py": "757665542e531c9e9aad2da8f4c023d324f29c5d9bc8cf6faa7c6c4255e8a6cd",
    "forge/bitnet_reference.py": "f5e580b729e07469871d9524fec35771208774bff0d32e462cef60155781162b",
    "forge/import_bitnet.py": "2c54a96a2725e07ba85d928928dc929ed812ebc1f36a886bc032d3b4859ab4b9",
    "forge/nxtf3.py": "bc463d5360ca2400739463ce922c386bfa056068877f2fcb2ca36f940177d580",
    "forge/multimodal/mm_model.py": "fcd32df48c2cba5cd153b99b7e63e6fc37680e3ea2f9001fc9842df7fb04337b",
    "forge/multimodal/lora_bitlinear.py": "a2330842eb10f853210cf8791de59718f1de11b7c91aa8b31f2697f7edf25321",
    "forge/prepare_corpus.py": "3373250012ed0ba001393ac95aa1a885f736d2e11dd4a8ef058e3528b159b385",
    "forge/colab/pilot_preflight.py": "32f68e194222c546aeca901cb2eeab07d6bd6043a05d9f881377aff5ace69ed0",
    "forge/hfmix/build_mix.py": "1f7440abf015cd9b6ce76fe3d8d0ad6d8c27e7dc42374e214c96b8096fff9005",
    "forge/hfmix/filter_length.py": "648c4a8567f07bac5ec936d62992c01f0c303560faef35e9761fe6fef6c602e1",
}
WORK = Path(tempfile.mkdtemp(prefix="ilaria-v8-", dir="/content"))
def _put(rel, data, want):
    got = hashlib.sha256(data).hexdigest()
    if got != want:
        raise RuntimeError(f"hash mismatch for {rel}: {got}")
    (WORK / rel).parent.mkdir(parents=True, exist_ok=True)
    (WORK / rel).write_bytes(data)
for rel, want in GITHUB_FILES.items():
    _put(rel, urllib.request.urlopen(f"https://raw.githubusercontent.com/office233/ilaria/{COMMIT}/{rel}", timeout=60).read(), want)
for pkg in ("forge", "forge/hfmix", "forge/colab"):
    (WORK / pkg / "__init__.py").touch()
bench = WORK / "bench" / "swypik-v1" / "tasks.jsonl"
bench.parent.mkdir(parents=True, exist_ok=True)
bench.write_bytes((COLAB / "swypik-v1-prompts.jsonl").read_bytes())
os.chdir(WORK)
sys.path.insert(0, str(WORK))
print("Verified sources in", WORK)
# %% cell 2
# The Hugging Face mix is built once (download + convert); later runs reuse it.
PARENT_DATA = ROOT / "datasets" / "hfmix-v1"
if not (PARENT_DATA / "manifest.json").exists():
    subprocess.run([sys.executable, "-u", "-m", "forge.hfmix.build_mix", "--out", str(PARENT_DATA),
        "--bench", str(bench), "--bench", str(COLAB / "v7-probes.jsonl"),
        "--extra-train", str(ROOT / "datasets" / "project-v6" / "train.jsonl")], cwd=WORK, check=True)
PARENT_MANIFEST = json.loads((PARENT_DATA / "manifest.json").read_text(encoding="utf-8"))
for split in ("train", "validation"):
    assert hashlib.sha256((PARENT_DATA / f"{split}.jsonl").read_bytes()).hexdigest() == PARENT_MANIFEST[split]["sha256"], split
print(json.dumps({k: PARENT_MANIFEST[k] for k in ("train", "validation", "rows_by_source")}, indent=2))
# %% cell 3
import torch
assert torch.cuda.is_available() and torch.cuda.is_bf16_supported(), "Select a BF16 GPU runtime"
subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv"], check=True)
from huggingface_hub import snapshot_download
from forge.colab.pilot_preflight import MODEL_ID, MODEL_REVISION, probe_adapter
MODEL = Path("/content/models") / MODEL_REVISION
snapshot_download(MODEL_ID, revision=MODEL_REVISION, local_dir=MODEL,
    allow_patterns=["*.json", "*.safetensors", "*.jinja", "*.model", "*.txt"])
os.environ["HF_HUB_OFFLINE"] = "1"
# Rows the trainer would refuse (over 2048 tokens) go out once, into a new folder.
DATA = ROOT / "datasets" / "hfmix-v1-len2048"
if not (DATA / "manifest.json").exists():
    subprocess.run([sys.executable, "-u", "-m", "forge.hfmix.filter_length", "--src", str(PARENT_DATA),
        "--dst", str(DATA), "--llm-dir", str(MODEL), "--max-tokens", "2048"], cwd=WORK, check=True)
MANIFEST = json.loads((DATA / "manifest.json").read_text(encoding="utf-8"))
for split in ("train", "validation"):
    assert hashlib.sha256((DATA / f"{split}.jsonl").read_bytes()).hexdigest() == MANIFEST[split]["sha256"], split
print(json.dumps({k: MANIFEST[k] for k in ("train", "validation")}, indent=2))
print("dropped:", MANIFEST["length_filter"]["dropped_total"], "rows over 2048 tokens")
PARENT = ROOT / "runs" / "project-v7-pilot-20260928-50steps" / "adapter-step50"
RUN_NAME = "hfmix-v8r3-1500steps"
RUN = ROOT / "runs" / RUN_NAME
REPORT = ROOT / "reviews" / RUN_NAME
assert not RUN.exists() or not any(RUN.iterdir()), "run directory not empty; choose a new RUN_NAME"
print("Model ready; parent adapter:", PARENT)
# %% cell 4
command = [sys.executable, "-u", "-m", "forge.train_tools",
    "--train", str(DATA / "train.jsonl"), "--validation", str(DATA / "validation.jsonl"),
    "--languages", ",".join(MANIFEST["languages"]), "--llm-dir", str(MODEL), "--out", str(RUN),
    "--init-adapter", str(PARENT), "--steps", "1500", "--lr", "0.0001", "--batch", "1", "--accum", "8",
    "--max-length", "2048", "--rank", "16", "--alpha", "32", "--seed", "42",
    "--checkpoint-every", "250", "--log-every", "25", "--max-runtime-minutes", "150", "--gradient-checkpointing"]
REPORT.mkdir(parents=True, exist_ok=True)
(REPORT / "training-command.json").write_text(json.dumps(command, indent=2), encoding="utf-8")
subprocess.run(command, cwd=WORK, check=True)
print("Training finished")
# %% cell 5
ckpt = torch.load(RUN / "checkpoint.pt", map_location="cpu", weights_only=True)
step = ckpt["step"]
del ckpt
PREFIX = RUN / f"adapter-step{step}"
PROBES = [json.loads(l) for l in (COLAB / "v7-probes.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
SYSTEM_PROMPT = __import__("forge.hfmix.build_mix", fromlist=["system_prompt"]).system_prompt()
out = REPORT / f"after-v8r3-step{step}-python.json"
probe_adapter(MODEL, PREFIX, SYSTEM_PROMPT, PROBES, out)
print("Probe answers written to", out, "— NOT promoted; compare with v5/v7 and run the Go gates.")
