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
            self.assertEqual(set(rows[0].keys()), {"path", "text"})
            self.assertEqual(rows[0]["path"], "row/000000000000")
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

    def test_cli_sample_rejects_unapproved_sources_before_streaming(self):
        with tempfile.TemporaryDirectory() as d:
            rights = os.path.join(d, "rights.json")
            with open(rights, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "schema_version": 1,
                        "policy": "test",
                        "sources": {
                            "tinystories": {
                                "status": "REVIEW_REQUIRED",
                                "commercial_use_approved": False,
                                "review_ref": "",
                            }
                        },
                    },
                    f,
                )
            output = os.path.join(d, "sample.txt")
            with self.assertRaisesRegex(ValueError, "not approved"):
                pc.main(
                    [
                        "--sources",
                        "tinystories",
                        "--tokenizer-sample",
                        output,
                        "--rights-registry",
                        rights,
                    ]
                )
            self.assertFalse(os.path.exists(output))

    def test_cli_sample_requires_source_lock_when_evidence_is_configured(self):
        with tempfile.TemporaryDirectory() as d:
            rights = os.path.join(d, "rights.json")
            with open(rights, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "schema_version": 1,
                        "policy": "manual-rights-review-required-v1",
                        "evidence": {
                            "filename": "evidence.json",
                            "sha256": "a" * 64,
                            "source_lock_sha256": "b" * 64,
                        },
                        "sources": {
                            "tinystories": {
                                "status": "APPROVED",
                                "commercial_use_approved": True,
                                "review_ref": "review-1",
                                "declared_license": "CDLA-Sharing-1.0",
                            }
                        },
                    },
                    f,
                )
            output = os.path.join(d, "sample.txt")
            with self.assertRaisesRegex(ValueError, "requires --source-lock"):
                pc.main(
                    [
                        "--sources",
                        "tinystories",
                        "--tokenizer-sample",
                        output,
                        "--rights-registry",
                        rights,
                    ]
                )
            self.assertFalse(os.path.exists(output))


