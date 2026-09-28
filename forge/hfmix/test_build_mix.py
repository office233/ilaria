import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
from forge.hfmix import build_mix as bm  # noqa: E402
from forge.tool_data import load_trajectories  # noqa: E402

SERVING = ('You are Ilaria, the local assistant for SwypikOS. Respond in English by default, unless the user explicitly '
           'requests another language.')


def fixture(name):
    data = json.loads((HERE / "fixtures" / f"{name}.json").read_text(encoding="utf-8"))
    return [r["row"] for r in data["rows"]]


class BuildMixTests(unittest.TestCase):
    def test_serving_prompt_is_reproduced(self):
        prompt = bm.system_prompt()
        self.assertTrue(prompt.startswith(SERVING))
        self.assertIn("- convert: <N> <from-unit> to <to-unit>", prompt)
        self.assertTrue(prompt.endswith("The capital of France is Paris."))

    def test_glaive_calls_and_responses(self):
        rows = [bm.convert_glaive(r) for r in fixture("glaiveai_glaive-function-calling-v2")]
        rows = [r for r in rows if r and bm.valid(r)]
        self.assertTrue(rows)
        calls = [m["content"] for r in rows for m in r["messages"] if m["content"].startswith("CALL ")]
        self.assertTrue(calls)
        self.assertTrue(all(c.startswith("CALL get_") or c.startswith("CALL ") for c in calls))
        self.assertFalse(any("<|endoftext|>" in m["content"] for r in rows for m in r["messages"]))

    def test_hermes_multi_call_split(self):
        rows = [bm.convert_hermes(r) for r in fixture("NousResearch_hermes-function-calling-v1")]
        # The fixture is the single-turn config (no tool responses): it must be rejected, not half-converted.
        self.assertTrue(all(r is None or not bm.valid(r) for r in rows))
        rec = {"tools": json.dumps([{"type": "function", "function": {"name": "a", "parameters": {"properties": {"x": {"type": "string"}}}}},
                                    {"type": "function", "function": {"name": "b", "parameters": {}}}]),
               "conversations": [{"from": "human", "value": "do both"},
                                 {"from": "gpt", "value": '<tool_call>\n{"name": "a", "arguments": {"x": "1"}}\n</tool_call>\n<tool_call>\n{"name": "b", "arguments": {}}\n</tool_call>'},
                                 {"from": "tool", "value": "<tool_response>\nA-OK\n</tool_response>\n<tool_response>\nB-OK\n</tool_response>"},
                                 {"from": "gpt", "value": "Both done."}]}
        r = bm.convert_hermes(rec)
        self.assertTrue(bm.valid(r))
        self.assertEqual([m["role"] for m in r["messages"]], ["system", "user", "assistant", "tool", "assistant", "tool", "assistant"])
        self.assertEqual(r["messages"][2]["content"], 'CALL a: {"x": "1"}')
        self.assertEqual(r["messages"][5]["content"], "B-OK")

    def test_simple_converters(self):
        for name, conv in (("openai_gsm8k", bm.convert_gsm8k), ("meta-math_MetaMathQA", bm.convert_metamath),
                           ("ise-uiuc_Magicoder-OSS-Instruct-75K", bm.convert_magicoder), ("CohereLabs_aya_dataset", bm.convert_aya)):
            rows = [conv(r) for r in fixture(name)]
            self.assertTrue(any(bm.valid(r) for r in rows), name)
        g = bm.convert_gsm8k(fixture("openai_gsm8k")[0])
        self.assertNotIn("<<", g["messages"][-1]["content"])
        self.assertTrue(g["messages"][-1]["content"].endswith("The answer is 72."))

    def test_oasst_threads(self):
        rows = list(bm.oasst_threads(fixture("OpenAssistant_oasst2")))
        for r in rows:
            self.assertEqual(r["messages"][1]["role"], "user")
            self.assertEqual(r["messages"][-1]["role"], "assistant")

    def test_build_split_leakage_and_loader_roundtrip(self):
        records = {"gsm8k": fixture("openai_gsm8k"), "metamath": fixture("meta-math_MetaMathQA"),
                   "glaive": fixture("glaiveai_glaive-function-calling-v2")}
        forbidden = {bm.prompt_key(fixture("openai_gsm8k")[0]["question"])}
        (train, val), stats = bm.build(records, forbidden)
        self.assertEqual(stats["gsm8k:benchmark_leak"], 1)
        all_prompts = [bm.prompt_key(next(m["content"] for m in r["messages"] if m["role"] == "user")) for r in train + val]
        self.assertNotIn(next(iter(forbidden)), all_prompts)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "t.jsonl"
            bm.write_jsonl(path, train + val)
            loaded = load_trajectories(path, ("en",))
            self.assertEqual(len(loaded), len(train) + len(val))

    def test_bench_prompts_are_forbidden(self):
        bench = HERE.parents[1] / "bench" / "swypik-v1" / "tasks.jsonl"
        keys = bm.forbidden_prompts([bench])
        self.assertEqual(len(keys), 100)


if __name__ == "__main__":
    unittest.main()
