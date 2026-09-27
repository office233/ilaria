RUN_V2 = ROOT / "runs/behavior-v2-100steps"
INIT_V2 = ROOT / "runs/g4-tool-pilot-v1/adapter-step50"
assert result.returncode == 0
assert not RUN_V2.exists(), "Use a new run or explicit resume"
assert hashlib.sha256(Path(str(INIT_V2)+".safetensors").read_bytes()).hexdigest() == "7147a3e0413405f5fa9736ee0ccd55682c04a21d2e790160bda29e9de5ccffa5"
args_v2 = [sys.executable, "-u", "-m", "forge.train_tools", "--train", str(TRAIN_V2), "--validation", str(VAL_V2), "--llm-dir", str(MODEL), "--out", str(RUN_V2), "--init-adapter", str(INIT_V2), "--languages", "en", "--steps", "100", "--batch", "1", "--accum", "8", "--max-length", "2048", "--rank", "16", "--alpha", "32", "--lr", "0.00005", "--gradient-checkpointing", "--checkpoint-every", "25", "--log-every", "10", "--max-runtime-minutes", "15"]
print("Starting behavior stage from verified pilot weights; fresh optimizer", flush=True)
with subprocess.Popen(args_v2, cwd=WORK, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1) as process:
    for line in process.stdout:
        print(line, end="", flush=True)
    rc_v2 = process.wait()
assert rc_v2 == 0, f"Training failed: {rc_v2}"
(RUN_V2 / "source_manifest.json").write_text(json.dumps(manifest, indent=2))
(RUN_V2 / "base_revision.txt").write_text(revision)
(RUN_V2 / "environment.txt").write_text(subprocess.check_output([sys.executable, "-m", "pip", "freeze"], text=True))
print("BEHAVIOR V2 COMPLETE:", RUN_V2, flush=True)
