import json
import tempfile
import unittest
from pathlib import Path

from forge.hfmix.filter_length import filter_length


class CharTokenizer:
    eos_token_id = 1

    def encode(self, text, add_special_tokens=False):
        return [2] * len(text)


def row(text, lang="en"):
    return {"language": lang, "source": "aya", "messages": [
        {"role": "system", "content": "S"}, {"role": "user", "content": text}, {"role": "assistant", "content": "ok"}]}


class FilterLengthTests(unittest.TestCase):
    def test_drops_long_rows_keeps_bytes_and_survives_u2028(self):
        with tempfile.TemporaryDirectory() as d:
            src, dst = Path(d) / "src", Path(d) / "dst"
            src.mkdir()
            short = json.dumps(row("line separator inside a string", "pa"), ensure_ascii=False)
            long = json.dumps(row("x" * 500, "ta"), ensure_ascii=False)
            self.assertIn(chr(0x2028), short)  # raw separator inside a JSON string
            (src / "train.jsonl").write_bytes((short + "\n" + long + "\n").encode())
            (src / "validation.jsonl").write_bytes((short + "\n").encode())
            (src / "manifest.json").write_text(json.dumps({"train": {}, "validation": {}, "notes": "x"}))
            m = filter_length(src, dst, CharTokenizer(), max_tokens=200)
            self.assertEqual((dst / "train.jsonl").read_bytes(), (short + "\n").encode())
            self.assertEqual(m["train"]["rows"], 1)
            self.assertEqual(m["length_filter"]["dropped"], {"train|aya|ta": 1})
            self.assertEqual(m["languages"], ["pa"])
            self.assertEqual(m["notes"], "x")
            with self.assertRaises(FileExistsError):
                filter_length(src, dst, CharTokenizer(), max_tokens=200)


if __name__ == "__main__":
    unittest.main()
