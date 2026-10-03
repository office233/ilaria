import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from curate_corpus import curate, validation_side  # noqa: E402
from data_contract import (  # noqa: E402
    CORPUS_MANIFEST_SCHEMA,
    RIGHTS_APPROVED,
    atomic_write_json,
    canonical_json_sha256,
    sha256_file,
)
from first_party_attestation import (  # noqa: E402
    attestation_scope_sha256,
    build_attestation_template,
)


def source_fixture(tmp_path, name, texts):
    shard = tmp_path / f"{name}-00000.jsonl"
    shard.write_text(
        "".join(
            json.dumps({"text": text}, ensure_ascii=False) + "\n"
            for text in texts
        ),
        encoding="utf-8",
    )
    manifest = tmp_path / f"{name}.manifest.json"
    atomic_write_json(
        manifest,
        {
            "schema_version": CORPUS_MANIFEST_SCHEMA,
            "source": {
                "name": name,
                "provider": f"fixture/{name}",
                "revision": "v1",
                "language": "en",
            },
            "pipeline": {"name": "fixture"},
            "docs": len(texts),
            "shards": 1,
            "complete": [0],
            "raw_rows": len(texts),
            "shard_records": [
                {
                    "index": 0,
                    "filename": shard.name,
                    "sha256": sha256_file(shard),
                    "bytes": shard.stat().st_size,
                    "documents": len(texts),
                }
            ],
        },
    )
    return manifest


def rights_fixture(tmp_path, names, approved=True):
    path = tmp_path / "rights.json"
    atomic_write_json(
        path,
        {
            "schema_version": 1,
            "policy": "fixture",
            "sources": {
                name: {
                    "status": RIGHTS_APPROVED
                    if approved
                    else "REVIEW_REQUIRED",
                    "commercial_use_approved": approved,
                    "review_ref": "review-fixture" if approved else "",
                }
                for name in names
            },
        },
    )
    return path


def first_party_fixture(tmp_path, manifest, *, approved):
    owned = tmp_path / "owned-generator.py"
    owned.write_text("# first-party generator fixture\n", encoding="utf-8")
    attestation = build_attestation_template(tmp_path, paths=[owned.name])
    if approved:
        attestation.update(
            {
                "ownership_attested": True,
                "attested_by": "fixture-owner",
                "review_ref": "fixture-review-1",
            }
        )
        payload = dict(attestation)
        payload.pop("attestation_sha256", None)
        attestation["attestation_sha256"] = canonical_json_sha256(payload)
    attestation_path = tmp_path / "first-party.attestation.json"
    atomic_write_json(attestation_path, attestation)

    source = json.loads(manifest.read_text(encoding="utf-8"))
    source["pipeline"] = {
        "name": "fixture-first-party",
        "rights_basis": "first_party_attestation",
        "attestation_scope_sha256": attestation_scope_sha256(attestation),
        "attestation_required_files": list(attestation["files"]),
    }
    atomic_write_json(manifest, source)
    return attestation_path


def test_split_is_content_deterministic():
    digest = "0123456789abcdef" * 4
    assert validation_side(digest, 0.2) == validation_side(digest, 0.2)


def test_curate_removes_duplicates_and_benchmark_leakage(tmp_path):
    common = "same normalized duplicate document with enough words"
    leak = "alpha beta gamma delta epsilon zeta eta theta leakage"
    a = source_fixture(
        tmp_path,
        "a",
        [
            common,
            "unique source a document with enough words",
            leak,
        ],
    )
    b = source_fixture(
        tmp_path,
        "b",
        [
            common.upper(),
            "unique source b document with enough words",
        ],
    )
    rights = rights_fixture(tmp_path, ["a", "b"])
    benchmark = tmp_path / "bench.txt"
    benchmark.write_text(
        "alpha beta gamma delta epsilon zeta eta theta\n",
        encoding="utf-8",
    )

    out = tmp_path / "curated"
    report = curate(
        [str(b), str(a)],
        rights_registry_path=str(rights),
        benchmark_paths=[str(benchmark)],
        out_dir=str(out),
        validation_fraction=0.25,
        shingle_width=6,
        shard_docs=2,
    )

    assert report["totals"]["input_documents"] == 5
    assert report["totals"]["duplicates_removed"] == 1
    assert report["totals"]["contamination_removed"] == 1
    assert report["totals"]["kept_documents"] == 3
    assert (
        report["totals"]["train_documents"]
        + report["totals"]["validation_documents"]
        == 3
    )

    rows = []
    for split in ("train", "validation"):
        for record in report["splits"][split]:
            shard = out / record["filename"]
            assert sha256_file(shard) == record["sha256"]
            rows.extend(
                json.loads(line)
                for line in shard.read_text(encoding="utf-8").splitlines()
                if line.strip()
            )
    assert len(rows) == 3
    assert len({row["document_sha256"] for row in rows}) == 3
    assert all("alpha beta gamma" not in row["text"] for row in rows)


