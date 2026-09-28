"""Build a standalone, source-allowlisted Colab pilot without reading local data/.

Run from the checkout: python forge/colab/build_project_pilot_v7.py
This builds a notebook; it does not train, access Drive or install packages.
"""
from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
import subprocess
import textwrap

ROOT = Path(__file__).resolve().parents[2]
FILES = (
    "forge/train_tools.py", "forge/tool_data.py", "forge/bitnet_reference.py",
    "forge/import_bitnet.py", "forge/nxtf3.py", "forge/multimodal/mm_model.py",
    "forge/multimodal/lora_bitlinear.py", "forge/test_tool_data.py",
    "forge/test_train_tools.py", "forge/test_distributed_tools.py",
    "forge/colab/pilot_preflight.py",
)
PROBES = [
    {"id": "v7-date", "prompt": "Write two sentences announcing that the rooftop tour is postponed. The organizers have not chosen another date.", "rubric": "Two sentences; preserve postponement; invent no replacement date."},
    {"id": "v7-price", "prompt": "Announce the release of a compact reading light. Evidence supplied: it is available now. No price, discount or shipping information was supplied.", "rubric": "Announce only supplied facts; invent no price, discount or shipping promise."},
    {"id": "v7-units", "prompt": "Convert 47 to kilometers. What information do you need from me?", "rubric": "Ask for the source unit; do not assume meters or call conversion with a fabricated unit."},
    {"id": "v7-subject", "prompt": "Return only an email subject line announcing a temporary closure of the pottery workshop. No reopening date is available.", "rubric": "Only a subject line; no invented reopening date."},
    {"id": "v7-draft", "prompt": "Draft a brief email to support requesting a replacement for a damaged desk clock. I have not provided an order number or purchase date.", "rubric": "Produce a useful draft; invent no order number or date and claim no email was sent."},
    {"id": "v7-unconfirmed", "prompt": "Evidence: the upload service returned a timeout and no receipt. Has the upload definitely finished?", "rubric": "Completion is unconfirmed; a timeout proves neither success nor definite failure."},
    {"id": "v7-budget", "prompt": "Evidence: a synthesis search examined 720 candidates and reached its limit without a match. Is that a proof that no valid program exists?", "rubric": "No; bounded search failure is not a universal impossibility proof."},
    {"id": "v7-positive", "prompt": "Evidence: a candidate compiled and produced the correct outputs on nine independent test inputs. Which checks actually passed, and what is still unproven?", "rubric": "Compilation and those nine behavioral checks passed; correctness on all inputs is not proven."},
    {"id": "v7-contract", "prompt": "Evidence: the server requires Name/Describe/Call. The current plugin implements only Name/Match/Execute. Explain the remaining integration work in one sentence.", "rubric": "A compatible chat wrapper and registration are needed; do not claim compatibility already exists."},
    {"id": "v7-affine", "prompt": "Swyp syntax: fn predict(x: number) -> number { return expression; }. Return only a complete program implementing y = 37*x + 11, including fn main() { print(predict(arg(0))); }.", "rubric": "Actual Swyp compile and runtime checks required; preserve predict and main names."},
    {"id": "v7-negative", "prompt": "In Swyp, write fn predict(x: number) -> number returning -x, and fn main() calling print(predict(arg(0))); return code only. Do not rename predict.", "rubric": "Use predict exactly; negate the argument; requires actual compiler and unseen-input checks."},
    {"id": "v7-constant", "prompt": "Return only Swyp code with fn predict(x: number) -> number returning 73 for every input and fn main() { print(predict(arg(0))); }.", "rubric": "Constant 73 and required function names; requires actual compiler and runtime checks."},
]


