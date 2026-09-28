import json
import unittest
from decimal import Decimal
from pathlib import Path

import build_swypik_bench_v1 as b

TASKS = Path(__file__).resolve().parents[2] / "bench" / "swypik-v1" / "tasks.jsonl"


class SwypikBenchTests(unittest.TestCase):
    def test_build_validates(self):
        b.validate(b.build(), b.training_user_turns())

    def test_frozen_file_matches_builder(self):
        frozen = [json.loads(line) for line in TASKS.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(frozen, b.build())

    def test_number_rendering(self):
        self.assertEqual(b.num(Decimal("595.0")), "595")
        self.assertEqual(b.num(Decimal("37.5")), "37.5")
        self.assertEqual(b.num(Decimal(1000) / Decimal("1.19")), "840.34")

    def test_known_answers(self):
        by_id = {r["id"]: r for r in b.build()}
        self.assertEqual(by_id["calc-01"]["expect_substring"], "313")
        self.assertEqual(by_id["calc-09"]["expect_substring"], "1000")
        self.assertEqual(by_id["conv-05"]["expect_substring"], "20")
        self.assertEqual(by_id["conv-06"]["expect_substring"], "-0.4")

    def test_tool_categories(self):
        for r in b.build():
            if r["category"] in ("commerce_calc", "unit_convert", "time"):
                self.assertTrue(r["expected_tool"])
            else:
                self.assertEqual(r["expected_tool"], "")


if __name__ == "__main__":
    unittest.main()