def test_curate_is_deterministic_across_input_order(tmp_path):
    a = source_fixture(
        tmp_path,
        "a",
        ["alpha clean document one", "alpha clean document two"],
    )
    b = source_fixture(
        tmp_path,
        "b",
        ["beta clean document one", "beta clean document two"],
    )
    rights = rights_fixture(tmp_path, ["a", "b"])
    out1, out2 = tmp_path / "out1", tmp_path / "out2"

    one = curate(
        [str(a), str(b)],
        rights_registry_path=str(rights),
        benchmark_paths=[],
        out_dir=str(out1),
        validation_fraction=0.25,
        shingle_width=4,
        shard_docs=2,
    )
    two = curate(
        [str(b), str(a)],
        rights_registry_path=str(rights),
        benchmark_paths=[],
        out_dir=str(out2),
        validation_fraction=0.25,
        shingle_width=4,
        shard_docs=2,
    )

    assert one["curated_manifest_sha256"] == two["curated_manifest_sha256"]
    for split in ("train", "validation"):
        assert [x["sha256"] for x in one["splits"][split]] == [
            x["sha256"] for x in two["splits"][split]
        ]


def test_curate_rejects_unapproved_source(tmp_path):
    manifest = source_fixture(
        tmp_path, "a", ["clean document with enough text here"]
    )
    rights = rights_fixture(tmp_path, ["a"], approved=False)
    with pytest.raises(ValueError, match="not approved"):
        curate(
            [str(manifest)],
            rights_registry_path=str(rights),
            benchmark_paths=[],
            out_dir=str(tmp_path / "out"),
        )


def test_curate_accepts_attested_first_party_source(tmp_path):
    manifest = source_fixture(
        tmp_path,
        "first_party",
        [
            "first party verified trajectory alpha with enough text",
            "first party verified trajectory beta with enough text",
        ],
    )
    attestation = first_party_fixture(tmp_path, manifest, approved=True)
    rights = rights_fixture(tmp_path, ["unrelated_external"])
    report = curate(
        [str(manifest)],
        rights_registry_path=str(rights),
        benchmark_paths=[],
        out_dir=str(tmp_path / "first-party-out"),
        validation_fraction=0.25,
        first_party_attestations={"first_party": str(attestation)},
        first_party_root=str(tmp_path),
    )
    assert report["totals"]["kept_documents"] == 2
    record = report["rights"]["first_party_attestations"]["first_party"]
    assert record["status"] == "ATTESTED_FIRST_PARTY"
    assert record["production_eligible"] is True


def test_curate_rejects_unsigned_first_party_source(tmp_path):
    manifest = source_fixture(
        tmp_path,
        "first_party",
        ["first party unsigned trajectory with enough text"],
    )
    attestation = first_party_fixture(tmp_path, manifest, approved=False)
    rights = rights_fixture(tmp_path, ["unrelated_external"])
    with pytest.raises(ValueError, match="first-party source .* is not approved"):
        curate(
            [str(manifest)],
            rights_registry_path=str(rights),
            benchmark_paths=[],
            out_dir=str(tmp_path / "unsigned-out"),
            first_party_attestations={"first_party": str(attestation)},
            first_party_root=str(tmp_path),
        )


