"""Tests for canonical token-stream concatenation."""
import json
import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from forge import concat_streams as cs  # noqa: E402
from forge.data_contract import TOKEN_STREAM_FORMAT, sha256_file  # noqa: E402

TOKENIZER_HASH = "0123456789abcdef" * 4


def _write_shard(
    directory,
    name,
    ids,
    *,
    vocab=65_536,
    eos=61_440,
    dtype="uint16",
    tokenizer_hash=TOKENIZER_HASH,
    protocol_start=61_440,
):
    arr = np.asarray(
        ids, dtype=np.uint16 if dtype == "uint16" else np.uint32
    )
    prefix = os.path.join(directory, name)
    arr.tofile(prefix + ".bin")
    meta = {
        "format": TOKEN_STREAM_FORMAT,
        "vocab_size": vocab,
        "eos_id": eos,
        "dtype": dtype,
        "tokens": len(ids),
        "documents": int(sum(int(x) == eos for x in ids)),
        "tokenizer": "ilarialex.json",
        "tokenizer_sha256": tokenizer_hash,
        "tokenizer_format": "ilarialex-v1",
        "protocol_start_id": protocol_start,
        "byte_level": True,
    }
    with open(prefix + ".json", "w", encoding="utf-8") as stream:
        json.dump(meta, stream)
    return prefix


class ConcatTests(unittest.TestCase):
    def test_concatenates_in_order_and_hashes_every_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            a = _write_shard(
                directory, "fineweb-00000", [9, 61_440]
            )
            b = _write_shard(
                directory, "wiki-00000", [3, 4, 5, 61_440]
            )
            c = _write_shard(
                directory, "wiki-00001", [7, 8, 61_440]
            )
            out = os.path.join(directory, "train_stream")
            meta = cs.concat([a, b, c], out)

            data = np.fromfile(out + ".bin", dtype=np.uint16)
            self.assertEqual(
                data.tolist(),
                [9, 61_440, 3, 4, 5, 61_440, 7, 8, 61_440],
            )
            self.assertEqual(meta["tokens"], 9)
            self.assertEqual(meta["documents"], 3)
            self.assertEqual(meta["vocab_size"], 65_536)
            self.assertEqual(meta["eos_id"], 61_440)
            self.assertEqual(meta["dtype"], "uint16")
            self.assertEqual(meta["shards"], 3)
            self.assertEqual(meta["tokenizer_sha256"], TOKENIZER_HASH)
            self.assertEqual(
                meta["stream_sha256"], sha256_file(out + ".bin")
            )
            self.assertEqual(len(meta["shard_records"]), 3)
            for record, prefix in zip(meta["shard_records"], [a, b, c]):
                self.assertEqual(
                    record["bin_sha256"], sha256_file(prefix + ".bin")
                )
                self.assertEqual(
                    record["meta_sha256"], sha256_file(prefix + ".json")
                )

    def test_rejects_mismatched_vocab_dtype_or_tokenizer(self):
        with tempfile.TemporaryDirectory() as directory:
            a = _write_shard(directory, "a", [1, 61_440])
            bad_vocab = _write_shard(
                directory,
                "bad-vocab",
                [1, 2],
                vocab=32_000,
                eos=2,
                protocol_start=31_000,
            )
            with self.assertRaisesRegex(ValueError, "vocab_size"):
                cs.concat(
                    [a, bad_vocab], os.path.join(directory, "out-vocab")
                )

            bad_hash = _write_shard(
                directory,
                "bad-hash",
                [1, 61_440],
                tokenizer_hash="abcdef0123456789" * 4,
            )
            with self.assertRaisesRegex(ValueError, "tokenizer_sha256"):
                cs.concat(
                    [a, bad_hash], os.path.join(directory, "out-hash")
                )

    def test_rejects_truncated_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            prefix = _write_shard(
                directory, "broken", [1, 2, 61_440]
            )
            with open(prefix + ".bin", "rb+") as stream:
                stream.truncate(2)
            with self.assertRaisesRegex(ValueError, "binary size"):
                cs.concat([prefix], os.path.join(directory, "out"))

    def test_rejects_incomplete_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            prefix = _write_shard(directory, "a", [1, 61_440])
            with open(prefix + ".json", encoding="utf-8") as stream:
                meta = json.load(stream)
            del meta["tokenizer_sha256"]
            with open(prefix + ".json", "w", encoding="utf-8") as stream:
                json.dump(meta, stream)
            with self.assertRaisesRegex(ValueError, "metadata missing"):
                cs.concat([prefix], os.path.join(directory, "out"))

    def test_interleave_mixes_groups_round_robin(self):
        with tempfile.TemporaryDirectory() as directory:
            ro0 = _write_shard(directory, "ro-00000", [1, 61_440])
            ro1 = _write_shard(directory, "ro-00001", [3, 61_440])
            en0 = _write_shard(directory, "en-00000", [5, 61_440])
            en1 = _write_shard(directory, "en-00001", [6, 61_440])
            order = cs.interleave_prefixes(
                {"ro": [ro0, ro1], "en": [en0, en1]}
            )
            self.assertEqual(
                [os.path.basename(path) for path in order],
                ["ro-00000", "en-00000", "ro-00001", "en-00001"],
            )


if __name__ == "__main__":
    unittest.main()
