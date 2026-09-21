"""Unit tests for forge/hf_tokenizer.py (needs the `tokenizers` package).

Run:  python -m unittest forge.test_hf_tokenizer -v
The Python↔Go id equivalence was verified live on 2026-09-21 (306 lines,
52k tokens, zero mismatches) with cmd/tok-encode; this file pins the export
format and the stream layout so a refactor cannot silently change them.
"""

import json
import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from forge import hf_tokenizer as ht  # noqa: E402

SAMPLE = [
    "Ștefan cel Mare a fost domnul Moldovei între 1457 și 1504.",
    "În această după-amiază, copiii învață să citească „cărți” bune.",
    "The quick brown fox jumps over the lazy dog; don't panic!",
] * 40


class ExportFormatTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        sample = os.path.join(self.dir, "sample.txt")
        with open(sample, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(SAMPLE) + "\n")
        self.out = os.path.join(self.dir, "tok.json")
        self.tok = ht.train([sample], 600, self.out)

    def test_nexus_json_has_go_loadable_shape(self):
        with open(self.out, encoding="utf-8") as f:
            data = json.load(f)
        self.assertTrue(data["byte_level"])
        self.assertEqual(data["vocab_size"], len(data["vocab"]))
        self.assertIn(ht.EOT, data["vocab"])
        self.assertTrue(all(set(m) == {"a", "b"} for m in data["merges"]))
        # every merge result must be a vocab entry (BPE invariant Go relies on)
        for m in data["merges"][:50]:
            self.assertIn(m["a"] + m["b"], data["vocab"])

    def test_reload_from_nexus_json_encodes_identically(self):
        os.remove(os.path.splitext(self.out)[0] + ".hf.json")  # force the rebuild path
        rebuilt = ht.load(self.out)
        for s in SAMPLE[:3]:
            self.assertEqual(rebuilt.encode(s, add_special_tokens=False).ids, self.tok.encode(s, add_special_tokens=False).ids)
            self.assertEqual(rebuilt.decode(rebuilt.encode(s, add_special_tokens=False).ids), s)

    def test_stream_layout_matches_corpus_tokenize(self):
        shard = os.path.join(self.dir, "shard.jsonl")
        with open(shard, "w", encoding="utf-8", newline="\n") as f:
            for s in SAMPLE[:3]:
                f.write(json.dumps({"text": s}, ensure_ascii=False) + "\n")
        meta = ht.encode_jsonl(self.tok, shard, os.path.join(self.dir, "shard"), self.out)
        ids = np.fromfile(os.path.join(self.dir, "shard.bin"), dtype=np.uint16)
        eos = self.tok.token_to_id(ht.EOT)
        self.assertEqual(meta["documents"], 3)
        self.assertEqual(meta["tokens"], len(ids))
        self.assertEqual(int((ids == eos).sum()), 3)          # one EOS per document
        self.assertEqual(int(ids[-1]), eos)                    # stream ends with EOS
        self.assertEqual(meta["eos_id"], eos)
        self.assertEqual(meta["dtype"], "uint16")
        self.assertTrue(meta["byte_level"])


if __name__ == "__main__":
    unittest.main()
