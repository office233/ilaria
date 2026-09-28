import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

import swypik_eval as e

TASKS = Path(__file__).resolve().parents[2] / "bench" / "swypik-v1" / "tasks.jsonl"

# Produced by cortex.CalcChatTool / cortex.ConvertChatTool (Go) on 2026-09-28; "ERR" = error.
GO_GOLDEN = {
    "calc": {"  7 ": "7", "(1+2": "ERR", "-3+-4": "-7", "0.1+0.2": "0.3", "1.5.5": "ERR", "1/0": "ERR",
             "10/3": "3.3333333333", "1000/1.19": "840.3361344538", "240*(1-0.25)": "180", "2400/96": "25",
             "2^-2": "0.25", "2^0.5": "1.4142135624", "2^10": "1024", "2^3^2": "512", "3*45+2*89": "313",
             "3750*0.08": "300", "500*1.19": "595", "8200*1.5/100": "123", "abc": "ERR", "sqrt(-1)": "ERR",
             "sqrt(2)": "1.4142135624"},
    "convert": {"1 banana to km": "ERR", "10 feet to meters": "3.048 m", "100 f to c": "37.78 c",
                "1500 m to km": "1.5 km", "20 lbs to kg": "9.072 kg", "3 m to m": "3 m", "31 C to F": "87.8 f",
                "5 kg in lb": "11.02 lb", "72 miles to kilometers": "115.9 km"},
}


def scripted(*segments):
    """Fake generator returning fixed raw segments and recording contexts."""
    seen, queue = [], list(segments)

    def generate(messages):
        seen.append([dict(m) for m in messages])
        return queue.pop(0)
    return generate, seen


class ToolParity(unittest.TestCase):
    def test_matches_go(self):
        for name, cases in GO_GOLDEN.items():
            for args, want in cases.items():
                with self.subTest(tool=name, args=args):
                    try:
                        got = e.TOOLS[name](args)
                    except ValueError:
                        got = "ERR"
                    self.assertEqual(got, want)

    def test_time_format(self):
        now = dt.datetime(2026, 9, 28, 14, 5, 9, tzinfo=dt.timezone(dt.timedelta(hours=3), "EEST"))
        self.assertEqual(e.time_tool("", now),
                         "local: Monday, 28 September 2026 14:05:09 EEST | utc: Monday, 28 September 2026 11:05:09 UTC")


class Loop(unittest.TestCase):
    def test_call_then_answer(self):
        gen, seen = scripted("CALL calc: 3*45+2*89\nextra words", "The total is 313 RON.")
        turn = e.run_turn(gen, "SYS", "total?")
        self.assertEqual(turn["answer"], "The total is 313 RON.")
        self.assertEqual(turn["tool_calls"], [{"tool": "calc", "args": "3*45+2*89", "result": "313", "ok": True}])
        self.assertEqual(seen[1][-2:], [{"role": "assistant", "content": "CALL calc: 3*45+2*89"},
                                        {"role": "tool", "content": "313"}])

    def test_unknown_tool_and_parse_error_are_fed_back(self):
        gen, seen = scripted("CALL search: x", "CALL nocolon", "I cannot look that up.")
        turn = e.run_turn(gen, "SYS", "q")
        self.assertEqual(turn["calls"], 0)
        self.assertTrue(seen[1][-1]["content"].startswith("error: unknown tool search"))
        self.assertTrue(seen[2][-1]["content"].startswith("error: missing ':'"))

    def test_budget_refusal_then_forced_answer(self):
        gen, seen = scripted("CALL calc: 1+1", "CALL calc: 2+2", "CALL calc: 3+3")
        turn = e.run_turn(gen, "SYS", "q", max_calls=1)
        self.assertEqual(turn["calls"], 1)
        self.assertEqual(seen[2][-1]["content"], e.REFUSAL)
        self.assertEqual(turn["answer"], "CALL calc: 3+3")  # forced: taken as the answer, like Go

    def test_encode_context_layout(self):
        class Tok:
            def encode(self, s, add_special_tokens=False):
                return [s]
        ids = e.encode_context(Tok(), [{"role": "system", "content": "S "}, {"role": "user", "content": "U"},
                                       {"role": "assistant", "content": "A"}, {"role": "tool", "content": "T"}])
        self.assertEqual(ids, ["System: S<|eot_id|>", "User: U<|eot_id|>", "Assistant: ", "A<|eot_id|>",
                               "Tool: T<|eot_id|>", "Assistant: "])


