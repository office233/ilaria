"""DiLoCo coordinator: merge math, shards, integrity checks, regression gate, CPU smoke."""
import json
import tempfile
import unittest
from pathlib import Path

import torch

from forge import diloco as d
from forge.test_tool_data import row

KEYS = ("lora.layers.0.q_proj.A", "lora.layers.0.q_proj.B")


def tensors(value):
    return {k: torch.full((2, 3), float(value)) for k in KEYS}


def fake_run(tmp, workers=3, initial_loss=1.0, **settings):
    tmp = Path(tmp)
    train, val = tmp / "train.jsonl", tmp / "val.jsonl"
    train.write_text("".join(json.dumps(row(f"q{i}")) + "\n" for i in range(12)), encoding="utf-8")
    val.write_text(json.dumps(row("held out")) + "\n", encoding="utf-8")
    d.save_adapter(tmp / "parent", tensors(0.0), {"lora": {"r": 2}})
    root = tmp / "run"
    d.init_run(root, tmp / "parent", train, val, workers, 2, 3, ["en"], None,
               evaluate=lambda prefix: initial_loss, **settings)
    return root


def deliver(root, r, w, value):
    """Write a worker result the way worker_round does, without training."""
    rd = d.round_dir(root, r)
    manifest = d.read_json(rd / "global.manifest.json")
    g, _ = d.load_adapter(rd / "global", manifest)
    t = tensors(value) if not isinstance(value, dict) else value
    hashes = d.save_adapter(rd / f"worker-{w}", t, {"lora": {"r": 2}})
    norm = d.delta_norm(t, g)
    d.write_json_once(rd / f"worker-{w}.done.json", {**hashes, "round": r, "worker": w,
                      "global_sha256": manifest["safetensors_sha256"], "update_norm": norm if norm == norm else None})


class OuterStep(unittest.TestCase):
    def test_lr1_mu0_is_plain_average(self):
        new, _ = d.outer_step(tensors(0.0), [tensors(1.0), tensors(3.0)], None, 1.0, 0.0)
        self.assertTrue(torch.allclose(new[KEYS[0]], torch.full((2, 3), 2.0)))

    def test_nesterov_matches_formula(self):
        g, m0 = tensors(1.0), {k: torch.full((2, 3), 0.5) for k in KEYS}
        new, m = d.outer_step(g, [tensors(0.0)], m0, 0.7, 0.9)
        grad = 1.0
        mom = 0.9 * 0.5 + grad
        self.assertAlmostEqual(float(m[KEYS[0]][0, 0]), mom, places=6)
        self.assertAlmostEqual(float(new[KEYS[0]][0, 0]), 1.0 - 0.7 * (grad + 0.9 * mom), places=6)


class Shards(unittest.TestCase):
    def test_disjoint_complete_and_order_independent(self):
        rows = [row(f"q{i}") for i in range(50)]
        shards = [d.shard_rows(rows, 3, w, 42) for w in range(3)]
        keys = [d.row_key(r) for s in shards for r in s]
        self.assertEqual(len(keys), 50)
        self.assertEqual(len(set(keys)), 50)
        self.assertEqual(d.shard_rows(list(reversed(rows)), 3, 1, 42), shards[1])

    def test_round_slices_advance_and_wrap(self):
        shard = [row(f"q{i}") for i in range(5)]
        self.assertEqual(d.round_slice(shard, 0, 3), shard[:3])
        self.assertEqual(d.round_slice(shard, 1, 3), shard[3:] + shard[:1])
        with self.assertRaises(ValueError):
            d.round_slice([], 0, 1)


class Integrity(unittest.TestCase):
    def test_write_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "x.json"
            d.write_json_once(p, {})
            with self.assertRaises(FileExistsError):
                d.write_json_once(p, {})

    def test_changed_data_stops_the_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fake_run(tmp)
            (Path(tmp) / "train.jsonl").write_text("changed\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                d.load_run(root)

    def test_merge_rejects_nan_outlier_and_tampered(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fake_run(tmp, workers=5, min_workers=2)
            deliver(root, 0, 0, 0.1)
            deliver(root, 0, 1, 0.12)
            deliver(root, 0, 2, float("nan"))
            deliver(root, 0, 3, 50.0)                      # outlier update norm
            deliver(root, 0, 4, 0.11)
            (d.round_dir(root, 0) / "worker-4.safetensors").write_bytes(b"tampered")
            rec = d.merge_round(root, 0, None, poll=0.01, evaluate=lambda p: 0.9)
            self.assertEqual(rec["accepted_workers"], [0, 1])
            self.assertEqual(set(rec["rejected_workers"]), {"2", "3", "4"})
            self.assertIn("non-finite", rec["rejected_workers"]["2"])
            self.assertIn("norm", rec["rejected_workers"]["3"])
            self.assertIn("sha256", rec["rejected_workers"]["4"])
            nxt = d.read_json(d.round_dir(root, 1) / "global.manifest.json")
            self.assertEqual((nxt["source"], nxt["validation_loss"]), ("merged", 0.9))
            # Re-running a finished merge is a no-op, not a second write.
            self.assertEqual(d.merge_round(root, 0, None, evaluate=lambda p: 5.0), rec)


class RegressionGate(unittest.TestCase):
    def test_falls_back_then_carries_forward(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = fake_run(tmp, workers=2, initial_loss=1.0)
            deliver(root, 0, 0, 0.2)
            deliver(root, 0, 1, 0.2)
            losses = iter([1.5, 1.01])                     # nesterov regresses, half-lr within 2%
            rec = d.merge_round(root, 0, None, poll=0.01, evaluate=lambda p: next(losses))
            self.assertEqual([t["accepted"] for t in rec["trials"]], [False, True])
            self.assertEqual(rec["trials"][1]["outer_lr"], 0.35)

            deliver(root, 1, 0, 0.3)
            deliver(root, 1, 1, 0.3)
            rec = d.merge_round(root, 1, None, poll=0.01, evaluate=lambda p: 9.0)
            self.assertEqual(rec["result"], "carried-forward")
            self.assertEqual(len(rec["trials"]), 3)
            prev = d.read_json(d.round_dir(root, 1) / "global.manifest.json")
            nxt = d.read_json(d.round_dir(root, 2) / "global.manifest.json")
            self.assertEqual(nxt["safetensors_sha256"], prev["safetensors_sha256"])
            self.assertFalse((root / "outer-state" / "round-0001.safetensors").exists())


class Smoke(unittest.TestCase):
    def test_cpu_two_workers_two_rounds(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = d.smoke(Path(tmp))
            run = Path(out["root"])
            self.assertEqual([m["accepted_workers"] for m in out["merge"]], [[0, 1], [0, 1]])
            self.assertTrue((d.round_dir(run, 2) / "global.manifest.json").exists())
            # Worker shards differ; round slices advance.
            done = [d.read_json(d.round_dir(run, r) / f"worker-{w}.done.json") for r in range(2) for w in range(2)]
            self.assertEqual(len({x["first_row_sha256"] for x in done}), 4)
            # Our validation loss equals the trainer's own report for the same adapter.
            cfg = d.load_run(run)
            meta = d.read_json(d.round_dir(run, 0) / "worker-0.json")
            ours = d.validation_loss(d.round_dir(run, 0) / "worker-0", cfg, None)
            self.assertAlmostEqual(ours, meta["validation_assistant_loss"]["en"], places=4)


if __name__ == "__main__":
    unittest.main()