def provenance_fixture(tmp_path, name="a", rows=None, source_changes=None):
    rows = rows or [{"text": "synthetic body never copied into provenance",
                     "license": "CC-BY-4.0", "identifier": "record-1",
                     "language": "ro"}]
    manifest_path = source_fixture(tmp_path, name, [row["text"] for row in rows])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["source"].update(source_changes or {})
    shard = tmp_path / manifest["shard_records"][0]["filename"]
    shard.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n"
                             for row in rows), encoding="utf-8")
    manifest["shard_records"][0].update(
        sha256=sha256_file(shard), bytes=shard.stat().st_size,
    )
    atomic_write_json(manifest_path, manifest)
    return manifest_path


def read_provenance(out, report):
    records = []
    for shard in report["provenance"]["shards"]:
        path = out / shard["filename"]
        assert path.name == f"provenance-{sha256_file(path)}.jsonl"
        assert shard["sha256"] == sha256_file(path)
        records.extend(json.loads(line) for line in path.read_text(
            encoding="utf-8").splitlines())
    return records


def test_provenance_preserves_input_metadata_and_binds_all_hashes(tmp_path):
    body = "synthetic body never copied into provenance"
    manifest = provenance_fixture(tmp_path, rows=[{
        "text": body, "license_expression": "CC0-1.0", "record_id": "ro-1",
        "source_url": "https://example.org/doc/1", "language": "ro",
        "date": "1901-01-01", "creator": "Synthetic Author",
        "prompt": body, "solution": body, "expected_answer": body,
        "reasoning": body, "metadata": {"text": body},
    }], source_changes={"config": "default", "revision": "a" * 40})
    rights = rights_fixture(tmp_path, ["a"])
    registry = json.loads(rights.read_text(encoding="utf-8"))
    registry["sources"]["a"]["declared_license"] = "SOURCE-LEVEL-ONLY"
    registry["evidence"] = {"filename": "evidence.json", "sha256": "b" * 64,
                            "source_lock_sha256": "c" * 64}
    atomic_write_json(rights, registry)
    out = tmp_path / "out"
    report = curate([str(manifest)], rights_registry_path=str(rights),
                    benchmark_paths=[], out_dir=str(out),
                    provenance_policy={"a": ["license", "identifier", "language"]},
                    provenance_item_fields={"a": ["license_expression", "record_id",
                                                  "source_url", "language", "date"]})
    record, = read_provenance(out, report)
    assert record["format"] == "ilaria-document-provenance-v1"
    assert record["schema_version"] == 1
    assert record["item_metadata"] == {
        "license_expression": "CC0-1.0", "record_id": "ro-1",
        "source_url": "https://example.org/doc/1", "language": "ro",
        "date": "1901-01-01",
    }
    assert record["identifier_field"] == "record_id"
    assert body not in json.dumps(record)
    assert not any(field["verified"] for field in record["item_fields"].values())
    source = record["source_provenance"]
    assert source["fields"]["revision"]["value"] == "a" * 40
    assert source["fields"]["config"]["value"] == "default"
    assert source["manifest_sha256"] == sha256_file(manifest)
    assert source["rights_refs"]["registry_sha256"] == sha256_file(rights)
    assert source["rights_refs"]["declared_license"]["value"] == "SOURCE-LEVEL-ONLY"
    assert source["rights_refs"]["evidence"]["source_lock_sha256"]["value"] == "c" * 64
    raw_manifest = json.loads(manifest.read_text(encoding="utf-8"))
    assert record["input"] == {
        "line": 1, "shard_sha256": raw_manifest["shard_records"][0]["sha256"],
    }
    rows = [json.loads(line) for split in report["splits"].values()
            for shard in split for line in (out / shard["filename"]).read_text(
                encoding="utf-8").splitlines()]
    assert rows[0]["text"] == body
    assert rows[0]["document_sha256"] == record["document_sha256"]
    assert rows[0]["provenance_sha256"] == canonical_json_sha256(record)
    saved = json.loads((out / "curated.manifest.json").read_text(encoding="utf-8"))
    identity = saved.pop("curated_manifest_sha256")
    assert canonical_json_sha256(saved) == identity


