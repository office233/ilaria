"""End-to-end synthetic SFT, export and exact interrupted/resumed training."""
import json
import itertools
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from forge.test_tool_data import row


class TrainerTests(unittest.TestCase):
    def test_warm_start_export_and_reject_corrupt_tensors(self):
        from forge import train_tools
        import torch
        import lora_bitlinear as lb
        from mm_model import build_tiny_bitnet_llm
        from safetensors.torch import save_file
        base, _ = build_tiny_bitnet_llm(16, 64, 0, 1, layers=1, heads=2, kv_heads=1, ffn=32, max_pos=512)
        lb.inject_lora(base, r=2, alpha=4)
        modules = lb.lora_modules(base)
        tensors = {lb.export_key(name) + "." + key: torch.ones_like(parameter).cpu().contiguous()
                   for name, module in modules.items()
                   for key, parameter in (("A", module.lora_A), ("B", module.lora_B))}
        with tempfile.TemporaryDirectory() as d:
            prefix = str(Path(d) / "init")
            Path(prefix + ".json").write_text(json.dumps({"base": {"kind": "smoke"},
                "lora": {"r": 2, "alpha": 4, "scaling": 2, "n_modules": len(modules)}}))
            save_file(tensors, prefix + ".safetensors")
            provenance = train_tools.initialize_adapter(base, prefix, lb, "smoke", 2, 4)
            self.assertEqual(len(provenance["weights_sha256"]), 64)
            self.assertTrue(all(torch.equal(m.lora_B, torch.ones_like(m.lora_B)) for m in modules.values()))
            with self.assertRaisesRegex(ValueError, "base kind"):
                train_tools.initialize_adapter(base, prefix, lb, "offline", 2, 4)
            first = next(iter(tensors))
            tensors[first].fill_(float("nan"))
            save_file(tensors, prefix + ".safetensors")
            with self.assertRaisesRegex(ValueError, "invalid initial adapter"):
                train_tools.initialize_adapter(base, prefix, lb, "smoke", 2, 4)

    def test_resume_matches_uninterrupted_and_exports_adapters(self):
        from forge import train_tools
        import torch
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            train, val = root / "train.jsonl", root / "val.jsonl"
            train.write_text("\n".join(json.dumps(row(f"Compute test {i}")) for i in range(4)), encoding="utf-8")
            val.write_text(json.dumps(row("Validation question")), encoding="utf-8")
            def run(out, resume=False):
                args = ["train_tools", "--smoke", "--train", str(train), "--validation", str(val),
                        "--llm-dir", "unused-smoke-model", "--out", str(out), "--steps", "2", "--batch", "1",
                        "--accum", "2", "--rank", "2", "--alpha", "4", "--max-length", "512", "--checkpoint-every", "1", "--gradient-checkpointing"]
                if resume:
                    args.append("--resume")
                with patch.object(sys, "argv", args):
                    train_tools.main()
            uninterrupted, resumed = root / "full", root / "resumed"
            run(uninterrupted)
            with patch("safetensors.torch.save_file", side_effect=RuntimeError("injected interruption")):
                with self.assertRaisesRegex(RuntimeError, "injected interruption"):
                    run(resumed)
            ck = torch.load(resumed / "checkpoint.pt", weights_only=False)
            self.assertEqual(ck["step"], 1)
            run(resumed, resume=True)
            expected = torch.load(uninterrupted / "checkpoint.pt", weights_only=False)
            actual = torch.load(resumed / "checkpoint.pt", weights_only=False)
            self.assertEqual(actual["step"], 2)
            changed = False
            for name, entry in actual["lora"].items():
                for key in ("A", "B"):
                    torch.testing.assert_close(entry[key], expected["lora"][name][key], rtol=0, atol=0)
                changed |= bool(entry["B"].abs().sum())
            self.assertTrue(changed, "training did not update adapters")
            self.assertTrue((resumed / "adapter-step2.safetensors").is_file())
            meta = json.loads((resumed / "adapter-step2.json").read_text())
            self.assertEqual(meta["base"]["kind"], "smoke")
            self.assertTrue((uninterrupted / "baseline.json").is_file())

    def test_soft_deadline_saves_before_last_step(self):
        from forge import train_tools
        import torch
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            train, val = root / "train.jsonl", root / "val.jsonl"
            train.write_text(json.dumps(row("Train question")), encoding="utf-8")
            val.write_text(json.dumps(row("Validation question")), encoding="utf-8")
            out = root / "run"
            args = ["train_tools", "--smoke", "--train", str(train), "--validation", str(val),
                    "--llm-dir", "smoke", "--out", str(out), "--steps", "3", "--accum", "1",
                    "--max-length", "512", "--checkpoint-every", "3", "--max-runtime-minutes", "0.000000001"]
            with patch.object(sys, "argv", args), patch("forge.train_tools.time.monotonic", side_effect=itertools.count().__next__):
                train_tools.main()
            ck = torch.load(out / "checkpoint.pt", weights_only=False)
            self.assertEqual(ck["step"], 1)
            self.assertTrue((out / "adapter-step1.json").is_file())
