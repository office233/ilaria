# v8 r4 training cell: run after cells 0-3 of v8_cells.r3.py in the same Colab kernel.
# Uses the 96 GB card: 4 sequences per forward pass, no gradient checkpointing, and the same
# effective batch (4 x 2 = 8 sequences per step) as r3's 1 x 8. The trainer's log is written
# to reviews/<run>/train.log on Drive so speed and peak memory can be read while it runs.
import subprocess, sys, json, os, torch
RUN_NAME = "hfmix-v8r4-1500steps-b4"
RUN = ROOT / "runs" / RUN_NAME
REPORT = ROOT / "reviews" / RUN_NAME
assert not RUN.exists() or not any(RUN.iterdir()), "run directory not empty; choose a new RUN_NAME"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
command = [sys.executable, "-u", "-m", "forge.train_tools",
    "--train", str(DATA / "train.jsonl"), "--validation", str(DATA / "validation.jsonl"),
    "--languages", ",".join(MANIFEST["languages"]), "--llm-dir", str(MODEL), "--out", str(RUN),
    "--init-adapter", str(PARENT), "--steps", "1500", "--lr", "0.0001", "--batch", "4", "--accum", "2",
    "--max-length", "2048", "--rank", "16", "--alpha", "32", "--seed", "42",
    "--checkpoint-every", "250", "--log-every", "10", "--max-runtime-minutes", "150"]
REPORT.mkdir(parents=True, exist_ok=True)
(REPORT / "training-command.json").write_text(json.dumps(command, indent=2), encoding="utf-8")
with open(REPORT / "train.log", "w", encoding="utf-8", buffering=1) as log:
    proc = subprocess.Popen(command, cwd=WORK, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        log.write(line)
        print(line, end="", flush=True)
    if proc.wait() != 0:
        raise RuntimeError(f"training failed with exit code {proc.returncode}; see {REPORT / 'train.log'}")
print("Training finished")
ckpt = torch.load(RUN / "checkpoint.pt", map_location="cpu", weights_only=True)
step = ckpt["step"]
del ckpt
PREFIX = RUN / f"adapter-step{step}"
PROBES = [json.loads(l) for l in (COLAB / "v7-probes.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
SYSTEM_PROMPT = __import__("forge.hfmix.build_mix", fromlist=["system_prompt"]).system_prompt()
out = REPORT / f"after-v8r4-step{step}-python.json"
probe_adapter(MODEL, PREFIX, SYSTEM_PROMPT, PROBES, out)
print("Probe answers written to", out, "- NOT promoted; compare with v5/v7 and run the Go gates.")
