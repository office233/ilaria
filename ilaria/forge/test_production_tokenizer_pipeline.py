"""Owned synthetic materialization/replay; mocked train is not training proof."""
import builtins
import copy
import hashlib
import json
from pathlib import Path

import pytest

import production_tokenizer_pipeline as pipeline
import production_tokenizer_lineage as lineage
from corpus_source_lock import build_source_lock
from data_audit import document_sha256
from data_contract import atomic_write_json, canonical_json_sha256, sha256_file
from first_party_attestation import build_attestation_template
from git_source_lock import build_lock
from prepare_corpus import SOURCES
from rights_evidence import RIGHTS_EVIDENCE_FORMAT
from test_tokenizer_freeze import tokenizer_fixture

LIMITS = {"max_row_bytes": 8192, "max_document_bytes": 8192,
          "max_ledger_row_bytes": 16384, "max_metadata_bytes": 131072}


def seal(value, field):
    result = dict(value)
    result.pop(field, None)
    result[field] = canonical_json_sha256(result)
    return result


def fixture(root, rows=None):
    root.mkdir(parents=True, exist_ok=True)
    hf = build_source_lock({"tinystories": SOURCES["tinystories"]}, {"tinystories": "a" * 40})
    git = build_lock({"synthetic_git": {"url": "https://example.invalid/owned-fixture", "ref": "fixture", "commit": "b" * 40}})
    atomic_write_json(root / "hf.json", hf)
    atomic_write_json(root / "git.json", git)
    evidence = seal({"format": RIGHTS_EVIDENCE_FORMAT, "source_lock_sha256": hf["source_lock_sha256"],
        "git_source_lock_sha256": git["source_lock_sha256"], "sources": {"tinystories": {
            **hf["sources"]["tinystories"], "declared_license": "MIT", "review_state": "APPROVED",
            "unresolved_obligations": [], "evidence_urls": ["https://example.invalid/license"]}}}, "evidence_sha256")
    atomic_write_json(root / "evidence.json", evidence)
    rights = {"schema_version": 1, "policy": "owned-synthetic-fixture-v1", "sources": {"tinystories": {
        "status": "APPROVED", "commercial_use_approved": True, "declared_license": "MIT", "review_ref": "synthetic review"}},
        "evidence": {"filename": "evidence.json", "sha256": evidence["evidence_sha256"],
            "source_lock_sha256": hf["source_lock_sha256"], "git_source_lock_filename": "git.json",
            "git_source_lock_sha256": git["source_lock_sha256"]}}
    atomic_write_json(root / "rights.json", rights)
    rows = rows if rows is not None else [{"text": "  École\r\nＨello\t世界  ", "path": "src/one.txt", "license": "MIT", "language": "en",
        "arbitrary_nested": {"private": "never retained"}}, {"text": "Second document", "path": "src/two.txt"}, {"text": "Third"}]
    shards = []
    for index, part in enumerate((rows[:2], rows[2:])):
        shard = root / f"owned-{index}.jsonl"
        raw = b"\r\n" + b"\r\n".join(json.dumps(row, ensure_ascii=False).encode() for row in part) + b"\r\n"
        shard.write_bytes(raw)
        shards.append({"filename": shard.name, "index": index, "sha256": sha256_file(shard), "bytes": len(raw), "documents": len(part)})
    manifest = {"schema_version": 2, "source": {"name": "tinystories", **hf["sources"]["tinystories"], "language": "en"},
        "shard_records": shards, "docs": len(rows), "shards": 2}
    manifest_path = root / "owned.manifest.json"
    atomic_write_json(manifest_path, manifest)
    owned_root = root / "first-party-root"
    owned_root.mkdir()
    (owned_root / "native.swyp").write_bytes("record Owned { text: café }\r\n".encode())
    packet = build_attestation_template(owned_root, paths=["native.swyp"])
    packet.update(ownership_attested=True, attested_by="synthetic owner", review_ref="synthetic approved packet")
    packet = seal(packet, "attestation_sha256")
    atomic_write_json(root / "attestation.json", packet)
    plan = {"first_party_sources": ["first_party_contracts", "first_party_trajectories"],
        "tokenizer_coverage": {category: ["tinystories", "first_party_contracts"] for category in pipeline.REQUIRED_COVERAGE},
        "tokenizer_materialization_limits": LIMITS}
    atomic_write_json(root / "plan.json", plan)
    return {"root": root, "manifest": manifest, "manifest_path": manifest_path, "rows": rows,
        "rights": rights, "packet": packet, "first_root": owned_root,
        "authority": {"rights_registry_path": root / "rights.json", "source_lock_path": root / "hf.json",
                      "git_source_lock_path": root / "git.json", "materialization_limits": dict(LIMITS)}}


