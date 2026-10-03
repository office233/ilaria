import json
from pathlib import Path
import tempfile
import unittest
from forge.tool_data import load_trajectories, validate_splits, encode_trajectory


def row(prompt, lang="en"):
    return {"language": lang, "messages": [
        {"role": "system", "content": "Answer in English."},
        {"role": "user", "content": prompt},
        {"role": "assistant", "content": "CALL calc: 2+3"},
        {"role": "tool", "content": "5"},
        {"role": "assistant", "content": "The answer is 5."}]}


class ToolDataTests(unittest.TestCase):
    def test_generation_header_boundary_is_preserved(self):
        class MergingTokenizer:
            def encode(self, text, add_special_tokens=False):
                # Simulate real BPE: the same visible space has different IDs
                # when encoded with the answer instead of the generation header.
                if text == "Assistant: ":
                    return [10, 11, 12]
                if text.startswith("Assistant: "):
                    return [10, 11, 99]
                if text.startswith("CALL "):
                    return [20, 21, 22]
                if text.startswith("The answer"):
                    return [30, 31, 22]
                return [40, 22]
        encoded = encode_trajectory(row("Compute"), MergingTokenizer(), 100)
        self.assertEqual(encoded["input_ids"], [40,22,40,22,10,11,12,20,21,22,40,22,10,11,12,30,31,22])
        self.assertEqual([x for x in encoded["labels"] if x != -100], [20,21,22,30,31,22])

    def test_language_and_tool_observation_validation(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "rows.jsonl"
            p.write_text(json.dumps(row("Compute two plus three")), encoding="utf-8")
            self.assertEqual(len(load_trajectories(p)), 1)
            p.write_text(json.dumps(row("Calculează", "ro")), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_trajectories(p)
            self.assertEqual(len(load_trajectories(p, ("en", "ro"))), 1)
            bad = row("hi")
            del bad["messages"][3]
            p.write_text(json.dumps(bad), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_trajectories(p)

    def test_overlap_and_assistant_mask(self):
        with self.assertRaises(ValueError):
            validate_splits([row("Hello")], [row("HELLO", "ro")])
        en, ro = row("Hello"), row("Salut", "ro")
        en["task_id"] = ro["task_id"] = "greeting-1"
        with self.assertRaises(ValueError):
            validate_splits([en], [ro])
        class Tok:
            def encode(self, text, add_special_tokens=False):
                return list(text.encode("utf-8"))
        encoded = encode_trajectory(row("hi"), Tok(), 1024)
        supervised = bytes(i for i in encoded["labels"] if i != -100).decode()
        self.assertIn("CALL calc: 2+3", supervised)
        self.assertNotIn("Answer in English", supervised)
        self.assertNotIn("Tool:", supervised)
        with self.assertRaises(ValueError):
            encode_trajectory(row("hi"), Tok(), 5)
