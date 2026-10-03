import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_audit import audit, normalize_text  # noqa: E402


def write_jsonl(path, texts):
    path.write_text(
        "".join(json.dumps({"text": text}) + "\n" for text in texts),
        encoding="utf-8",
    )


def test_normalization_makes_exact_dedup_unicode_and_case_stable():
    assert normalize_text("  ȘTEFAN   cel Mare ") == normalize_text(
        "Ștefan cel Mare"
    )


def test_audit_detects_duplicates_without_raw_text(tmp_path):
    shard = tmp_path / "corpus.jsonl"
    secret = "UNIQUE SENSITIVE FIXTURE 991837"
    write_jsonl(shard, [secret, "other document", secret.lower()])
    report = audit([str(shard)], [], shingle_width=3)

    assert report["totals"]["documents"] == 3
    assert report["totals"]["duplicate_documents"] == 1
    assert not report["passed"]
    encoded = json.dumps(report)
    assert secret not in encoded
    assert secret.lower() not in encoded


def test_audit_detects_hashed_benchmark_contamination(tmp_path):
    benchmark = tmp_path / "bench.jsonl"
    benchmark.write_text(
        json.dumps(
            {
                "prompt": "alpha beta gamma delta epsilon zeta eta theta",
                "answer": "synthetic answer",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    shard = tmp_path / "corpus.jsonl"
    write_jsonl(
        shard,
        [
            "unrelated corpus sentence with enough distinct words here",
            "prefix alpha beta gamma delta epsilon zeta eta theta suffix",
        ],
    )
    report = audit(
        [str(shard)], [str(benchmark)], shingle_width=6
    )
    assert report["totals"]["contaminated_documents"] == 1
    assert len(report["contaminated_locations"]) == 1
    assert not report["passed"]
    assert "alpha beta gamma" not in json.dumps(report)


def test_clean_corpus_passes_and_is_deterministic(tmp_path):
    shard = tmp_path / "corpus.jsonl"
    benchmark = tmp_path / "bench.txt"
    write_jsonl(
        shard,
        [
            "one completely unrelated training document",
            "second unrelated training document with other words",
        ],
    )
    benchmark.write_text(
        "held out evaluation phrase never present in corpus\n",
        encoding="utf-8",
    )
    a = audit([str(shard)], [str(benchmark)], shingle_width=5)
    b = audit([str(shard)], [str(benchmark)], shingle_width=5)
    assert a == b
    assert a["passed"]
    assert a["totals"]["duplicate_documents"] == 0
    assert a["totals"]["contaminated_documents"] == 0