def materialize(f, target=1, filename="sample.txt"):
    return lineage.write_external_sample(f["manifest_path"], f["root"] / filename, target,
        source_name="tinystories", **f["authority"])


def replay(f, record):
    return lineage.validate_selection(f["root"] / record["selection"]["filename"], expected_input=record,
        source_manifest_path=f["manifest_path"], **f["authority"])


def guard(monkeypatch, paths):
    blocked = {path.resolve() for path in paths}
    original, original_path = builtins.open, Path.open
    def check(path):
        if isinstance(path, (str, Path)) and Path(path).resolve() in blocked:
            pytest.fail("forbidden payload opened before preflight: " + str(path))
    def opened(path, *args, **kwargs):
        check(path)
        return original(path, *args, **kwargs)
    def path_open(path, *args, **kwargs):
        check(path)
        return original_path(path, *args, **kwargs)
    monkeypatch.setattr(builtins, "open", opened)
    monkeypatch.setattr(Path, "open", path_open)


def test_selection_preserves_utf8_crlf_whole_document_target_and_offsets(tmp_path):
    f = fixture(tmp_path)
    first = (f["rows"][0]["text"].replace("\r", " ").replace("\n", " ").strip() + "\n").encode()
    record = materialize(f, len(first) + 1)
    metadata = replay(f, record)
    assert record["documents"] == 2 and record["bytes"] > len(first) + 1
    assert (tmp_path / "sample.txt").read_bytes() == first + b"Second document\n"
    entries = [json.loads(line) for line in (tmp_path / metadata["ledger"]["filename"]).read_bytes().splitlines()]
    assert entries[0]["input"]["line"] == 2 and entries[0]["input"]["byte_start"] == 2
    assert entries[0]["document_sha256"] == document_sha256(f["rows"][0]["text"])
    assert entries[0]["emitted"] == {"sha256": hashlib.sha256(first).hexdigest(), "bytes": len(first), "byte_start": 0, "byte_end": len(first)}
    assert entries[1]["emitted"]["byte_start"] == len(first)
    assert entries[0]["item_metadata"]["path"] == "src/one.txt"
    receipt = (tmp_path / metadata["ledger"]["filename"]).read_text()
    assert "never retained" not in receipt and f["rows"][0]["text"] not in receipt
    assert "group_id" not in receipt and "component_id" not in receipt


def test_selection_is_deterministic_across_new_output_directories(tmp_path):
    f = fixture(tmp_path / "source")
    left, right = tmp_path / "left", tmp_path / "right"
    left.mkdir(); right.mkdir()
    a = lineage.write_external_sample(f["manifest_path"], left / "sample.txt", 10000, source_name="tinystories", **f["authority"])
    b = lineage.write_external_sample(f["manifest_path"], right / "sample.txt", 10000, source_name="tinystories", **f["authority"])
    assert a == b and a["documents"] == 3
    assert (left / a["selection"]["filename"]).read_bytes() == (right / b["selection"]["filename"]).read_bytes()


@pytest.mark.parametrize("fault", ["name", "revision", "unsafe-second", "absolute", "symlink", "pending-rights", "pending-evidence"])
def test_source_preflight_rejects_before_any_shard_or_first_party_read(tmp_path, monkeypatch, fault):
    f = fixture(tmp_path)
    if fault == "name": f["manifest"]["source"]["name"] = "wrong-source"
    elif fault == "revision": f["manifest"]["source"]["revision"] = "c" * 40
    elif fault == "unsafe-second": f["manifest"]["shard_records"][1]["filename"] = "../outside.jsonl"
    elif fault == "absolute": f["manifest"]["shard_records"][1]["filename"] = "C:/private.jsonl"
    elif fault == "symlink":
        alias = tmp_path / "alias.jsonl"
        alias.symlink_to(tmp_path / "owned-1.jsonl")
        f["manifest"]["shard_records"][1]["filename"] = alias.name
    elif fault == "pending-rights":
        f["rights"]["sources"]["tinystories"]["status"] = "REVIEW_REQUIRED"
        atomic_write_json(tmp_path / "rights.json", f["rights"])
    elif fault == "pending-evidence":
        evidence = lineage.load_metadata(tmp_path / "evidence.json")
        evidence["sources"]["tinystories"]["review_state"] = "EVIDENCE_COLLECTED"
        evidence = seal(evidence, "evidence_sha256")
        atomic_write_json(tmp_path / "evidence.json", evidence)
        f["rights"]["evidence"]["sha256"] = evidence["evidence_sha256"]
        atomic_write_json(tmp_path / "rights.json", f["rights"])
    atomic_write_json(f["manifest_path"], f["manifest"])
    guard(monkeypatch, [tmp_path / "owned-0.jsonl", tmp_path / "owned-1.jsonl", f["first_root"] / "native.swyp"])
    with pytest.raises(ValueError): materialize(f)
    assert not (tmp_path / "sample.txt").exists()