class Scoring(unittest.TestCase):
    def test_categories_and_totals(self):
        tasks = [
            {"id": "c", "category": "commerce_calc", "prompt": "p", "expected_tool": "calc", "expect_substring": "313"},
            {"id": "s", "category": "approval_safety", "prompt": "p2", "expected_tool": "",
             "must_not_contain": ["i have sent"]},
            {"id": "w", "category": "commerce_writing", "prompt": "p3", "expected_tool": ""},
        ]
        answers = iter(["CALL calc: 3*45+2*89", "It is 313.", "I have sent it.", "CALL time: ", "ok"])
        rep = e.evaluate(lambda m: next(answers), "SYS", tasks, log=None)
        s = {r["id"]: r["score"] for r in rep["results"]}
        self.assertTrue(s["c"]["auto_pass"])
        self.assertEqual(s["s"]["forbidden_hits"], ["i have sent"])
        self.assertFalse(s["s"]["auto_pass"])
        self.assertTrue(s["w"]["false_call"])
        t = rep["summary"]["totals"]
        self.assertEqual((t["tool_ok"], t["tool_needed"], t["false_calls"], t["no_tool"]), (1, 1, 1, 2))
        self.assertEqual(rep["summary"]["by_category"]["commerce_calc"], {"n": 1, "auto_pass": 1})

    def test_wrong_number_fails_even_with_right_tool(self):
        task = {"id": "c", "prompt": "p", "expected_tool": "calc", "expect_substring": "313"}
        gen, _ = scripted("CALL calc: 3*45", "It is 135.")
        self.assertFalse(e.score(task, e.run_turn(gen, "S", "p"))["auto_pass"])

    def test_inference_error_counts_as_failure(self):
        def boom(_):
            raise RuntimeError("OOM")
        rep = e.evaluate(boom, "S", [{"id": "x", "prompt": "p", "expected_tool": ""}], log=None)
        self.assertEqual(rep["summary"]["totals"]["errors"], 1)
        self.assertEqual(rep["summary"]["totals"]["false_calls"], 1)
        self.assertIn("OOM", rep["results"][0]["inference_error"])


class Blind(unittest.TestCase):
    def test_sheet_hides_model_and_merge_counts(self):
        tasks = [{"id": "w1", "category": "commerce_writing", "prompt": "p", "rubric": "r"}]
        reps = {m: e.evaluate(lambda _, a=m: "answer " + a, "S", tasks, log=None) for m in ("v5", "v7", "v8")}
        sheet, key = e.export_blind(reps, tasks)
        self.assertEqual(len(sheet), 3)
        self.assertNotIn("model", json.dumps(sheet))
        for row in sheet:
            row["pass"] = key[row["blind_id"]]["model"] == "v8"
        merged = e.merge_rubric(sheet, key, tasks)
        self.assertEqual(merged["by_model"]["v8"]["commerce_writing"], {"graded": 1, "pass": 1})
        self.assertEqual(merged["by_model"]["v5"]["commerce_writing"], {"graded": 1, "pass": 0})
        self.assertEqual(merged["ungraded"], [])

    def test_never_overwrites(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "r.json"
            e.write_new_json(p, {})
            with self.assertRaises(FileExistsError):
                e.write_new_json(p, {})


class Bench(unittest.TestCase):
    def test_tool_task_answers_are_reachable_by_tools(self):
        """The converter output for each task's canonical call (the rubric hint) contains the expectation."""
        for t in e.read_jsonl(TASKS):
            if t["expected_tool"] == "convert":
                with self.subTest(id=t["id"]):
                    hint = t["rubric"].split("'")[1]
                    self.assertIn(t["expect_substring"], e.convert(hint))


if __name__ == "__main__":
    unittest.main()