def test_provenance_is_opt_in_and_missing_item_fields_are_not_clearance(tmp_path):
    manifest = source_fixture(tmp_path, "a", ["synthetic legacy document"])
    rights = rights_fixture(tmp_path, ["a"])
    legacy = curate([str(manifest)], rights_registry_path=str(rights),
                    benchmark_paths=[], out_dir=str(tmp_path / "legacy"))
    assert "provenance" not in legacy
    assert "lines" not in legacy["input_shards"][0]
    assert "documents" not in legacy["input_shards"][0]
    assert not list((tmp_path / "legacy").glob("provenance-*"))
    out = tmp_path / "out"
    report = curate([str(manifest)], rights_registry_path=str(rights),
                    benchmark_paths=[], out_dir=str(out), preserve_provenance=True)
    record, = read_provenance(out, report)
    assert record["item_metadata"] == {}
    for field in record["item_fields"].values():
        assert field == {"status": "unavailable", "verified": False}
    assert record["source_provenance"]["fields"]["language"]["value"] == "en"
    assert record["source_provenance"]["fields"]["config"]["status"] == "unavailable"
    assert record["identifier_field"] is None


@pytest.mark.parametrize("missing", ["license", "identifier", "language"])
def test_provenance_policy_fails_closed_on_missing_items(tmp_path, missing):
    row = {"text": "synthetic body", "license": "CC0-1.0",
           "identifier": "doc-1", "language": "ro"}
    row.pop(missing)
    manifest = provenance_fixture(tmp_path, rows=[row])
    rights = rights_fixture(tmp_path, ["a"])
    out = tmp_path / "out"
    with pytest.raises(ValueError, match="missing required item provenance: " + missing):
        curate([str(manifest)], rights_registry_path=str(rights),
               benchmark_paths=[], out_dir=str(out),
               provenance_policy={"a": [missing]},
               provenance_item_fields={"a": ["license", "identifier", "language"]})
    assert not (out / "curated.manifest.json").exists()


@pytest.mark.parametrize("field", ["revision", "provider"])
def test_provenance_requires_source_snapshot_identity(tmp_path, field):
    manifest = provenance_fixture(tmp_path, source_changes={field: None})
    rights = rights_fixture(tmp_path, ["a"])
    with pytest.raises(ValueError, match="missing provenance " + field):
        curate([str(manifest)], rights_registry_path=str(rights),
               benchmark_paths=[], out_dir=str(tmp_path / "out"),
               preserve_provenance=True)


@pytest.mark.parametrize("metadata", [
    {"license": ["CC0-1.0"]}, {"license": "x" * 257},
    {"identifier": "someone@example.org"}, {"language": "ro\nen"},
    {"url": "https://user:password@example.org/doc"},
    {"url": "https://example.org/doc?access_token=synthetic-secret"},
    {"url": "https://example.org/doc?X-Amz-Credential=synthetic-secret"},
    {"url": "https://example.org/doc?X-Goog-Signature=synthetic-secret"},
    {"url": "https://example.org/synthetic body"},
    {"url": "file:///private/doc"}, {"path": "C:\\private\\doc"},
    {"path": "../outside/doc"},
])
def test_provenance_rejects_invalid_or_sensitive_allowlisted_values(tmp_path, metadata):
    manifest = provenance_fixture(tmp_path, rows=[{"text": "synthetic body", **metadata}])
    rights = rights_fixture(tmp_path, ["a"])
    with pytest.raises(ValueError, match="provenance.*field") as error:
        curate([str(manifest)], rights_registry_path=str(rights),
               benchmark_paths=[], out_dir=str(tmp_path / "out"),
               preserve_provenance=True,
               provenance_item_fields={"a": list(metadata)})
    assert "synthetic-secret" not in str(error.value)
    assert "someone@example.org" not in str(error.value)


def test_provenance_path_identifier_uses_source_snapshot_and_creator_is_opt_in(tmp_path):
    manifest = provenance_fixture(tmp_path, rows=[{
        "text": "synthetic body", "path": "src/example.c", "creator": "Fixture Author",
    }])
    rights = rights_fixture(tmp_path, ["a"])
    out = tmp_path / "out"
    report = curate([str(manifest)], rights_registry_path=str(rights),
                    benchmark_paths=[], out_dir=str(out),
                    provenance_policy={"a": ["identifier", "revision", "creator"]},
                    provenance_item_fields={"a": ["path", "creator"]})
    record, = read_provenance(out, report)
    assert record["identifier_field"] == "path"
    assert record["item_metadata"] == {"path": "src/example.c", "creator": "Fixture Author"}
    assert record["source_provenance"]["manifest_sha256"] == sha256_file(manifest)
    assert record["source_provenance"]["fields"]["revision"]["value"] == "v1"