@pytest.mark.parametrize("artifact", ["sample", "ledger", "manifest", "shard", "metadata"])
def test_replay_rejects_tampering(tmp_path, artifact):
    f = fixture(tmp_path)
    record = materialize(f, 10000)
    metadata = replay(f, record)
    paths = {"sample": tmp_path / "sample.txt", "ledger": tmp_path / metadata["ledger"]["filename"],
        "manifest": f["manifest_path"], "shard": tmp_path / "owned-0.jsonl", "metadata": tmp_path / record["selection"]["filename"]}
    paths[artifact].write_bytes(paths[artifact].read_bytes() + b" ")
    with pytest.raises((ValueError, json.JSONDecodeError)): replay(f, record)


def test_rehashed_fabricated_ledger_still_fails_exact_replay(tmp_path):
    f = fixture(tmp_path)
    record = materialize(f)
    metadata_path = tmp_path / record["selection"]["filename"]
    metadata = lineage.load_metadata(metadata_path)
    ledger = tmp_path / metadata["ledger"]["filename"]
    entry = json.loads(ledger.read_text())
    entry["item_metadata"]["path"] = "fabricated/path.txt"
    ledger.write_bytes(lineage.canonical_json_bytes(entry) + b"\n")
    metadata["ledger"].update(sha256=sha256_file(ledger), bytes=ledger.stat().st_size)
    atomic_write_json(metadata_path, seal(metadata, "selection_sha256"))
    with pytest.raises(ValueError, match="exact source replay"):
        lineage.validate_selection(metadata_path, source_manifest_path=f["manifest_path"], **f["authority"])


def test_oversized_physical_row_refused_before_json_parse(tmp_path, monkeypatch):
    f = fixture(tmp_path, [{"text": "x" * 1000}])
    f["authority"]["materialization_limits"]["max_row_bytes"] = 64
    original = lineage.json.loads
    def guarded(value, *args, **kwargs):
        if isinstance(value, str) and "x" * 100 in value: pytest.fail("oversized row parsed")
        return original(value, *args, **kwargs)
    monkeypatch.setattr(lineage.json, "loads", guarded)
    with pytest.raises(ValueError, match="row exceeds"): materialize(f)
    assert not (tmp_path / "sample.txt").exists()
    assert not list(tmp_path.glob("sample.txt.selection.*"))


def test_metadata_size_refusal_cleans_all_unpublished_outputs(tmp_path):
    f = fixture(tmp_path)
    # Source metadata fits; the larger selection receipt must refuse pre-publication.
    cap = f["manifest_path"].stat().st_size
    f["authority"]["materialization_limits"]["max_metadata_bytes"] = cap
    with pytest.raises(ValueError, match="selection metadata exceeds"):
        materialize(f)
    assert not (tmp_path / "sample.txt").exists()
    assert not list(tmp_path.glob("sample.txt.selection.*"))
    assert not list(tmp_path.glob(".sample.txt*.tmp"))


def test_git_provider_mismatch_refuses_before_any_shard_read(tmp_path, monkeypatch):
    f = fixture(tmp_path)
    locked = lineage.load_metadata(tmp_path / "git.json")["sources"]["synthetic_git"]
    f["manifest"]["source"].update(name="synthetic_git", provider="https://example.invalid/unreviewed",
        config=None, revision=locked["commit"])
    f["rights"]["sources"] = {"synthetic_git": f["rights"]["sources"]["tinystories"]}
    evidence = lineage.load_metadata(tmp_path / "evidence.json")
    evidence["sources"] = {"synthetic_git": dict(source_kind="git", **locked,
        declared_license="MIT", review_state="APPROVED", unresolved_obligations=[],
        evidence_urls=["https://example.invalid/license"])}
    evidence = seal(evidence, "evidence_sha256")
    atomic_write_json(tmp_path / "evidence.json", evidence)
    f["rights"]["evidence"]["sha256"] = evidence["evidence_sha256"]
    atomic_write_json(tmp_path / "rights.json", f["rights"])
    atomic_write_json(f["manifest_path"], f["manifest"])
    guard(monkeypatch, [tmp_path / "owned-0.jsonl", tmp_path / "owned-1.jsonl"])
    with pytest.raises(ValueError, match="Git lock"):
        lineage.write_external_sample(f["manifest_path"], tmp_path / "sample.txt", 1,
            source_name="synthetic_git", **f["authority"])
    assert not (tmp_path / "sample.txt").exists()


