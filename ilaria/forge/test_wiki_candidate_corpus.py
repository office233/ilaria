from __future__ import annotations

import json

import pytest

from wiki_candidate_corpus import (
    GENERAL_LANE,
    article_chunks,
    classify_article,
    load_topic_policy,
    write_candidate_corpus,
)


def policy_path():
    from pathlib import Path

    return Path(__file__).resolve().parent / "config" / "wiki_en_topics.json"


def article(article_id: str, title: str, lead: str) -> dict:
    body = "\n\n".join([lead] * 5)
    return {
        "id": article_id,
        "url": f"https://en.wikipedia.org/wiki/{article_id}",
        "title": title,
        "text": body,
    }


def test_topic_policy_classifies_high_signal_titles_and_general_fallback():
    policy = load_topic_policy(policy_path())
    assert classify_article("Linear algebra", "A branch of mathematics.", policy) == "mathematics"
    assert classify_article("Quantum mechanics", "A theory in physics.", policy) == "science_technical_reasoning"
    assert classify_article("History of London", "London has a long recorded history.", policy) == GENERAL_LANE


def test_ambiguous_topic_evidence_falls_back_to_general():
    policy = load_topic_policy(policy_path())
    assert classify_article("Mathematics and physics", "Interdisciplinary overview.", policy) == GENERAL_LANE


def test_article_chunks_preserve_provenance_and_lane_path():
    policy = load_topic_policy(policy_path())
    rows = article_chunks(
        7,
        article(
            "42",
            "Number theory",
            "Number theory is a branch of mathematics studying integers and prime numbers in mathematical systems.",
        ),
        policy,
    )
    assert rows
    assert all(row["path"].startswith("mathematics/42/") for row in rows)
    assert all(row["article_id"] == "42" and row["source_row"] == 7 for row in rows)
    assert all(row["url"].startswith("https://en.wikipedia.org/") for row in rows)


def test_writer_is_content_addressed_and_resumable(tmp_path):
    policy = load_topic_policy(policy_path())
    source = {
        "name": "wiki_en",
        "provider": "wikimedia/wikipedia",
        "config": "20231101.en",
        "revision": "a" * 40,
        "language": "en",
    }
    first = [
        (0, article("1", "Linear algebra", "Linear algebra studies vector space and matrix mathematics.")),
        (1, article("2", "London", "London is a city with a long history and many neighbourhoods.")),
    ]
    manifest = write_candidate_corpus(
        first, out_dir=tmp_path, source_identity=source, policy=policy, shard_docs=2
    )
    assert manifest["raw_rows"] == 2
    assert manifest["docs"] > 0
    assert manifest["topic_docs"]["mathematics"] > 0
    assert manifest["topic_docs"][GENERAL_LANE] > 0
    for record in manifest["shard_records"]:
        assert len(record["sha256"]) == 64

    manifest = write_candidate_corpus(
        [(2, article("3", "Chemistry", "Chemistry studies atom molecule and chemical reactions."))],
        out_dir=tmp_path,
        source_identity=source,
        policy=policy,
        shard_docs=2,
    )
    assert manifest["raw_rows"] == 3
    assert manifest["topic_docs"]["science_technical_reasoning"] > 0


def test_writer_detects_shard_tampering(tmp_path):
    policy = load_topic_policy(policy_path())
    source = {
        "name": "wiki_en",
        "provider": "wikimedia/wikipedia",
        "config": "20231101.en",
        "revision": "a" * 40,
        "language": "en",
    }
    manifest = write_candidate_corpus(
        [(0, article("1", "London", "London has a long and documented urban history."))],
        out_dir=tmp_path,
        source_identity=source,
        policy=policy,
        shard_docs=1,
    )
    shard = tmp_path / manifest["shard_records"][0]["filename"]
    shard.write_text("tampered\n", encoding="utf-8")
    with pytest.raises(ValueError, match="size changed|hash changed"):
        write_candidate_corpus(
            [], out_dir=tmp_path, source_identity=source, policy=policy, shard_docs=1
        )