def test_provenance_kept_documents_only_and_deterministic_input_precedence(tmp_path):
    a = provenance_fixture(tmp_path, "a", [{
        "text": "same document duplicate", "identifier": "selected-a",
    }, {"text": "alpha beta gamma delta contaminated", "identifier": "excluded"}])
    b = provenance_fixture(tmp_path, "b", [{
        "text": "SAME DOCUMENT DUPLICATE", "identifier": "duplicate-b",
    }, {"text": "unique clean fixture body", "identifier": "selected-b"}])
    rights = rights_fixture(tmp_path, ["a", "b"])
    benchmark = tmp_path / "benchmark.txt"
    benchmark.write_text("alpha beta gamma delta", encoding="utf-8")
    reports = []
    for number, inputs in enumerate(([str(a), str(b)], [str(b), str(a)])):
        out = tmp_path / f"out{number}"
        report = curate(inputs, rights_registry_path=str(rights),
                        benchmark_paths=[str(benchmark)], out_dir=str(out),
                        shingle_width=3, shard_docs=1, preserve_provenance=True,
                        provenance_item_fields={"a": ["identifier"], "b": ["identifier"]})
        records = read_provenance(out, report)
        assert [record["item_metadata"]["identifier"] for record in records] == [
            "selected-a", "selected-b",
        ]
        assert len(records) == report["totals"]["kept_documents"] == 2
        reports.append(report)
    assert reports[0]["curated_manifest_sha256"] == reports[1]["curated_manifest_sha256"]


@pytest.mark.parametrize("policy", [{"absent": []}, {"a": "license"},
                                    {"a": ["text"]}, {"a": [1]}])
def test_provenance_rejects_unmatched_or_invalid_policy(tmp_path, policy):
    manifest = provenance_fixture(tmp_path)
    rights = rights_fixture(tmp_path, ["a"])
    with pytest.raises(ValueError, match="provenance policy"):
        curate([str(manifest)], rights_registry_path=str(rights),
               benchmark_paths=[], out_dir=str(tmp_path / "out"),
               provenance_policy=policy)


def test_provenance_refuses_existing_sidecar_output(tmp_path):
    manifest = provenance_fixture(tmp_path)
    rights = rights_fixture(tmp_path, ["a"])
    out = tmp_path / "out"
    out.mkdir()
    existing = out / ("provenance-" + "a" * 64 + ".jsonl")
    existing.write_text("synthetic sentinel", encoding="utf-8")
    with pytest.raises(ValueError, match="already contains shards"):
        curate([str(manifest)], rights_registry_path=str(rights),
               benchmark_paths=[], out_dir=str(out), preserve_provenance=True)
    assert existing.read_text(encoding="utf-8") == "synthetic sentinel"


def test_provenance_minimizes_public_metadata_unless_source_explicitly_retains_it(tmp_path):
    a = provenance_fixture(tmp_path, "a", [{
        "text": "synthetic source a body", "license": "CC0-1.0", "language": "ro",
        "identifier": "public-record-a", "url": "https://example.org/a",
        "date": 1901, "path": "src/a", "creator": "Public Author",
    }])
    b = provenance_fixture(tmp_path, "b", [{
        "text": "synthetic source b body", "identifier": "public-record-b",
        "url": "https://example.org/b", "license": "CC-BY-4.0",
    }])
    rights = rights_fixture(tmp_path, ["a", "b"])
    out = tmp_path / "out"
    report = curate([str(a), str(b)], rights_registry_path=str(rights),
                    benchmark_paths=[], out_dir=str(out), preserve_provenance=True,
                    provenance_item_fields={"b": ["identifier"]})
    records = read_provenance(out, report)
    assert records[0]["item_metadata"] == {"license": "CC0-1.0", "language": "ro"}
    assert records[0]["identifier_field"] is None
    assert records[1]["item_metadata"] == {"identifier": "public-record-b"}
    assert report["provenance"]["retained_item_fields"] == {
        "a": ["language", "license", "license_expression"], "b": ["identifier"],
    }


