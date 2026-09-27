RUN_PILOT = True
RUN = ROOT / "runs/g4-tool-pilot-v1"
assert not RUN.exists(), "Existing run: inspect before explicit resume"
print("GPU:", torch.cuda.get_device_name(0), "GiB:", round(torch.cuda.get_device_properties(0).total_memory / 2**30, 1), flush=True)
args = [sys.executable, "-u", "-m", "forge.train_tools",
    "--train", str(TRAIN), "--validation", str(VALIDATION), "--llm-dir", str(MODEL),
    "--out", str(RUN), "--languages", "en", "--steps", "50", "--batch", "1",
    "--accum", "8", "--max-length", "2048", "--rank", "16", "--alpha", "32",
    "--lr", "0.0001", "--gradient-checkpointing", "--checkpoint-every", "10",
    "--log-every", "1", "--max-runtime-minutes", "20"]
with subprocess.Popen(args, cwd=WORK, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1) as process:
    for line in process.stdout:
        print(line, end="", flush=True)
    returncode = process.wait()
assert returncode == 0, f"Trainer failed: {returncode}"
(RUN / "environment.txt").write_text(subprocess.check_output([sys.executable, "-m", "pip", "freeze"], text=True), encoding="utf-8")
(RUN / "source_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
(RUN / "base_revision.txt").write_text(revision, encoding="utf-8")
print("PILOT COMPLETE:", RUN, flush=True)
