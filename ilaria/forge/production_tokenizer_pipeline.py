"""Materialize and freeze the production IlariaLex tokenizer sample."""
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path

from data_contract import atomic_write_json, canonical_json_sha256
from hf_tokenizer import ILARIALEX_VOCAB_SIZE, train
from tokenizer_coverage import REQUIRED_COVERAGE, build_coverage_manifest
from tokenizer_freeze import build_freeze_manifest, build_sample_manifest

from production_tokenizer_lineage import (
    generator_identity, prepare_external_sources, prepare_first_party,
    validate_limits, write_external_sample, write_first_party_sample,
)

FORMAT = "ilarialex-production-inputs-v2"
_SAFE = re.compile(r"[^A-Za-z0-9_.-]+")

def _load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value

def _safe(value: str) -> str:
    return _SAFE.sub("_", value).strip("._") or "source"

def build_pipeline(
    *,
    plan_path: str | Path,
    source_manifests: dict[str, str | Path],
    rights_path: str | Path,
    source_lock_path: str | Path,
    git_source_lock_path: str | Path,
    first_party_attestation_path: str | Path,
    first_party_root: str | Path,
    out_dir: str | Path,
    bytes_per_category: int = 40_000_000,
    materialization_limits: dict | None = None,
) -> dict:
    if type(bytes_per_category) is not int or bytes_per_category < 1:
        raise ValueError("bytes_per_category must be positive")
    plan = _load_json(Path(plan_path))
    coverage_plan = plan.get("tokenizer_coverage")
    if not isinstance(coverage_plan, dict) or set(coverage_plan) != REQUIRED_COVERAGE:
        raise ValueError("production source plan tokenizer coverage set mismatch")
    first_party_sources = set(plan.get("first_party_sources", []))
    if first_party_sources != {"first_party_contracts", "first_party_trajectories"}:
        raise ValueError("unexpected production first-party source set")

    limits = validate_limits(materialization_limits if materialization_limits is not None else
                             plan.get("tokenizer_materialization_limits"))
    output = Path(out_dir)
    if output.exists() or output.is_symlink():
        raise ValueError("production tokenizer requires a new exclusive output directory")
    output = output.resolve()
    expected_sources = set()
    planned_names = set()
    for category, sources in coverage_plan.items():
        if (not isinstance(sources, list) or not sources or
                any(not isinstance(source, str) or not source for source in sources) or
                len(set(sources)) != len(sources)):
            raise ValueError("invalid production tokenizer coverage source list")
        expected_sources.update(sources)
        if "first_party_trajectories" in sources:
            raise ValueError("production tokenizer trajectory materialization is unsupported")
        for source in sources:
            if source in first_party_sources:
                continue
            filename = f"ilarialex.{_safe(category)}.{_safe(source)}.txt"
            if filename in planned_names:
                raise ValueError("production tokenizer output filename collision")
            planned_names.add(filename)
    external_sources = sorted(expected_sources - first_party_sources)
    if any(source not in source_manifests for source in external_sources):
        raise ValueError("missing production tokenizer source manifest mapping")
    authority = dict(rights_registry_path=rights_path, source_lock_path=source_lock_path,
                     git_source_lock_path=git_source_lock_path, materialization_limits=limits)
    prepare_external_sources({source: source_manifests[source] for source in external_sources}, **authority)
    first_party_packet = prepare_first_party(first_party_attestation_path, first_party_root, limits)
    output.mkdir(parents=True, exist_ok=False)  # exclusive new outputs, including every sidecar
    coverage_entries = {category: [] for category in REQUIRED_COVERAGE}
    input_records = []

    for category in sorted(REQUIRED_COVERAGE):
        sources = list(coverage_plan[category])
        if not sources:
            raise ValueError(f"tokenizer coverage category is empty: {category}")
        external = [source for source in sources if source not in first_party_sources]
        if external:
            target = math.ceil(bytes_per_category / len(external))
            for source in external:
                raw_manifest = source_manifests.get(source)
                if raw_manifest is None:
                    raise ValueError(f"missing source manifest mapping for {source}")
                manifest_path = Path(raw_manifest).resolve()
                destination = output / f"ilarialex.{_safe(category)}.{_safe(source)}.txt"
                record = write_external_sample(manifest_path, destination, target, source_name=source, **authority)
                if record["source"] != source:
                    raise ValueError(f"source manifest identity mismatch for {source}")
                record["category"] = category
                input_records.append(record)
                coverage_entries[category].append((destination, source))

        for source in sources:
            if source != "first_party_contracts":
                continue
            for index, file_record in enumerate(first_party_packet["files"]):
                relative = file_record["path"]
                source_path = Path(first_party_root).resolve() / relative
                destination = output / (
                    f"ilarialex.{_safe(category)}.{_safe(source)}.{index:02d}."
                    f"{_safe(Path(relative).name)}"
                )
                record = write_first_party_sample(destination, source_name=source,
                    attested_path=relative, attestation_path=first_party_attestation_path,
                    source_root=first_party_root, materialization_limits=limits)
                record["category"] = category
                input_records.append(record)
                coverage_entries[category].append((destination, source))

    observed_sources = {record["source"] for record in input_records}
    expected_sources = {source for sources in coverage_plan.values() for source in sources}
    if observed_sources != expected_sources:
        raise ValueError(
            f"production tokenizer source coverage mismatch: "
            f"observed={sorted(observed_sources)}, expected={sorted(expected_sources)}"
        )

    first_party = {"first_party_contracts": str(first_party_attestation_path)}
    coverage_path = output / "ilarialex.coverage.json"
    coverage = build_coverage_manifest(
        coverage_entries,
        rights_registry_path=rights_path,
        first_party_attestations=first_party,
        first_party_root=first_party_root,
    )
    atomic_write_json(coverage_path, coverage)

    sample_path = output / "ilarialex.sample.manifest.json"
    ordered = sorted(input_records, key=lambda item: (item["category"], item["source"], item["filename"]))
    input_paths = [output / item["filename"] for item in ordered]
    sample = build_sample_manifest(
        input_paths,
        source_names=sorted(observed_sources),
        coverage=sorted(REQUIRED_COVERAGE),
        rights_registry_path=rights_path,
        source_lock_path=source_lock_path,
        git_source_lock_path=git_source_lock_path,
        coverage_manifest_path=coverage_path,
        first_party_attestations=first_party,
        first_party_root=first_party_root,
        input_sources=[item["source"] for item in ordered],
    )
    atomic_write_json(sample_path, sample)

    tokenizer_path = output / "ilarialex.json"
    train([str(path) for path in input_paths], ILARIALEX_VOCAB_SIZE, str(tokenizer_path))
    freeze_path = output / "ilarialex.freeze.json"
    freeze = build_freeze_manifest(
        tokenizer_path,
        sample_manifest_path=sample_path,
        rights_registry_path=rights_path,
        first_party_attestations=first_party,
        first_party_root=first_party_root,
    )
    atomic_write_json(freeze_path, freeze)

    report = {
        "format": FORMAT,
        "bytes_per_category": bytes_per_category,
        "generator": generator_identity(),
        "materialization_limits": limits,
        "inputs": ordered,
        "coverage_sha256": coverage["coverage_sha256"],
        "sample_manifest_sha256": sample["sample_manifest_sha256"],
        "tokenizer_sha256": freeze["tokenizer"]["sha256"],
        "freeze_sha256": freeze["freeze_sha256"],
    }
    report["production_inputs_sha256"] = canonical_json_sha256(report)
    atomic_write_json(output / "ilarialex.production-inputs.json", report)
    return report

