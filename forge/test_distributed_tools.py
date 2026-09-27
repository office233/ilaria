"""Two-worker CPU DDP smoke test; no models, corpora or GPU allocation."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from forge.test_tool_data import row


class DistributedTrainerTests(unittest.TestCase):
    def test_two_workers_export_one_checkpoint(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            train, val, out = root / "train.jsonl", root / "val.jsonl", root / "out"
            train.write_text("\n".join(json.dumps(row(f"Training question {i}")) for i in range(4)), encoding="utf-8")
            val.write_text(json.dumps(row("Held out question")), encoding="utf-8")
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            env = dict(os.environ, USE_LIBUV="0", OMP_NUM_THREADS="1", MKL_NUM_THREADS="1", HF_HUB_OFFLINE="1")
            command = [sys.executable, "-m", "torch.distributed.run", "--nnodes=1", "--nproc-per-node=2",
                       "--master-addr=127.0.0.1", f"--master-port={port}",
                       str(Path(__file__).with_name("train_tools.py")), "--smoke", "--train", str(train),
                       "--validation", str(val), "--llm-dir", "unused-smoke-model", "--out", str(out),
                       "--steps", "1", "--accum", "1", "--rank", "2", "--alpha", "4", "--max-length", "512"]
            if os.name == "nt":
                # PyTorch 2.5's Windows torchrun agent hardcodes a libuv
                # TCPStore despite builds without libuv. Exercise the same
                # rank/env contract with two directly launched workers.
                workers = []
                try:
                    for rank in range(2):
                        worker_env = dict(env, WORLD_SIZE="2", RANK=str(rank), LOCAL_RANK=str(rank),
                                          MASTER_ADDR="127.0.0.1", MASTER_PORT=str(port))
                        workers.append(subprocess.Popen([sys.executable] + command[7:], env=worker_env,
                                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
                    for worker in workers:
                        stdout, stderr = worker.communicate(timeout=120)
                        self.assertEqual(worker.returncode, 0, stdout + stderr)
                finally:
                    for worker in workers:
                        if worker.poll() is None:
                            worker.kill()
                            worker.communicate()
            else:
                result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=120)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            meta = json.loads((out / "adapter-step1.json").read_text())
            self.assertEqual(meta["contract"]["world_size"], 2)
            self.assertEqual(meta["lora"]["n_modules"], 7)
            self.assertTrue((out / "checkpoint.pt").is_file())
