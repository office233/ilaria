"""imc_data: English token-stream builder, tested offline with fake sources."""
import json
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from imc_data import MIX, Source, build, check_mix, collect, interleave, read_docs  # noqa: E402
from train_ilaria import load_stream  # noqa: E402

WORDS = "the cortex learns code math and language from verified data every day".split()


def fake_stream(src):
    rng = np.random.default_rng(abs(hash(src.name)) % 2**32)
    for i in range(100000):
        n = int(rng.integers(5, 40))
        yield f"{src.name} doc {i}: " + " ".join(WORDS[int(k)] for k in rng.integers(0, len(WORDS), n))


MINI = (Source("web", "x/web", None, 0.75), Source("code", "x/code", None, 0.25, 3.2))


def run(tmp_path, name="out"):
    return build(tmp_path / name, tokens=4000, vocab_size=300, tokenizer_sample_chars=20000,
                 seed=7, mix=MINI, stream=fake_stream)


def test_default_mix_is_valid_and_english_only():
    check_mix(MIX)
    assert not any("ro" in s.name.split("-") or "ron" in (s.config or "") for s in MIX)


def test_check_mix_rejects_bad_shares():
    with pytest.raises(ValueError):
        check_mix([Source("a", "x", None, 0.5)])


def test_collect_keeps_whole_documents_and_detects_exhaustion(tmp_path):
    src = Source("web", "x", None, 1.0)
    stats = collect(src, 500, fake_stream, tmp_path / "web.jsonl")
    docs = list(read_docs(tmp_path / "web.jsonl"))
    assert len(docs) == stats["documents"] and sum(map(len, docs)) == stats["characters"]
    assert stats["characters"] >= 500 and sum(map(len, docs[:-1])) < 500
    with pytest.raises(ValueError):
        collect(src, 10**9, lambda s: iter(["short"]), tmp_path / "x.jsonl")


def test_line_separators_inside_documents_survive(tmp_path):
    text = "first line\u2028still the same document\nand a newline"
    collect(Source("web", "x", None, 1.0), 1, lambda s: iter([text]), tmp_path / "w.jsonl")
    assert list(read_docs(tmp_path / "w.jsonl")) == [text]


def test_interleave_yields_every_document_once(tmp_path):
    raw, counts = {}, {}
    for name, n in (("a", 30), ("b", 5)):
        raw[name] = tmp_path / f"{name}.jsonl"
        raw[name].write_text("".join(json.dumps(f"{name}{i}") + "\n" for i in range(n)), encoding="utf-8")
        counts[name] = n
    got = [text for _, text in interleave(raw, counts, seed=1)]
    assert sorted(got) == sorted([f"a{i}" for i in range(30)] + [f"b{i}" for i in range(5)])
    assert got != sorted(got)


def test_stream_is_loadable_and_consistent(tmp_path):
    meta = run(tmp_path)
    data, loaded = load_stream(str(tmp_path / "out" / "stream"))
    assert len(data) == meta["tokens"] == sum(meta["tokens_by_source"].values())
    assert loaded["vocab_size"] <= 300 and loaded["eos_id"] == meta["eos_id"]
    assert int((np.asarray(data) == meta["eos_id"]).sum()) == meta["documents"]
    shares = {k: v / meta["tokens"] for k, v in meta["tokens_by_source"].items()}
    assert 0.6 < shares["web"] < 0.9


def test_tokenizer_round_trips_a_document(tmp_path):
    from tokenizers import Tokenizer
    run(tmp_path)
    tok = Tokenizer.from_file(str(tmp_path / "out" / "tokenizer.json"))
    text = "code doc 3: the cortex learns math"
    assert tok.decode(tok.encode(text).ids) == text


def test_build_is_deterministic_and_refuses_a_used_directory(tmp_path):
    a, b = run(tmp_path, "a"), run(tmp_path, "b")
    assert a["sha256"] == b["sha256"]
    with pytest.raises(FileExistsError):
        run(tmp_path, "a")
    assert json.loads((tmp_path / "a" / "stream.json").read_text())["mix"]["web"]["share"] == 0.75
    assert not (tmp_path / "a" / "raw").exists()


def test_continuation_reuses_tokenizer_skips_used_documents_and_concatenates(tmp_path):
    from tokenizers import Tokenizer
    from concat_streams import concat
    first = run(tmp_path, "first")
    assert first["documents_by_source"]["web"] > 0
    second = build(tmp_path / "second", tokens=4000, vocab_size=300, tokenizer_sample_chars=20000, seed=8,
                   mix=MINI, stream=fake_stream, keep_raw=True,
                   tokenizer=tmp_path / "first" / "tokenizer.json", skip=first["documents_by_source"])
    a = Tokenizer.from_file(str(tmp_path / "first" / "tokenizer.json")).get_vocab()
    b = Tokenizer.from_file(str(tmp_path / "second" / "tokenizer.json")).get_vocab()
    assert a == b and second["eos_id"] == first["eos_id"]
    for name, used in first["documents_by_source"].items():
        docs = list(read_docs(tmp_path / "second" / "raw" / f"{name}.jsonl"))
        assert docs[0].startswith(f"{name} doc {used}:"), docs[0][:40]
    assert second["skipped_by_source"] == first["documents_by_source"]
    merged = concat([str(tmp_path / "first" / "stream"), str(tmp_path / "second" / "stream")], str(tmp_path / "all"))
    data, _ = load_stream(str(tmp_path / "all"))
    assert len(data) == first["tokens"] + second["tokens"] == merged["tokens"]


def test_skip_rejects_unknown_sources(tmp_path):
    with pytest.raises(ValueError):
        build(tmp_path / "x", tokens=4000, vocab_size=300, tokenizer_sample_chars=20000, seed=1,
              mix=MINI, stream=fake_stream, skip={"nope": 3})
