"""Unit tests for forge/concat_streams.py: joins tokenized shards into one stream.

Run:  python -m unittest forge.test_concat_streams -v
"""

import json
import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from forge import concat_streams as cs  # noqa: E402


def _write_shard(d, name, ids, vocab=32000, eos=2, dtype="uint16"):
    arr = np.asarray(ids, dtype=np.uint16 if dtype == "uint16" else np.uint32)
    arr.tofile(os.path.join(d, name + ".bin"))
    with open(os.path.join(d, name + ".json"), "w", encoding="utf-8") as f:
        json.dump({"vocab_size": vocab, "eos_id": eos, "dtype": dtype, "tokens": len(ids), "tokenizer": "data/tokenizer.json"}, f)


class ConcatTests(unittest.TestCase):
    def test_concatenates_in_given_order_and_sums_meta(self):
        # The caller decides the order (interleave_prefixes); concat must keep it.
        with tempfile.TemporaryDirectory() as d:
            _write_shard(d, "wiki_ro-00001", [7, 8, 2])
            _write_shard(d, "wiki_ro-00000", [3, 4, 5, 2])
            _write_shard(d, "fineweb_edu-00000", [9, 2])
            out = os.path.join(d, "train_stream")
            meta = cs.concat([os.path.join(d, n) for n in ["fineweb_edu-00000", "wiki_ro-00000", "wiki_ro-00001"]], out)
            data = np.fromfile(out + ".bin", dtype=np.uint16)
            self.assertEqual(data.tolist(), [9, 2, 3, 4, 5, 2, 7, 8, 2])
            self.assertEqual(meta["tokens"], 9)
            self.assertEqual(meta["vocab_size"], 32000)
            self.assertEqual(meta["eos_id"], 2)
            self.assertEqual(meta["dtype"], "uint16")
            self.assertEqual(meta["shards"], 3)
            with open(out + ".json", encoding="utf-8") as f:
                self.assertEqual(json.load(f)["tokens"], 9)

    def test_rejects_mismatched_vocab_or_dtype(self):
        with tempfile.TemporaryDirectory() as d:
            _write_shard(d, "a-00000", [1, 2])
            _write_shard(d, "b-00000", [1, 2], vocab=8192)
            with self.assertRaises(ValueError):
                cs.concat([os.path.join(d, "a-00000"), os.path.join(d, "b-00000")], os.path.join(d, "out"))

    def test_interleave_mixes_shards_by_ratio(self):
        # ratio ro:en = 1:1 over shard files → alternate shards from each prefix
        with tempfile.TemporaryDirectory() as d:
            _write_shard(d, "ro-00000", [1, 2])
            _write_shard(d, "ro-00001", [3, 2])
            _write_shard(d, "en-00000", [5, 2])
            _write_shard(d, "en-00001", [6, 2])
            order = cs.interleave_prefixes({"ro": [os.path.join(d, "ro-00000"), os.path.join(d, "ro-00001")],
                                           "en": [os.path.join(d, "en-00000"), os.path.join(d, "en-00001")]})
            names = [os.path.basename(p) for p in order]
            self.assertEqual(names, ["ro-00000", "en-00000", "ro-00001", "en-00001"])


if __name__ == "__main__":
    unittest.main()