def _mapping(value: str) -> tuple[str, str]:
    source, sep, path = value.partition("=")
    if not sep or not source or not path:
        raise ValueError("source manifest mapping must be SOURCE=PATH")
    return source, path

def main() -> None:
    config = Path(__file__).resolve().parent / "config"
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", default=str(config / "imc_125m_production_sources.json"))
    parser.add_argument("--source-manifest", action="append", required=True)
    parser.add_argument("--rights", default=str(config / "data_rights.json"))
    parser.add_argument("--source-lock", default=str(config / "corpus_sources.lock.json"))
    parser.add_argument("--git-source-lock", default=str(config / "git_sources.lock.json"))
    parser.add_argument("--first-party-attestation", default=str(config / "first_party_tools_protocol.attestation.json"))
    parser.add_argument("--first-party-root", default=str(root))
    parser.add_argument("--out-dir", default=str(root / "data" / "production"))
    parser.add_argument("--bytes-per-category", type=int, default=40_000_000)
    args = parser.parse_args()
    mappings = dict(_mapping(raw) for raw in args.source_manifest)
    report = build_pipeline(
        plan_path=args.plan,
        source_manifests=mappings,
        rights_path=args.rights,
        source_lock_path=args.source_lock,
        git_source_lock_path=args.git_source_lock,
        first_party_attestation_path=args.first_party_attestation,
        first_party_root=args.first_party_root,
        out_dir=args.out_dir,
        bytes_per_category=args.bytes_per_category,
    )
    print(json.dumps(report, indent=2, sort_keys=True))

if __name__ == "__main__":
    main()