class SourceRegistryTests(unittest.TestCase):
    def test_known_sources_have_loader_and_language(self):
        for name in [
            "tinystories",
            "wiki_ro",
            "wiki_en",
            "fineweb2_ro",
            "fineweb_edu",
            "openmath_reasoning_cot",
            "openscience_reasoning_2",
            "opencode_reasoning_split0",
        ]:
            src = pc.SOURCES[name]
            self.assertIn(src.lang, ("ro", "en"))
            self.assertTrue(callable(src.stream))
            self.assertTrue(src.hf_id)

    def test_openmath_reasoning_cot_shapes_rows_and_preserves_raw_indexes(self):
        rows = [
            {"problem": "x"},
            {
                "problem": "Compute the exact value of 17 times 19.",
                "generated_solution": "<think>Multiply carefully.</think> The answer is 323.",
                "problem_source": "MATH_training_set",
                "generation_model": "DeepSeek-R1",
                "problem_type": "has_answer_extracted",
                "expected_answer": "323",
                "used_in_kaggle": False,
            },
            {
                "problem": "Show that the sum of two even integers is even.",
                "generated_solution": "Write the integers as 2a and 2b. Their sum is 2(a+b).",
            },
        ]
        out = list(pc._openmath_reasoning_cot_from(rows, max_samples=None, skip=7))
        self.assertEqual([row[0] for row in out], [8, 9])
        self.assertIn("Problem:\nCompute the exact value", out[0][1])
        self.assertIn("Solution:\nMultiply carefully. The answer is 323.", out[0][1])
        self.assertNotIn("<think>", out[0][1])
        self.assertEqual(out[0][2]["path"], "cot/000000000008")
        self.assertEqual(out[0][2]["problem_source"], "MATH_training_set")
        self.assertEqual(out[0][2]["generation_model"], "DeepSeek-R1")
        self.assertEqual(out[0][2]["problem_type"], "has_answer_extracted")
        self.assertEqual(out[0][2]["expected_answer"], "323")
        self.assertIs(out[0][2]["used_in_kaggle"], False)

    def test_openscience_reasoning_2_requires_prompt_and_reasoning(self):
        rows = [
            {"input": "", "output": "ignored", "expected_answer": "A"},
            {
                "input": "Which mechanism best explains the observation?",
                "output": "<think>Compare the mechanisms.</think> Choice C follows from the evidence.",
                "expected_answer": "C",
            },
        ]
        out = list(pc._openscience_reasoning_2_from(rows, max_samples=None, skip=20))
        self.assertEqual([row[0] for row in out], [21])
        self.assertIn("Expected answer:\nC", out[0][1])
        self.assertNotIn("<think>", out[0][1])
        self.assertEqual(out[0][2]["expected_answer"], "C")

    def test_opencode_reasoning_split0_filters_license_and_missing_prompt(self):
        rows = [
            {"dataset": "code_contests", "license": "gpl-3.0", "input": "problem", "output": "reasoning", "solution": "code"},
            {"dataset": "apps", "license": "CC-BY-4.0", "input": "problem", "output": "reasoning", "solution": "code"},
            {"dataset": "code_contests", "license": "cc-by-4.0", "input": "-", "output": "reasoning", "solution": "code"},
            {
                "dataset": "code_contests",
                "license": "CC-BY-4.0",
                "input": "Return the sum of two integers from stdin.",
                "output": "<think>Parse both values.</think> Print their sum.",
                "solution": "a, b = map(int, input().split())\nprint(a + b)",
            },
        ]
        out = list(pc._opencode_reasoning_split0_from(rows, max_samples=None, skip=4))
        self.assertEqual([row[0] for row in out], [7])
        self.assertIn("Reference solution:\na, b = map", out[0][1])
        self.assertNotIn("<think>", out[0][1])
        self.assertEqual(out[0][2]["license"], "cc-by-4.0")
        self.assertEqual(out[0][2]["dataset"], "code_contests")
        self.assertEqual(out[0][2]["path"], "split_0/000000000007")

    def test_wiki_preserves_attribution_metadata_per_chunk(self):
        rows = [
            {
                "id": "12345",
                "title": "Attribution Test",
                "url": "https://en.wikipedia.org/wiki/Attribution_Test",
                "text": (
                    "This is a sufficiently long first paragraph with useful encyclopedic text.\n\n"
                    "This is a second sufficiently long paragraph with more useful encyclopedic text."
                ),
            }
        ]
        out = list(pc._wiki_from_rows(rows, max_samples=None, skip=9))
        self.assertTrue(out)
        self.assertEqual(out[0][0], 9)
        self.assertEqual(out[0][2]["article_id"], "12345")
        self.assertEqual(out[0][2]["title"], "Attribution Test")
        self.assertEqual(
            out[0][2]["article_url"],
            "https://en.wikipedia.org/wiki/Attribution_Test",
        )
        self.assertTrue(out[0][2]["path"].startswith("article/12345/"))

    def test_writer_preserves_metadata_and_rejects_text_override(self):
        with tempfile.TemporaryDirectory() as d:
            docs = iter(
                [
                    (
                        7,
                        "licensed reasoning document",
                        {
                            "path": "split_0/0007",
                            "license": "mit",
                            "record_id": "abc",
                        },
                    )
                ]
            )
            self.assertEqual(pc.write_shards(docs, d, "licensed", shard_docs=10), 1)
            with open(os.path.join(d, "licensed-00000.jsonl"), encoding="utf-8") as f:
                row = json.loads(next(f))
            self.assertEqual(row["path"], "split_0/0007")
            self.assertEqual(row["license"], "mit")
            self.assertEqual(row["record_id"], "abc")
            self.assertEqual(row["text"], "licensed reasoning document")

        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError, "cannot override text"):
                pc.write_shards(
                    iter([(1, "document", {"text": "replacement"})]),
                    d,
                    "bad",
                    shard_docs=10,
                )

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
