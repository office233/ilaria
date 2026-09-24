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


class ScrubPiiTests(unittest.TestCase):
    def test_masks_email_phone_and_iban(self):
        text = ("Scrieți la ion.popescu@exemplu.ro sau sunați la 0723 882 313 ori +40 756 582 225. "
                "Plata în contul RO49AAAA1B31007593840000.")
        out = pc.scrub_pii(text)
        self.assertNotIn("ion.popescu@exemplu.ro", out)
        self.assertNotIn("882 313", out)
        self.assertNotIn("582 225", out)
        self.assertNotIn("RO49AAAA1B31007593840000", out)
        self.assertIn("[EMAIL]", out)
        self.assertEqual(out.count("[PHONE]"), 2)
        self.assertIn("[IBAN]", out)

    def test_keeps_years_numbers_and_ordinary_text(self):
        text = "În 1859, la 24 ianuarie, s-au unit 2 principate; populația era de 3.864.848 locuitori."
        self.assertEqual(pc.scrub_pii(text), text)

    def test_clean_text_applies_scrubbing(self):
        out = pc.clean_text("Contact pentru presă: contact@firma.ro, program de luni până vineri.")
        self.assertIn("[EMAIL]", out)
        self.assertNotIn("contact@firma.ro", out)


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
    def test_writes_shards_and_records_raw_rows_for_resume(self):
        with tempfile.TemporaryDirectory() as d:
            # docs come as (raw_row_index, text); raw rows 0..49, every other row was filtered out
            docs = [(2 * i, f"document numărul {i} " * 5) for i in range(25)]
            n = pc.write_shards(iter(docs), d, "wiki_ro", shard_docs=10)
            self.assertEqual(n, 25)
            files = sorted(f for f in os.listdir(d) if f.endswith(".jsonl"))
            self.assertEqual(files, ["wiki_ro-00000.jsonl", "wiki_ro-00001.jsonl", "wiki_ro-00002.jsonl"])
            with open(os.path.join(d, files[0]), encoding="utf-8") as f:
                rows = [json.loads(l) for l in f]
            self.assertEqual(len(rows), 10)
            self.assertEqual(set(rows[0].keys()), {"text"})
            self.assertTrue(pc.manifest_path(d, "wiki_ro").endswith("wiki_ro.manifest.json"))
            with open(pc.manifest_path(d, "wiki_ro"), encoding="utf-8") as f:
                man = json.load(f)
            self.assertEqual(man["docs"], 25)
            self.assertEqual(man["shards"], 3)
            self.assertEqual(man["complete"], [0, 1, 2])
            self.assertEqual(man["raw_rows"], 49)  # last raw index (48) + 1 → HF stream .skip(49) resumes exactly
            # Resume: the caller skips 49 raw rows in the stream and appends from shard 3.
            plan = pc.resume_plan(d, "wiki_ro", limit=40)
            self.assertEqual(plan, {"skip_rows": 49, "skip_docs": 0, "start_shard": 3, "remaining": 15})
            more = [(49 + i, f"nou {i} " * 5) for i in range(15)]
            n2 = pc.write_shards(iter(more), d, "wiki_ro", shard_docs=10, start_shard=3)
            self.assertEqual(n2, 15)
            files = sorted(f for f in os.listdir(d) if f.endswith(".jsonl"))
            self.assertEqual(files[-2:], ["wiki_ro-00003.jsonl", "wiki_ro-00004.jsonl"])
            with open(pc.manifest_path(d, "wiki_ro"), encoding="utf-8") as f:
                man = json.load(f)
            self.assertEqual(man["docs"], 40)
            self.assertEqual(man["complete"], [0, 1, 2, 3, 4])
            self.assertEqual(man["raw_rows"], 64)
            self.assertEqual(pc.resume_plan(d, "wiki_ro", limit=40)["remaining"], 0)

    def test_resume_plan_without_manifest_starts_fresh(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(pc.resume_plan(d, "x", limit=7),
                             {"skip_rows": 0, "skip_docs": 0, "start_shard": 0, "remaining": 7})

    def test_resume_plan_handles_manifest_without_raw_rows(self):
        with tempfile.TemporaryDirectory() as d:
            with open(pc.manifest_path(d, "old"), "w", encoding="utf-8") as f:
                json.dump({"docs": 120, "shards": 3, "shard_docs": 50, "complete": [0, 1, 2]}, f)
            self.assertEqual(pc.resume_plan(d, "old", limit=200),
                             {"skip_rows": 0, "skip_docs": 120, "start_shard": 3, "remaining": 80})


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

    def test_docs_generator_yields_raw_index_and_honours_skip(self):
        rows = [{"text": "x"}, {"text": "un text suficient de lung ca să treacă filtrul de lungime"},
                {"text": "|| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 ||"},
                {"text": "alt text suficient de lung ca să treacă filtrul de lungime"}]

        class FakeDS:
            def __init__(self, rows):
                self.rows = rows

            def skip(self, n):
                return FakeDS(self.rows[n:])

            def __iter__(self):
                return iter(self.rows)

        out = list(pc._docs_from(FakeDS(rows), max_samples=None, max_len=3000, skip=0))
        self.assertEqual([i for i, _ in out], [1, 3])
        out = list(pc._docs_from(FakeDS(rows).skip(2), max_samples=None, max_len=3000, skip=2))
        self.assertEqual([i for i, _ in out], [3])


if __name__ == "__main__":
    unittest.main()
