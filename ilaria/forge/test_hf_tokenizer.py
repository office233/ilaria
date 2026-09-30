"""Tests for the canonical IlariaLex tokenizer contract."""
import json
import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from forge import hf_tokenizer as ht  # noqa: E402


SAMPLE = [
    "Čtefan cel Mare a fost domnul Moldovei Ă®ntre 1457 Č™i 1504.",
    "ĂŽn aceastÄ dupÄ-amiazÄ, copiii Ă®nvaČ›Ä sÄ citeascÄ â€žcÄrČ›iâ€ť bune.",
    "The quick brown fox jumps over the lazy dog; don't panic!",
    "package main func compute value result error verify device sensor action.",
    "OBD CAN RPM voltage temperature throttle diagnostic vehicle telemetry.",
    "reasoning mathematics algebra geometry compiler runtime memory network.",
] * 80


class IlariaLexTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        sample = os.path.join(self.dir, "sample.txt")
        with open(sample, "w", encoding="utf-8", newline="\n") as stream:
            stream.write("\n".join(SAMPLE) + "\n")
        self.sample = sample
        self.out = os.path.join(self.dir, "ilarialex.json")
        self.reserve = 64
        self.vocab_size = 560
        self.base_size = self.vocab_size - self.reserve
        self.tok = ht.train(
            [sample],
            self.vocab_size,
            self.out,
            protocol_reserve=self.reserve,
        )

    def contract(self):
        with open(self.out, encoding="utf-8") as stream:
            return json.load(stream)

    def test_contract_is_exact_and_protocol_is_suffix(self):
        data = self.contract()
        self.assertEqual(data["format"], ht.ILARIALEX_FORMAT)
        self.assertEqual(data["vocab_size"], self.vocab_size)
        self.assertEqual(data["base_vocab_size"], self.base_size)
        self.assertEqual(data["protocol_reserved"], self.reserve)
        self.assertEqual(data["protocol_start_id"], self.base_size)
        self.assertTrue(data["byte_level"])

        specials = data["special_tokens"]
        self.assertEqual(len(specials), self.reserve)
        for offset, entry in enumerate(specials):
            self.assertEqual(entry["id"], self.base_size + offset)
            self.assertEqual(data["vocab"][entry["token"]], entry["id"])

        self.assertEqual(data["eos_token"], ht.EOS)
        self.assertEqual(data["eos_id"], self.base_size)
        self.assertEqual(data["bos_id"], self.base_size + 1)
        self.assertEqual(data["pad_id"], self.base_size + 2)

    def test_core_protocol_tokens_are_atomic(self):
        for token in ht._CORE_PROTOCOL_TOKENS:
            encoded = self.tok.encode(token, add_special_tokens=False).ids
            self.assertEqual(encoded, [self.tok.token_to_id(token)], token)

    def test_reload_from_canonical_json_is_identical(self):
        hf_sidecar = os.path.splitext(self.out)[0] + ".hf.json"
        os.remove(hf_sidecar)
        rebuilt = ht.load(self.out)
        self.assertEqual(rebuilt.get_vocab_size(), self.vocab_size)

        probes = SAMPLE[:6] + [
            ht.EOS,
            "<|action:execute|>",
            "<|device:vehicle|>",
        ]
        for text in probes:
            want = self.tok.encode(text, add_special_tokens=False).ids
            got = rebuilt.encode(text, add_special_tokens=False).ids
            self.assertEqual(got, want)
            self.assertEqual(rebuilt.decode(got, skip_special_tokens=False), text)

    def test_stream_layout_uses_canonical_eos_and_hash(self):
        shard = os.path.join(self.dir, "shard.jsonl")
        with open(shard, "w", encoding="utf-8", newline="\n") as stream:
            for text in SAMPLE[:3]:
                stream.write(json.dumps({"text": text}, ensure_ascii=False) + "\n")

        prefix = os.path.join(self.dir, "shard")
        meta = ht.encode_jsonl(self.tok, shard, prefix, self.out)
        ids = np.fromfile(prefix + ".bin", dtype=np.uint16)
        eos = self.tok.token_to_id(ht.EOS)

        self.assertEqual(meta["format"], "ilaria-token-stream-v1")
        self.assertEqual(meta["documents"], 3)
        self.assertEqual(meta["tokens"], len(ids))
        self.assertEqual(int((ids == eos).sum()), 3)
        self.assertEqual(int(ids[-1]), eos)
        self.assertEqual(meta["eos_id"], eos)
        self.assertEqual(meta["dtype"], "uint16")
        self.assertEqual(meta["tokenizer_format"], ht.ILARIALEX_FORMAT)
        self.assertEqual(meta["protocol_start_id"], self.base_size)
        self.assertEqual(meta["tokenizer_sha256"], ht.tokenizer_sha256(self.out))

    def test_uint16_boundary_includes_exact_65536_vocab(self):
        self.assertIs(ht.stream_dtype(65_535), np.uint16)
        self.assertIs(ht.stream_dtype(65_536), np.uint16)
        self.assertIs(ht.stream_dtype(65_537), np.uint32)

    def test_protocol_token_generation_is_deterministic(self):
        a = ht.protocol_tokens(64)
        b = ht.protocol_tokens(64)
        self.assertEqual(a, b)
        self.assertEqual(a[0], ht.EOS)
        self.assertEqual(len(a), len(set(a)))

    def test_too_small_protocol_reserve_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "protocol_reserve"):
            ht.train(
                [self.sample],
                560,
                os.path.join(self.dir, "bad.json"),
                protocol_reserve=1,
            )


if __name__ == "__main__":
    unittest.main()