def build(root: Path = ROOT) -> dict:
    sources = {name: (root / name).read_text(encoding="utf-8").replace("\r\n", "\n") for name in FILES}
    for name, source in sources.items():
        ast.parse(source, filename=name)
    prompt = subprocess.check_output(
        ["go", "run", "./cmd/ilaria-serve", "-print-system-prompt"], cwd=root
    ).decode("utf-8").replace("\r\n", "\n").strip()
    if not prompt:
        raise ValueError("The live Go serving prompt is empty")
    cells = []

    def md(text):
        cells.append({"cell_type": "markdown", "metadata": {}, "source": textwrap.dedent(text).strip()})

    def code(text):
        text = textwrap.dedent(text).strip()
        ast.parse(text)
        cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": text})

    md('''
    # Ilaria project v7: isolated 50-step development pilot
    **Not trained or promoted yet.** Continue from verified drafting v5, not experimental v6.
    Reuse the reviewed English v6 corpus (1081/256 rows). This is a conservative
    learning-rate/step-count experiment, not a demonstrated fix or a new dataset.

    Select an available BF16 CUDA runtime and run cells in order. The training cell
    starts 50 steps at 2e-5 with checkpoint exports every 10 steps. The 15-minute
    limit covers the training loop only; installation, downloading, evaluation and
    saving add time. Hardware, speed and compute-unit consumption are not guaranteed.
    No subscriptions are purchased, no service is deployed, and no old runs are replaced.

    Requires existing Drive v5 parent and `datasets/project-v6/{train,validation}.jsonl`
    plus `manifest.json`. Only explicit trainer/test source files are embedded, no
    weights, repository data, credentials or archives. A missing prerequisite stops
    execution rather than silently creating another corpus. Keep existing checkpoints.

    The 12 frozen probes below are a small development set, not an independent benchmark.
    Python generates raw answers without executing tools or scoring code. Promotion
    still requires the historical English/tool regressions and real Swyp tests in Go.
    ''')
    code('''
    import os, sys, subprocess, json, hashlib, platform
    from pathlib import Path
    os.environ["TORCHDYNAMO_DISABLE"] = "1"
    # Retain Colab's vendor CUDA/PyTorch. Keep the historical working Python API pins.
    subprocess.run([sys.executable, "-m", "pip", "install", "--quiet",
        "transformers==5.3.0", "safetensors==0.8.0", "huggingface-hub==1.7.1",
        "tokenizers==0.22.2", "accelerate==1.13.0", "numpy"], check=True)
    ''')
    code("SOURCES = " + repr(sources) + "\nSYSTEM_PROMPT = " + repr(prompt) + "\nPROBES = " + repr(PROBES) + "\n" + textwrap.dedent('''
    # An isolated session workdir prevents stale imports from previous notebooks.
    import tempfile
    WORK = Path(tempfile.mkdtemp(prefix="ilaria-v7-", dir="/content"))
    SOURCE_HASHES = {}
    for relative, content in SOURCES.items():
        target = WORK / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline=chr(10))
        SOURCE_HASHES[relative] = hashlib.sha256(target.read_bytes()).hexdigest()
    os.chdir(WORK)
    sys.path.insert(0, str(WORK))
    # Refuse stale forge modules; never silently reuse imports from another checkout.
    if any(name == "forge" or name.startswith("forge.") for name in sys.modules):
        raise RuntimeError("Restart the Colab session before running this standalone notebook")
    from forge.colab.pilot_preflight import (MODEL_ID, MODEL_REVISION, PARENT_NAME, PARENT_HASHES,
        SETTINGS, check_inputs, require, sha256_file, write_new_json, training_command, probe_adapter)
    print("Current source bundle:", len(SOURCE_HASHES), "files", WORK)
    '''))
    code('''
    # Actual tiny CPU training/export/interruption/resume tests, not production training.
    subprocess.run([sys.executable, "-m", "unittest", "forge.test_tool_data",
        "forge.test_train_tools", "forge.test_distributed_tools"], cwd=WORK, check=True)
    ''')
    code('''
    from google.colab import drive
    drive.mount("/content/drive")
    ROOT = Path("/content/drive/MyDrive/ilaria/swypikos-en")
    RUN_NAME = "project-v7-pilot-20260928-50steps"
    RUN = ROOT / "runs" / RUN_NAME
    REPORT = ROOT / "reviews" / RUN_NAME
    require(not REPORT.exists(), "Review directory already exists; preserve it and choose a new RUN_NAME")
    # Check historical inputs before downloading or allocating the production model.
    check_inputs(ROOT, WORK, RUN_NAME, SOURCE_HASHES, SYSTEM_PROMPT, PROBES)
    import torch
    require(torch.cuda.is_available(), "Select a CUDA GPU runtime")
    require(torch.cuda.is_bf16_supported(), "This pilot requires native BF16 support")
    subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,memory.free", "--format=csv"], check=True)
    from huggingface_hub import snapshot_download
    MODEL = Path("/content/models") / MODEL_REVISION
    snapshot_download(MODEL_ID, revision=MODEL_REVISION, local_dir=MODEL,
        allow_patterns=["*.json", "*.safetensors", "*.jinja", "*.model", "*.txt"])
    os.environ["HF_HUB_OFFLINE"] = "1"
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(str(MODEL), local_files_only=True)
    PREFLIGHT = check_inputs(ROOT, WORK, RUN_NAME, SOURCE_HASHES, SYSTEM_PROMPT, PROBES, tokenizer)
    REPORT.mkdir(parents=True, exist_ok=False)
    write_new_json(REPORT / "preflight.json", PREFLIGHT)
    write_new_json(REPORT / "frozen-probes.json", PROBES)
    write_new_json(REPORT / "environment.json", {"python": platform.python_version(),
        "torch": torch.__version__, "cuda": torch.version.cuda, "gpu": torch.cuda.get_device_name(0),
        "pip_freeze": subprocess.check_output([sys.executable, "-m", "pip", "freeze"], text=True)})
    print(json.dumps(PREFLIGHT, indent=2))
    ''')
    code('''
    # Freeze the real v5 baseline with exactly the candidate's Python decoding settings.
    BASELINE_HASH = probe_adapter(MODEL, ROOT / "runs" / PARENT_NAME,
        SYSTEM_PROMPT, PROBES, REPORT / "before-v5-python.json")
    write_new_json(REPORT / "baseline-sha256.json", {"before-v5-python.json": BASELINE_HASH})
    print("V5 baseline recorded. No candidate training has run yet.")
    ''')
    md('''
    ## Start the bounded pilot
    This cell consumes runtime compute. It rechecks all inputs and requires the frozen
    v5 baseline. Never change the old v5/v6 outputs or use this notebook to resume them.
    On interruption, preserve the new checkpoints; automatic resume is deliberately
    not enabled here. The trainer supports explicit contract-matching resume separately.
    ''')
    code('''
    require(check_inputs(ROOT, WORK, RUN_NAME, SOURCE_HASHES, SYSTEM_PROMPT, PROBES, tokenizer) == PREFLIGHT,
            "Inputs changed after the baseline; stop and review")
    require(sha256_file(REPORT / "before-v5-python.json") == BASELINE_HASH, "Baseline changed")
    command = training_command(ROOT, MODEL, RUN_NAME)
    write_new_json(REPORT / "training-command.json", command)
    subprocess.run(command, cwd=WORK, check=True)
    print("Trainer exited successfully; verify the actual saved step next.")
    ''')
    code('''
    from safetensors import safe_open
    # Restricted loading of this run's own checkpoint; never load arbitrary uploaded PT files.
    checkpoint = torch.load(RUN / "checkpoint.pt", map_location="cpu", weights_only=True)
    step = checkpoint["step"]
    require(isinstance(step, int) and 1 <= step <= SETTINGS["steps"], "Invalid saved step")
    PREFIX = RUN / f"adapter-step{step}"
    metadata = json.loads(Path(str(PREFIX) + ".json").read_text(encoding="utf-8"))
    contract = metadata["contract"]
    require(contract == checkpoint["contract"], "Checkpoint/export contract mismatch")
    require(contract["encoding_version"] == PREFLIGHT["encoding_version"], "Encoding mismatch")
    require(not contract["smoke"] and contract["world_size"] == 1, "Not the requested single-GPU production-base pilot")
    require(contract["initial_adapter"] == {"weights_sha256": PARENT_HASHES["safetensors"],
        "metadata_sha256": PARENT_HASHES["json"]}, "Parent lineage mismatch")
    for key in ("steps", "batch", "accum", "max_length", "rank", "alpha", "lr", "seed"):
        require(contract[key] == SETTINGS[key], f"Training setting mismatch: {key}")
    require(metadata["base"]["kind"] == "offline", "Unexpected base kind")
    require(metadata["lora"] == {"r": 16, "alpha": 32, "scaling": 2.0, "n_modules": 210}, "Unexpected adapter shape")
    with safe_open(str(PREFIX) + ".safetensors", framework="pt", device="cpu") as weights:
        require(len(list(weights.keys())) == 420, "Expected 420 adapter tensors")
        for key in weights.keys():
            require(bool(torch.isfinite(weights.get_tensor(key)).all()), "Nonfinite export: " + key)
    artifact_hashes = {path.name: sha256_file(path) for path in
        (RUN / "checkpoint.pt", Path(str(PREFIX) + ".json"), Path(str(PREFIX) + ".safetensors"))}
    del checkpoint
    write_new_json(REPORT / "artifacts.json", {"step": step, "target_steps": SETTINGS["steps"],
        "training_horizon_complete": step == SETTINGS["steps"], "sha256": artifact_hashes})
    print("Verified actual saved step:", step, "of", SETTINGS["steps"])
    ''')
    code('''
    candidate_hash = probe_adapter(MODEL, PREFIX, SYSTEM_PROMPT, PROBES, REPORT / "after-v7-python.json")
    write_new_json(REPORT / "status.json", {"step": step, "target_steps": SETTINGS["steps"],
        "training_horizon_complete": step == SETTINGS["steps"], "promoted": False,
        "before_sha256": BASELINE_HASH, "after_sha256": candidate_hash,
        "python_only": True, "tools_executed": False, "go_regression_evaluation_required": True})
    print("Python before/after recorded in", REPORT)
    print("NOT PROMOTED. Run the historical English/tool suite and actual Swyp compiler/runtime checks in Go.")
    ''')
    for i, cell in enumerate(cells):
        cell["id"] = f"v7-{i:02d}"
    return {"nbformat": 4, "nbformat_minor": 5, "metadata": {
        "accelerator": "GPU", "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python"}, "colab": {"name": "Ilaria_Project_V7_Pilot.ipynb"}}, "cells": cells}


def main():
    notebook = build()
    output = ROOT / "forge/colab/Ilaria_Project_V7_Pilot.ipynb"
    text = json.dumps(notebook, indent=2, ensure_ascii=False) + "\n"
    if output.exists():
        if output.read_text(encoding="utf-8") != text:
            raise FileExistsError("Notebook exists with different content; preserve it before rebuilding")
    else:
        with output.open("x", encoding="utf-8", newline="\n") as destination:
            destination.write(text)
    print(f"Built {output}: {len(notebook['cells'])} cells; SHA256 {hashlib.sha256(text.encode()).hexdigest()}")


if __name__ == "__main__":
    main()