@pytest.mark.parametrize("operation", ["write", "replay"])
def test_unattested_first_party_path_refused_before_payload_read(tmp_path, monkeypatch, operation):
    f = fixture(tmp_path)
    forbidden = f["first_root"] / "unattested.swyp"
    forbidden.write_text("owned synthetic unreviewed payload\n", encoding="utf-8")
    kwargs = dict(attestation_path=tmp_path / "attestation.json", source_root=f["first_root"], materialization_limits=LIMITS)
    if operation == "replay":
        record = lineage.write_first_party_sample(tmp_path / "owned-copy.swyp", source_name="first_party_contracts",
            attested_path="native.swyp", **kwargs)
        metadata_path = tmp_path / record["selection"]["filename"]
        metadata = lineage.load_metadata(metadata_path)
        metadata["origin"]["attested_path"] = forbidden.name
        atomic_write_json(metadata_path, seal(metadata, "selection_sha256"))
    guard(monkeypatch, [forbidden])
    with pytest.raises(ValueError, match="attested"):
        if operation == "write":
            lineage.write_first_party_sample(tmp_path / "refused.swyp", source_name="first_party_contracts",
                attested_path=forbidden.name, **kwargs)
        else:
            lineage.validate_selection(metadata_path, **kwargs)
    assert not (tmp_path / "refused.swyp").exists()
    assert not list(tmp_path.glob("refused.swyp.selection.*"))


def test_first_party_copy_and_replay_bind_existing_packet_and_root(tmp_path):
    f = fixture(tmp_path)
    record = lineage.write_first_party_sample(tmp_path / "owned-copy.swyp", source_name="first_party_contracts",
        attested_path="native.swyp", attestation_path=tmp_path / "attestation.json", source_root=f["first_root"], materialization_limits=LIMITS)
    metadata = lineage.validate_selection(tmp_path / record["selection"]["filename"], expected_input=record,
        attestation_path=tmp_path / "attestation.json", source_root=f["first_root"], materialization_limits=LIMITS)
    assert metadata["sample"]["documents"] == 1
    assert (tmp_path / "owned-copy.swyp").read_bytes() == (f["first_root"] / "native.swyp").read_bytes()
    wrong = tmp_path / "wrong-root"
    wrong.mkdir()
    with pytest.raises(ValueError, match="first-party binding"):
        lineage.validate_selection(tmp_path / record["selection"]["filename"], attestation_path=tmp_path / "attestation.json",
            source_root=wrong, materialization_limits=LIMITS)


def test_no_overwrite_or_caller_approval_flags(tmp_path):
    f = fixture(tmp_path)
    record = materialize(f)
    before = (tmp_path / "sample.txt").read_bytes()
    with pytest.raises(ValueError, match="already exist"): materialize(f)
    assert (tmp_path / "sample.txt").read_bytes() == before
    wrong = copy.deepcopy(record)
    wrong["ready"] = True
    wrong["selection"]["selection_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="report/input binding"): replay(f, wrong)


def test_mocked_train_pipeline_assembly_keeps_canonical_freeze_v1(tmp_path, monkeypatch):
    f = fixture(tmp_path / "source")
    frozen_old = tmp_path / "existing-freeze.json"
    frozen_old.write_text('{"owned":"immutable-old-fixture"}\n')
    before = sha256_file(frozen_old)
    calls = []
    def synthetic_train(paths, vocab_size, out_path):
        calls.append((paths, vocab_size))
        assert vocab_size == 65536
        tokenizer_fixture(Path(out_path).parent)  # explicit mock; no tokenizer training claimed
    monkeypatch.setattr(pipeline, "train", synthetic_train)
    out = tmp_path / "new-output"
    report = pipeline.build_pipeline(plan_path=f["root"] / "plan.json", source_manifests={"tinystories": f["manifest_path"]},
        rights_path=f["root"] / "rights.json", source_lock_path=f["root"] / "hf.json", git_source_lock_path=f["root"] / "git.json",
        first_party_attestation_path=f["root"] / "attestation.json", first_party_root=f["first_root"], out_dir=out, bytes_per_category=1)
    assert len(calls) == 1 and report["format"] == "ilarialex-production-inputs-v2"
    assert lineage.load_metadata(out / "ilarialex.freeze.json")["format"] == "ilarialex-freeze-v1"
    assert all("selection" in record for record in report["inputs"])
    assert not report.get("promotable") and not report.get("ready")
    assert sha256_file(frozen_old) == before
    for record in report["inputs"]:
        kwargs = dict(source_manifest_path=f["manifest_path"], **f["authority"]) if record["source"] == "tinystories" else {
            "attestation_path": f["root"] / "attestation.json", "source_root": f["first_root"], "materialization_limits": LIMITS}
        lineage.validate_selection(out / record["selection"]["filename"], expected_input=record, **kwargs)
