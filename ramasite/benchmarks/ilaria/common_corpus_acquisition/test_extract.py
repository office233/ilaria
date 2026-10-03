import importlib.util
import json
from pathlib import Path
import sys as _nexus_sys
_nexus_sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nexus_ilaria_benchmark_paths import ilaria_root
import pytest

spec = importlib.util.spec_from_file_location("extract_pd_books", Path(__file__).with_name("extract_pd_books.py"))
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)


@pytest.mark.parametrize("text", ["A" * 8001, "alpha beta. " * 900, "first\nsecond " * 700])
def test_segmenter_preserves_all_nonwhitespace_characters_without_clipping(text):
    segments = list(extract.paragraph_segments(text))
    assert all(0 < len(s) <= 2800 for s in segments)
    assert "".join("".join(s.split()) for s in segments) == "".join(text.split())


def test_date_normalization_is_typed_literal_not_calendar_inference():
    assert extract.metadata_value(1901) == "1901"
    assert extract.metadata_value("1901-02-03") == "1901-02-03"
    assert extract.metadata_value(None) is None
    with pytest.raises(ValueError, match="scalar type"):
        extract.metadata_value(1901.5)


def test_new_manifest_refuses_overwrite_and_budget_overrun(tmp_path):
    path = tmp_path / "manifest.json"
    extract.write_new_json(path, {"original": True}, extract.Budget())
    before = path.read_bytes()
    with pytest.raises(FileExistsError):
        extract.write_new_json(path, {"changed": True}, extract.Budget())
    assert path.read_bytes() == before
    with pytest.raises(ValueError, match="output cap"):
        extract.Budget(max_bytes=2).check(3)


def test_seed_dedup_uses_canonical_normalization_and_hash_gate(tmp_path):
    import sys
    sys.path.insert(0, str(ilaria_root(__file__) / "forge"))
    from data_audit import document_sha256
    candidate = tmp_path / "candidate.jsonl"
    candidate.write_text(json.dumps({"text": "A  natural Language paragraph"}) + "\n", encoding="utf-8")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"output_file": candidate.name, "output_sha256": extract.sha256_file(candidate),
                                   "candidate_documents_after_cleaning_and_exact_dedup": 1}), encoding="utf-8")
    seen = set()
    record = extract.seed_dedup(manifest, document_sha256, seen)
    assert document_sha256("a natural language PARAGRAPH") in seen
    assert record["documents"] == 1
    candidate.write_text("tampered", encoding="utf-8")
    with pytest.raises(ValueError, match="seed hash mismatch"):
        extract.seed_dedup(manifest, document_sha256, seen)
