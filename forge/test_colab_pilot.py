"""CPU-only safety and notebook structure tests; no Drive, downloads or real weights."""
import ast
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from forge.colab import pilot_preflight as pilot
from forge.colab import build_project_pilot_v7 as builder


class PilotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.system = "Use only supplied evidence."
        self.probes = [{"id": "frozen", "prompt": "A reserved development question", "rubric": "Grounded answer"}]

    def make_dataset(self, validation_prompt="Validation question"):
        rows = {}
        for split, prompt in (("train", "Training question"), ("validation", validation_prompt)):
            rows[split] = [{"language": "en", "task_id": split, "messages": [
                {"role": "system", "content": self.system},
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": "An evidence-based answer."}]}]
        self.write_dataset(rows)
        return rows

    def write_dataset(self, rows):
        manifest = {}
        for split, values in rows.items():
            path = self.root / f"{split}.jsonl"
            path.write_text("".join(json.dumps(row) + "\n" for row in values), encoding="utf-8")
            manifest[split] = {"rows": len(values), "sha256": pilot.sha256_file(path)}
        (self.root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    def check_dataset(self, tokenizer=None):
        return pilot.check_dataset(self.root, self.system, self.probes, tokenizer)

    def test_valid_english_dataset_and_hashes(self):
        self.make_dataset()
        result = self.check_dataset()
        self.assertEqual(result["counts"], {"train": {"en": 1}, "validation": {"en": 1}})
        self.assertEqual(len(result["sha256"]["train"]), 64)

    def test_dataset_mutation_rejected(self):
        self.make_dataset()
        with (self.root / "train.jsonl").open("a") as output:
            output.write("\n")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.check_dataset()

    def test_train_validation_leakage_rejected(self):
        self.make_dataset(validation_prompt="  TRAINING   QUESTION ")
        with self.assertRaisesRegex(ValueError, "leakage"):
            self.check_dataset()

    def test_frozen_probe_leakage_rejected_in_later_turn(self):
        rows = self.make_dataset()
        rows["train"][0]["messages"].extend([
            {"role": "user", "content": " A RESERVED  DEVELOPMENT question "},
            {"role": "assistant", "content": "Not allowed in training."}])
        self.write_dataset(rows)
        with self.assertRaisesRegex(ValueError, "Frozen probe leakage"):
            self.check_dataset()

    def test_serving_prompt_mismatch_rejected(self):
        self.make_dataset()
        self.system = "A different serving prompt."
        with self.assertRaisesRegex(ValueError, "Serving system prompt mismatch"):
            self.check_dataset()

    def test_incorrect_row_count_rejected(self):
        self.make_dataset()
        path = self.root / "manifest.json"
        manifest = json.loads(path.read_text())
        manifest["train"]["rows"] += 1
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "count mismatch"):
            self.check_dataset()

    def test_no_silent_truncation(self):
        self.make_dataset()
        class Tokenizer:
            eos_token_id = 1
            unk_token_id = 0
            def encode(self, text, add_special_tokens=False):
                return [2] if text == "<|eot_id|>" else [2] * 2050
        with self.assertRaisesRegex(ValueError, "curate it instead of truncating"):
            self.check_dataset(Tokenizer())

    def test_invalid_eot_rejected(self):
        self.make_dataset()
        class Tokenizer:
            eos_token_id = 1
            unk_token_id = 0
            def encode(self, text, add_special_tokens=False):
                return [0]
        with self.assertRaisesRegex(ValueError, "Invalid EOT"):
            self.check_dataset(Tokenizer())

    def test_parent_hash_checks_both_files(self):
        prefix = self.root / "parent"
        expected = {}
        for suffix in ("json", "safetensors"):
            path = Path(str(prefix) + "." + suffix)
            path.write_text("synthetic " + suffix)
            expected[suffix] = pilot.sha256_file(path)
        self.assertEqual(pilot.check_parent(prefix, expected), expected)
        Path(str(prefix) + ".json").write_text("changed")
        with self.assertRaisesRegex(ValueError, "Parent SHA256 mismatch"):
            pilot.check_parent(prefix, expected)

    def test_old_or_escaping_run_name_rejected(self):
        for name in ("project-v6-200steps", "drafting-v5-150steps", "project-v7-pilot-../old", "../old"):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "run name"):
                pilot.training_command(self.root, self.root / "model", name)

    def test_existing_run_not_overwritten(self):
        name = "project-v7-pilot-test"
        run = self.root / "runs" / name
        run.mkdir(parents=True)
        marker = run / "checkpoint.pt"
        marker.write_text("preserved synthetic marker")
        with self.assertRaisesRegex(ValueError, "already contains artifacts"):
            pilot.check_inputs(self.root, self.root, name, {}, self.system, self.probes)
        self.assertEqual(marker.read_text(), "preserved synthetic marker")

    def test_report_cannot_overwrite_previous_report(self):
        path = self.root / "report.json"
        pilot.write_new_json(path, {"value": 1})
        with self.assertRaises(FileExistsError):
            pilot.write_new_json(path, {"value": 2})
        self.assertEqual(json.loads(path.read_text()), {"value": 1})

    def test_bounded_command_warm_starts_from_v5(self):
        command = pilot.training_command(self.root, self.root / "model", "project-v7-pilot-test")
        self.assertEqual(command[command.index("--steps") + 1], "50")
        self.assertEqual(float(command[command.index("--lr") + 1]), 2e-5)
        self.assertIn("drafting-v5-150steps", command[command.index("--init-adapter") + 1])
        self.assertNotIn("--resume", command)

    def test_generated_bootstrap_writes_real_lf_newlines(self):
        with patch.object(builder.subprocess, "check_output", return_value=b"Verified system prompt\n"):
            notebook = builder.build()
        tree = ast.parse(notebook["cells"][2]["source"])
        writes = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                  and isinstance(node.func, ast.Attribute) and node.func.attr == "write_text"]
        self.assertEqual(len(writes), 1)
        target = self.root / "bootstrap.py"
        content = "# Unicode: \u0219\nVALUE = 1\n"
        expression = ast.Expression(body=writes[0])
        eval(compile(ast.fix_missing_locations(expression), "<bootstrap-write-test>", "eval"),
             {"target": target, "content": content})
        self.assertEqual(target.read_bytes(), content.encode("utf-8"))

    def test_notebook_cells_parse_and_sources_are_allowlisted(self):
        with patch.object(builder.subprocess, "check_output", return_value=b"Verified system prompt\n"):
            notebook = builder.build()
        import nbformat
        nbformat.validate(nbformat.from_dict(notebook))
        self.assertEqual(len(builder.PROBES), 12)
        self.assertEqual(len({pilot.prompt_key(p["prompt"]) for p in builder.PROBES}), 12)
        for cell in notebook["cells"]:
            if cell["cell_type"] == "code":
                ast.parse(cell["source"])
                self.assertEqual(cell["outputs"], [])
                self.assertIsNone(cell["execution_count"])
        self.assertTrue(all(name.startswith("forge/") and name.endswith(".py") for name in builder.FILES))
        self.assertFalse(any("data/" in name or "secret" in name for name in builder.FILES))
        serialized = json.dumps(notebook)
        self.assertIn("go_regression_evaluation_required", serialized)
        self.assertIn("weights_only=True", serialized)


if __name__ == "__main__":
    unittest.main()