def test_provenance_required_identifier_does_not_grant_implicit_retention(tmp_path):
    manifest = provenance_fixture(tmp_path)
    rights = rights_fixture(tmp_path, ["a"])
    out = tmp_path / "out"
    with pytest.raises(ValueError, match="policy field 'identifier' is not retained"):
        curate([str(manifest)], rights_registry_path=str(rights),
               benchmark_paths=[], out_dir=str(out),
               provenance_policy={"a": ["identifier"]})
    assert not out.exists()


def test_provenance_integer_date_requires_explicit_acquisition_normalization(tmp_path):
    manifest = provenance_fixture(tmp_path, rows=[{
        "text": "synthetic public document", "date": 1901,
    }])
    rights = rights_fixture(tmp_path, ["a"])
    out = tmp_path / "out"
    with pytest.raises(ValueError, match="invalid provenance metadata field 'date'"):
        curate([str(manifest)], rights_registry_path=str(rights),
               benchmark_paths=[], out_dir=str(out),
               provenance_item_fields={"a": ["date"]},
               provenance_policy={"a": ["date"]})
    assert not (out / "curated.manifest.json").exists()
    # An explicitly normalized acquisition row remains exactly that input value.
    manifest = provenance_fixture(tmp_path, rows=[{
        "text": "synthetic public document", "date": "1901",
    }])
    normalized = tmp_path / "normalized"
    report = curate([str(manifest)], rights_registry_path=str(rights),
                    benchmark_paths=[], out_dir=str(normalized),
                    provenance_item_fields={"a": ["date"]},
                    provenance_policy={"a": ["date"]})
    record, = read_provenance(normalized, report)
    assert record["item_metadata"] == {"date": "1901"}
    assert record["item_fields"]["date"] == {"status": "available", "verified": False}


def test_provenance_binds_exact_physical_input_line_including_blank_lines(tmp_path):
    manifest_path = provenance_fixture(tmp_path, rows=[
        {"text": "synthetic first document", "record_id": "first"},
        {"text": "synthetic second document", "record_id": "second"},
    ])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    shard = tmp_path / manifest["shard_records"][0]["filename"]
    lines = shard.read_text(encoding="utf-8").splitlines()
    shard.write_text("\n" + lines[0] + "\n\n\n" + lines[1] + "\n", encoding="utf-8")
    manifest["shard_records"][0].update(sha256=sha256_file(shard), bytes=shard.stat().st_size)
    atomic_write_json(manifest_path, manifest)
    rights = rights_fixture(tmp_path, ["a"])
    out = tmp_path / "out"
    report = curate([str(manifest_path)], rights_registry_path=str(rights),
                    benchmark_paths=[], out_dir=str(out),
                    provenance_item_fields={"a": ["record_id"]})
    records = read_provenance(out, report)
    assert [record["input"]["line"] for record in records] == [2, 5]
    assert report["input_shards"][0]["lines"] == 5
    assert report["input_shards"][0]["documents"] == 2
    raw_lines = shard.read_text(encoding="utf-8").splitlines()
    for record in records:
        assert record["input"]["shard_sha256"] == sha256_file(shard)
        raw = json.loads(raw_lines[record["input"]["line"] - 1])
        assert record["item_metadata"]["record_id"] == raw["record_id"]


@pytest.mark.parametrize("fields", [{"absent": []}, {"a": ["text"]},
                                    {"a": "identifier"}, {"a": [1]}])
def test_provenance_rejects_invalid_source_specific_retention(tmp_path, fields):
    manifest = provenance_fixture(tmp_path)
    rights = rights_fixture(tmp_path, ["a"])
    with pytest.raises(ValueError, match="provenance item fields"):
        curate([str(manifest)], rights_registry_path=str(rights),
               benchmark_paths=[], out_dir=str(tmp_path / "out"),
               provenance_item_fields=fields)
