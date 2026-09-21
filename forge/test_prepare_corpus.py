"""Unit tests for forge/prepare_corpus.py (stdlib unittest; no network).

Run:  python -m unittest forge.test_prepare_corpus -v
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from forge import prepare_corpus as pc  # noqa: E402


class CleanTextTests(unittest.TestCase):
    def test_normalizes_whitespace_and_keeps_diacritics(self):
        self.assertEqual(pc.clean_text("Ștefan   cel Mare\n\n\n\nera domn."), "Ștefan cel Mare\n\nera domn.")

    def test_drops_short_and_cuts_long_at_sentence(self):
        self.assertEqual(pc.clean_text("scurt"), "")
        long = ("Propoziție lungă. " * 300).strip()
        cut = pc.clean_text(long, max_len=200)
        self.assertLessEqual(len(cut), 200)
        self.assertTrue(cut.endswith("."))

    def test_rejects_boilerplate_and_low_alpha(self):
        self.assertEqual(pc.clean_text("|| 12 | 34 | 56 | 78 | 90 | 11 | 22 | 33 | 44 ||"), "")
        self.assertEqual(pc.clean_text("Cookie policy: accept all cookies to continue browsing this site now"), "")


class ChunkTests(unittest.TestCase):
    def test_chunk_paragraphs_groups_to_target_and_skips_headings(self):
        text = "== Titlu ==\n\n" + "\n\n".join(f"Paragraful {i} are suficient text ca să conteze aici." for i in range(6))
        chunks = list(pc.chunk_paragraphs(text, target_chars=120))
        self.assertGreaterEqual(len(chunks), 2)
        for c in chunks:
            self.assertNotIn("==", c)
            self.assertGreaterEqual(len(c), 30)


class ShardWriterTests(unittest.TestCase):
    def test_writes_shards_and_resumes(self):
        with tempfile.TemporaryDirectory() as d:
            docs = [f"document numărul {i} " * 5 for i in range(25)]
            n = pc.write_shards(iter(docs), d, "wiki_ro", shard_docs=10)
            self.assertEqual(n, 25)
            files = sorted(f for f in os.listdir(d) if f.endswith(".jsonl"))
            self.assertEqual(files, ["wiki_ro-00000.jsonl", "wiki_ro-00001.jsonl", "wiki_ro-00002.jsonl"])
            with open(os.path.join(d, files[0]), encoding="utf-8") as f:
                rows = [json.loads(l) for l in f]
            self.assertEqual(len(rows), 10)
            self.assertEqual(set(rows[0].keys()), {"text"})
            # A second run with the same source skips the finished shards (resumable on Drive).
            calls = []
            n2 = pc.write_shards(iter(docs), d, "wiki_ro", shard_docs=10, on_skip=calls.append)
            self.assertEqual(n2, 25)
            self.assertEqual(len(calls), 3)
            self.assertTrue(pc.manifest_path(d, "wiki_ro").endswith("wiki_ro.manifest.json"))
            with open(pc.manifest_path(d, "wiki_ro"), encoding="utf-8") as f:
                man = json.load(f)
            self.assertEqual(man["docs"], 25)
            self.assertEqual(man["shards"], 3)


class TokenizerSampleTests(unittest.TestCase):
    def test_sample_interleaves_languages_and_caps_size(self):
        ro = (f"Textul românesc numărul {i} cu diacritice: ăâîșț." for i in range(1000))
        en = (f"English text number {i} for the tokenizer sample." for i in range(1000))
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "sample.txt")
            stats = pc.write_tokenizer_sample({"ro": ro, "en": en}, path, max_bytes=20_000)
            self.assertLessEqual(os.path.getsize(path), 20_000 + 200)
            self.assertGreater(stats["ro"], 0)
            self.assertGreater(stats["en"], 0)
            self.assertLess(abs(stats["ro"] - stats["en"]), 3)  # interleaved 1:1


class SourceRegistryTests(unittest.TestCase):
    def test_known_sources_have_loader_and_language(self):
        for name in ["tinystories", "wiki_ro", "wiki_en", "fineweb2_ro", "fineweb_edu"]:
            src = pc.SOURCES[name]
            self.assertIn(src.lang, ("ro", "en"))
            self.assertTrue(callable(src.stream))
            self.assertTrue(src.hf_id)


if __name__ == "__main__":
    unittest.main()
