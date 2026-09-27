"""Build a self-contained Colab notebook from an explicit source allowlist.

No model weights, datasets, credentials, or unrelated repository files included.
Run from the repository root: python forge/colab/build_swypikos_notebook.py
"""
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import textwrap

ROOT = Path(__file__).resolve().parents[2]
FILES = [
    "forge/train_tools.py", "forge/tool_data.py", "forge/bitnet_reference.py",
    "forge/import_bitnet.py", "forge/nxtf3.py", "forge/multimodal/mm_model.py",
    "forge/multimodal/lora_bitlinear.py", "forge/test_tool_data.py",
    "forge/test_train_tools.py", "forge/test_distributed_tools.py",
]


def build():
    sources = {name: (ROOT / name).read_text(encoding="utf-8") for name in FILES}
    prompt = subprocess.check_output(["go", "run", "./cmd/ilaria-serve", "-print-system-prompt"], cwd=ROOT).decode("utf-8")
    cells = []

    def md(source):
        cells.append({"cell_type": "markdown", "metadata": {}, "source": textwrap.dedent(source).strip()})

    def code(source):
        source = textwrap.dedent(source).strip()
        ast.parse(source)
        cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": source})

    md('''
    # Ilaria for SwypikOS — English H100 pilot
    This notebook contains the reviewed local trainer, not a checkout of an older GitHub branch.
    It trains LoRA adapters against the frozen offline BitNet base used by the Go engine.
    **Goal:** measurable improvement on held-out SwypikOS tasks. This is not evidence of
    frontier-model superiority or multilingual mastery.

    Run cells individually. Select an H100 runtime. Start with preflight and tests, then
    curated English data and a 50-step pilot. The training cell is disabled until
    `RUN_PILOT=True`. No private dataset or model weight is embedded here.
    ''')
    code('''
    import os, sys, subprocess, json, hashlib, platform
    from pathlib import Path
    os.environ["TORCHDYNAMO_DISABLE"] = "1"
    subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv"], check=True)
    import torch
    assert torch.cuda.is_available(), "Select a GPU runtime first."
    print({"python": platform.python_version(), "torch": torch.__version__, "gpu": torch.cuda.get_device_name(0)})
    assert torch.cuda.is_bf16_supported(), "This pilot expects BF16 support."
    ''')
    code('''
    # Keep Colab's vendor-provided CUDA/PyTorch installation. Pin the tested Python API surface.
    subprocess.run([sys.executable, "-m", "pip", "install", "--quiet",
        "transformers==5.3.0", "safetensors==0.8.0", "huggingface-hub==1.7.1",
        "tokenizers==0.22.2", "accelerate==1.13.0", "numpy"], check=True)
    ''')
    bootstrap = 'SOURCES = ' + repr(sources) + '\nSYSTEM_PROMPT = ' + repr(prompt) + '\n'
    bootstrap += textwrap.dedent('''
    WORK = Path("/content/ilaria-swypikos")
    WORK.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for relative, content in SOURCES.items():
        target = WORK / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        manifest[relative] = hashlib.sha256(content.encode("utf-8")).hexdigest()
    (WORK / "system_prompt.txt").write_text(SYSTEM_PROMPT, encoding="utf-8")
    (WORK / "source_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    os.chdir(WORK)
    print("Source bundle verified:", len(manifest), "files")
    ''')
    code(bootstrap)
    code('''
    # Tiny random CPU models only: confirm the installed training API before loading real weights.
    subprocess.run([sys.executable, "-m", "unittest", "forge.test_tool_data",
        "forge.test_train_tools", "forge.test_distributed_tools"], check=True, cwd=WORK)
    ''')
    md('''
    ## Persistent storage and curated data
    Mount your own Google Drive interactively. Use a new run directory; existing runs are
    never overwritten. Put `train.jsonl` and `validation.jsonl` under
    `MyDrive/ilaria/swypikos-en/datasets/v1/`.

    Each row needs `language: "en"`, a stable `task_id`, and `messages` using roles
    system/user/assistant/tool. Use the exact `SYSTEM_PROMPT` above. Tool observations
    must come from real execution. Keep paraphrases and translations of one task in
    one split. Include tool errors, recovery, direct answers and clarification.
    Do not use this held-out validation split as training data or repeatedly tune to a final benchmark.
    ''')
    code('''
    from google.colab import drive
    drive.mount("/content/drive")
    ROOT = Path("/content/drive/MyDrive/ilaria/swypikos-en")
    TRAIN = ROOT / "datasets/v1/train.jsonl"
    VALIDATION = ROOT / "datasets/v1/validation.jsonl"
    RUN = ROOT / "runs/h100-pilot-v1"
    RESUME = False
    RUN_PILOT = False
    ''')
    code('''
    # Read-only metadata audit of Claude's existing multimodal adapter. Do not overwrite it.
    existing = Path("/content/drive/MyDrive/ilaria/stage2_instruct/stage2_export.json")
    if existing.is_file():
        metadata = json.loads(existing.read_text())
        print({"existing_stage2_step": metadata.get("source_step"),
               "base": metadata.get("base"), "lora": metadata.get("lora")})
    else:
        print("Existing Stage 2 metadata not found at the expected Drive path.")
    ''')
    code('''
    # Fail before downloading a model or consuming training time if data is missing/invalid.
    assert TRAIN.is_file() and VALIDATION.is_file(), "Curate and supply both JSONL files first."
    sys.path.insert(0, str(WORK))
    from forge.tool_data import load_trajectories, validate_splits
    train_rows, val_rows = load_trajectories(TRAIN), load_trajectories(VALIDATION)
    print(validate_splits(train_rows, val_rows))
    for row in train_rows + val_rows:
        assert row.get("task_id"), "Assign task IDs before splitting."
        assert row["messages"][0]["content"].strip() == SYSTEM_PROMPT.strip(), "Serving prompt mismatch"
    ''')
    md('''
    ## Frozen base download
    Only official public weights/config/tokenizer files are downloaded from Microsoft on
    Hugging Face. No remote Python model code is executed. The resolved immutable revision
    is saved before training; restarting uses the same revision. This custom LoRA path
    keeps the offline base frozen to match Go inference. Full-base fine-tuning would require
    the BF16 master weights and a separately validated base export.
    ''')
    code('''
    from huggingface_hub import HfApi, snapshot_download
    MODEL_ID = "microsoft/bitnet-b1.58-2B-4T"
    ROOT.mkdir(parents=True, exist_ok=True)
    revision_file = ROOT / "base_revision.txt"
    revision = revision_file.read_text().strip() if revision_file.exists() else HfApi().model_info(MODEL_ID).sha
    revision_file.write_text(revision, encoding="utf-8")
    MODEL = Path("/content/models") / revision
    snapshot_download(MODEL_ID, revision=revision, local_dir=MODEL,
        allow_patterns=["*.json", "*.safetensors", "*.jinja", "*.model", "*.txt"])
    print({"model": MODEL_ID, "revision": revision, "path": str(MODEL)})
    ''')
    code('''
    if not RUN_PILOT:
        print("Pilot disabled. Review data and set RUN_PILOT=True in the configuration cell to start.")
    else:
        args = [sys.executable, "-u", "-m", "forge.train_tools",
            "--train", str(TRAIN), "--validation", str(VALIDATION), "--llm-dir", str(MODEL),
            "--out", str(RUN), "--languages", "en", "--steps", "50", "--batch", "1",
            "--accum", "8", "--max-length", "2048", "--rank", "16", "--alpha", "32",
            "--lr", "0.0001", "--gradient-checkpointing", "--checkpoint-every", "10",
            "--log-every", "1", "--max-runtime-minutes", "20"]
        if RESUME:
            args.append("--resume")
        subprocess.run(args, check=True, cwd=WORK)
        environment = subprocess.check_output([sys.executable, "-m", "pip", "freeze"], text=True)
        (RUN / "environment.txt").write_text(environment, encoding="utf-8")
        (RUN / "source_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        (RUN / "base_revision.txt").write_text(revision, encoding="utf-8")
    ''')
    md('''
    ## Evaluate and decide before scaling
    Drive audit found Claude's separate multimodal Stage 2 export at step 6000
    (rank 16, 210 modules). Preserve and benchmark it separately. This text pilot
    starts from the frozen language base; it does not silently resume that multimodal
    checkpoint or replace its projector. Compare both candidates before selecting
    the next training starting point.

    The trainer records a pre-training validation-loss baseline, per-language validation
    loss, step timing, peak GPU allocation, and step-named adapter exports. Its time limit
    is soft: model load, baseline, the current step, validation and checkpoint I/O take
    additional time. Colab may disconnect; Drive checkpoints allow resuming.

    **Do not promote an adapter based only on lower loss.** Compare the base and adapter on
    the same untouched executed tasks in the Go tool loop: successful actions, correct
    answers, false success claims, regression cases, latency. Download a matching
    `adapter-stepN.json` and `.safetensors` pair, then use `ilaria-serve -adapter PREFIX`.

    ### Eight H200 GPUs — later, after the pilot
    Pre-stage identical sources, pinned base, datasets and persistent output storage.
    Verify all GPUs and NCCL, then measure a short distributed run before budgeting steps.
    Use `torchrun --standalone --nproc_per_node=8 forge/train_tools.py ...` with the same
    validated flags and a new run directory. For a one-hour reservation, leave generous
    setup/save margin; a 40-minute loop budget is an initial ceiling, not a guarantee.
    The trainer requires the same world size for exact resume: a one-GPU checkpoint is
    **not** an eight-GPU resume. DDP replicates the full base on every GPU.

    References: [official BitNet model card](https://huggingface.co/microsoft/bitnet-b1.58-2B-4T),
    [Colab resource/availability FAQ](https://research.google.com/colaboratory/faq.html).
    ''')
    notebook = {"nbformat": 4, "nbformat_minor": 5, "metadata": {
        "colab": {"name": "Ilaria_SwypikOS_H100_Pilot.ipynb"},
        "kernelspec": {"display_name": "Python 3", "name": "python3"},
        "language_info": {"name": "python"}, "accelerator": "GPU"}, "cells": cells}
    for i, cell in enumerate(cells):
        cell["id"] = f"ilaria-{i:02d}"
    target = ROOT / "forge/colab/Ilaria_SwypikOS_H100_Pilot.ipynb"
    target.write_text(json.dumps(notebook, ensure_ascii=False, indent=2), encoding="utf-8")
    print(target)


if __name__ == "__main__":
    build()
