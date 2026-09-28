"""Build the standalone Colab notebook that trains the Swyp Forge v1 LoRA.

    python forge/colab/build_swyp_forge_notebook.py            # write the notebook
    python forge/colab/build_swyp_forge_notebook.py --dry-run  # local CPU rehearsal, no GPU/Drive

The notebook embeds the trainer sources and forge/colab/swyp-forge-examples-v1
(each pinned by SHA-256), trains a fresh LoRA on the pinned BitNet b1.58 2B4T
base and writes the adapter to Drive. It never evaluates or promotes: the held-out
Swyp loop and tools_eval run locally in Go with -adapter (docs in the notebook).
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = "forge/colab/swyp-forge-examples-v1"
FILES = ("forge/train_tools.py", "forge/tool_data.py", "forge/bitnet_reference.py", "forge/import_bitnet.py",
         "forge/nxtf3.py", "forge/multimodal/mm_model.py", "forge/multimodal/lora_bitlinear.py",
         f"{DATA}/train.jsonl", f"{DATA}/validation.jsonl", f"{DATA}/manifest.json")
MODEL_ID = "microsoft/bitnet-b1.58-2B-4T"
MODEL_REVISION = "04c3b9ad9361b824064a1f25ea60a8be9599b127"
RUN_NAME = "swyp-forge-v1-105steps"
# 279 train rows / (batch 1 x accum 8) = ~35 optimizer steps per epoch: 3 epochs.
SETTINGS = {"steps": 105, "lr": 0.0001, "batch": 1, "accum": 8, "max_length": 2048, "rank": 16, "alpha": 32,
            "seed": 42, "checkpoint_every": 35, "log_every": 5, "max_runtime_minutes": 60}
OUTPUT = ROOT / "forge/colab/Ilaria_SwypForge_V1.ipynb"


def sources():
    out = {}
    for name in FILES:
        text = (ROOT / name).read_bytes().decode("utf-8")
        if "\r" in text:
            raise ValueError(f"{name} has CR line endings")
        if name.endswith(".py"):
            ast.parse(text, filename=name)
        out[name] = text
    manifest = json.loads(out[f"{DATA}/manifest.json"])
    for split in ("train", "validation"):
        digest = hashlib.sha256(out[f"{DATA}/{split}.jsonl"].encode("utf-8")).hexdigest()
        if digest != manifest["files"][split]["sha256"]:
            raise ValueError(f"{split}.jsonl does not match its manifest")
    return out


def training_command(work, model, run):
    cmd = [sys.executable, "-u", "-m", "forge.train_tools", "--train", str(Path(work) / DATA / "train.jsonl"),
           "--validation", str(Path(work) / DATA / "validation.jsonl"), "--languages", "en",
           "--llm-dir", str(model), "--out", str(run), "--gradient-checkpointing"]
    for k, v in SETTINGS.items():
        cmd += ["--" + k.replace("_", "-"), str(v)]
    return cmd


def build():
    src = sources()
    hashes = {k: hashlib.sha256(v.encode("utf-8")).hexdigest() for k, v in src.items()}
    cells = []

    def md(text):
        cells.append({"cell_type": "markdown", "metadata": {}, "source": textwrap.dedent(text).strip()})

    def code(text):
        text = textwrap.dedent(text).strip()
        ast.parse(text)
        cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": text})

    md(f'''
    # Ilaria Swyp Forge v1: LoRA for verified Swyp code and repair
    Fresh LoRA (r16/a32) on BitNet b1.58 2B4T `{MODEL_REVISION[:12]}`, {SETTINGS["steps"]} steps at lr {SETTINGS["lr"]}.
    Data: `{DATA}` (279 train / 37 validation rows). Every assistant answer was verified
    `exhaustive` by `swyp judge`; every repair prompt quotes the judge's own counterexample or error.
    Held-out tasks were never used. **Not evaluated or promoted here.**

    Select a BF16 GPU runtime (H100, A100 or G4) and run the cells in order. The training cell
    uses compute units. Output: `MyDrive/ilaria/swypikos-en/runs/{RUN_NAME}`.
    ''')
    code('''
    import os, sys, subprocess, json, hashlib, platform, tempfile
    from pathlib import Path
    os.environ["TORCHDYNAMO_DISABLE"] = "1"
    subprocess.run([sys.executable, "-m", "pip", "install", "--quiet",
        "transformers==5.3.0", "safetensors==0.8.0", "huggingface-hub==1.7.1",
        "tokenizers==0.22.2", "accelerate==1.13.0", "numpy"], check=True)
    ''')
    code("SOURCES = " + repr(src) + "\nSOURCE_SHA256 = " + repr(hashes) + "\nSETTINGS = " + repr(SETTINGS) +
         "\n" + textwrap.dedent('''
    if any(n == "forge" or n.startswith("forge.") for n in sys.modules):
        raise RuntimeError("Restart the Colab session before running this standalone notebook")
    WORK = Path(tempfile.mkdtemp(prefix="ilaria-swyp-forge-", dir="/content"))
    for rel, text in SOURCES.items():
        data = text.encode("utf-8")
        if hashlib.sha256(data).hexdigest() != SOURCE_SHA256[rel]:
            raise RuntimeError("embedded file changed: " + rel)
        (WORK / rel).parent.mkdir(parents=True, exist_ok=True)
        (WORK / rel).write_bytes(data)
    (WORK / "forge" / "__init__.py").touch()
    os.chdir(WORK)
    sys.path.insert(0, str(WORK))
    subprocess.run([sys.executable, "-m", "forge.train_tools", "--validate-only", "--languages", "en",
        "--train", "''' + DATA + '''/train.jsonl", "--validation", "''' + DATA + '''/validation.jsonl",
        "--llm-dir", "unused", "--out", "unused"], cwd=WORK, check=True)
    print("Verified", len(SOURCES), "embedded files in", WORK)
    '''))
    code(f'''
    from google.colab import drive
    drive.mount("/content/drive")
    ROOT = Path("/content/drive/MyDrive/ilaria/swypikos-en")
    RUN = ROOT / "runs" / "{RUN_NAME}"
    REPORT = ROOT / "reviews" / "{RUN_NAME}"
    if RUN.exists() and any(RUN.iterdir()):
        raise RuntimeError("Run directory is not empty; keep it and choose a new RUN name")
    import torch
    if not (torch.cuda.is_available() and torch.cuda.is_bf16_supported()):
        raise RuntimeError("Select a BF16 CUDA runtime")
    subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv"], check=True)
    from huggingface_hub import snapshot_download
    MODEL = Path("/content/models") / "{MODEL_REVISION}"
    snapshot_download("{MODEL_ID}", revision="{MODEL_REVISION}", local_dir=MODEL,
        allow_patterns=["*.json", "*.safetensors", "*.jinja", "*.model", "*.txt"])
    os.environ["HF_HUB_OFFLINE"] = "1"
    REPORT.mkdir(parents=True, exist_ok=True)
    (REPORT / "environment.json").write_text(json.dumps({{"python": platform.python_version(),
        "torch": torch.__version__, "gpu": torch.cuda.get_device_name(0), "sources_sha256": SOURCE_SHA256,
        "settings": SETTINGS}}, indent=2), encoding="utf-8")
    print("Model ready:", MODEL)
    ''')
    md("## Train (uses GPU compute units)")
    code('''
    command = [sys.executable, "-u", "-m", "forge.train_tools", "--train", str(WORK / "''' + DATA + '''/train.jsonl"),
        "--validation", str(WORK / "''' + DATA + '''/validation.jsonl"), "--languages", "en",
        "--llm-dir", str(MODEL), "--out", str(RUN), "--gradient-checkpointing"]
    for key, value in SETTINGS.items():
        command += ["--" + key.replace("_", "-"), str(value)]
    (REPORT / "training-command.json").write_text(json.dumps(command, indent=2), encoding="utf-8")
    subprocess.run(command, cwd=WORK, check=True)
    print("Trainer exited; the next cell checks what was actually saved.")
    ''')
    code('''
    from safetensors import safe_open
    ckpt = torch.load(RUN / "checkpoint.pt", map_location="cpu", weights_only=True)
    step = ckpt["step"]
    PREFIX = RUN / f"adapter-step{step}"
    meta = json.loads(Path(str(PREFIX) + ".json").read_text(encoding="utf-8"))
    if meta["contract"]["smoke"] or meta["lora"] != {"r": 16, "alpha": 32, "scaling": 2.0, "n_modules": 210}:
        raise RuntimeError("unexpected adapter: " + json.dumps(meta["lora"]))
    with safe_open(str(PREFIX) + ".safetensors", framework="pt", device="cpu") as w:
        for key in w.keys():
            if not bool(torch.isfinite(w.get_tensor(key)).all()):
                raise RuntimeError("non-finite tensor " + key)
    sha = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (Path(str(PREFIX) + ".json"), Path(str(PREFIX) + ".safetensors"))}
    status = {"step": step, "target_steps": SETTINGS["steps"], "complete": step == SETTINGS["steps"],
              "baseline_validation_loss": json.loads((RUN / "baseline.json").read_text()),
              "final_validation_loss": meta["validation_assistant_loss"], "sha256": sha, "promoted": False}
    (REPORT / "status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
    print(json.dumps(status, indent=2))
    print("Download", PREFIX.name + ".json and .safetensors, then run the held-out Swyp loop and tools_eval in Go.")
    ''')
    for i, cell in enumerate(cells):
        cell["id"] = f"sf1-{i:02d}"
    return {"nbformat": 4, "nbformat_minor": 5, "metadata": {
        "accelerator": "GPU", "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python"}, "colab": {"name": OUTPUT.name}}, "cells": cells}


def dry_run():
    """Replay the notebook's file checks and data validation, then 2 CPU smoke steps on the real data."""
    src = sources()
    with tempfile.TemporaryDirectory(prefix="swyp-forge-dry-") as tmp:
        work = Path(tmp)
        for rel, text in src.items():
            (work / rel).parent.mkdir(parents=True, exist_ok=True)
            (work / rel).write_bytes(text.encode("utf-8"))
        (work / "forge" / "__init__.py").touch()
        run = lambda extra: subprocess.run([sys.executable, "-m", "forge.train_tools", "--languages", "en",
                                            "--train", str(work / DATA / "train.jsonl"),
                                            "--validation", str(work / DATA / "validation.jsonl")] + extra,
                                           cwd=work, check=True, capture_output=True, text=True)
        print(run(["--validate-only", "--llm-dir", "unused", "--out", "unused"]).stdout.strip())
        out = run(["--smoke", "--llm-dir", "unused-smoke-model", "--out", str(work / "run"), "--steps", "2",
                   "--accum", "1", "--rank", "2", "--alpha", "4", "--max-length", "2048"])
        meta = json.loads((work / "run" / "adapter-step2.json").read_text(encoding="utf-8"))
        print("smoke adapter-step2 exported; validation loss", meta["validation_assistant_loss"])
        cmd = training_command("/content/WORK", "/content/models/REV", "/content/drive/RUN")
        print("production command:", " ".join(cmd[3:]))
        return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if a.dry_run:
        dry_run()
        return
    text = json.dumps(build(), indent=1, ensure_ascii=False) + "\n"
    if OUTPUT.exists() and OUTPUT.read_bytes().decode("utf-8") != text:
        raise FileExistsError(f"{OUTPUT} exists with different content; keep it and bump the version")
    OUTPUT.write_bytes(text.encode("utf-8"))
    print(f"Built {OUTPUT} ({len(text)} bytes, sha256 {hashlib.sha256(text.encode()).hexdigest()})")


if __name__ == "__main__":
    main()
