"""Sequential offline extraction of root-downloaded pinned Common Corpus shards."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time

from extract_pd_books import Budget, REVISION, extract, seed_dedup, sha256_file, write_new_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("expansion_root", type=Path)
    parser.add_argument("--seed-manifest", type=Path, required=True)
    parser.add_argument("--source-card", type=Path, required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--forge-root", type=Path, required=True)
    args = parser.parse_args()
    budget = Budget()
    sys.path.insert(0, str(args.forge_root.resolve() / "ilaria" / "forge"))
    from data_audit import document_sha256
    receipt_path = args.expansion_root / "download-receipt.json"
    receipt_hash = sha256_file(receipt_path)
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if receipt["revision"] != REVISION or len(receipt["shards"]) != 3:
        raise ValueError("unexpected source receipt")
    frozen_paths = [receipt_path, args.seed_manifest,
                    args.seed_manifest.parent / json.loads(args.seed_manifest.read_text(encoding="utf-8"))["output_file"],
                    args.source_card, args.tokenizer]
    for shard in receipt["shards"]:
        path = args.expansion_root / shard["filename"]
        if (Path(shard["filename"]).name != shard["filename"]
                or path.stat().st_size != shard["bytes"]
                or sha256_file(path) != shard["sha256"]
                or shard["sha256"] != shard["expected_lfs_sha256"]):
            raise ValueError("download receipt bytes/hash mismatch")
        frozen_paths.append(path)
    frozen_hashes = {str(p): sha256_file(p) for p in frozen_paths}
    seen: set[str] = set()
    seed = seed_dedup(args.seed_manifest, document_sha256, seen)
    bindings = [seed]
    reports = []
    candidates = args.expansion_root / "candidates"
    candidates.mkdir(exist_ok=False)
    for shard in receipt["shards"]:
        directory = candidates / Path(shard["filename"]).stem
        report = extract(args.expansion_root / shard["filename"], args.tokenizer, directory,
                         forge_root=args.forge_root, expected_sha256=shard["expected_lfs_sha256"],
                         source_path=shard["path"], source_card=args.source_card,
                         seen=seen, budget=budget, seed_bindings=list(bindings))
        manifest_path = directory / "candidate-manifest.json"
        bindings.append({"manifest_sha256": sha256_file(manifest_path),
                         "candidate_sha256": report["output_sha256"],
                         "documents": report["candidate_documents_after_cleaning_and_exact_dedup"]})
        reports.append({"directory": directory.relative_to(args.expansion_root).as_posix(),
                        "manifest_sha256": sha256_file(manifest_path),
                        "source_path": shard["path"], "source_parquet_sha256": shard["sha256"],
                        "candidate_sha256": report["output_sha256"], "candidate_bytes": report["output_bytes"],
                        "documents": report["candidate_documents_after_cleaning_and_exact_dedup"],
                        "tokens_diagnostic": report["candidate_token_count_ilarialex_diagnostic_only"],
                        "duplicate_segments_removed": report["duplicates_removed_against_prior_and_current_candidates"],
                        "selected_source_rows": report["selected_source_rows"],
                        "rows_by_collection": report["selected_rows_by_collection"],
                        "rows_by_language": report["selected_rows_by_language"],
                        "romanian_selected_rows": report["romanian_selected_rows"]})
    if any(sha256_file(Path(path)) != h for path, h in frozen_hashes.items()):
        raise ValueError("frozen input drift")
    summary = {"format": "ilaria-common-corpus-expansion-v1", "source_revision": REVISION,
               "status": "QUARANTINE_NOT_PRODUCTION_RIGHTS_APPROVED", "production_approved": False,
               "training_performed": False, "download_receipt_sha256": receipt_hash,
               "seed": seed, "candidate_shards": reports, "frozen_input_sha256": frozen_hashes,
               "acquisition_driver_sha256": sha256_file(Path(__file__)),
               "extractor_sha256": sha256_file(Path(__file__).with_name("extract_pd_books.py")),
               "new_documents": sum(r["documents"] for r in reports),
               "new_tokens_diagnostic": sum(r["tokens_diagnostic"] for r in reports),
               "normalized_unique_documents_including_frozen_seed": len(seen),
               "romanian_selected_rows": sum(r["romanian_selected_rows"] for r in reports),
               "output_bytes_before_summary": budget.bytes,
               "output_cap_bytes": budget.max_bytes, "wall_cap_seconds": budget.max_seconds,
               "elapsed_seconds": round(time.monotonic() - budget.started, 2)}
    write_new_json(args.expansion_root / "expansion-manifest.json", summary, budget)
    print(json.dumps({"new_documents": summary["new_documents"], "new_tokens_diagnostic": summary["new_tokens_diagnostic"],
                      "normalized_unique_including_seed": len(seen), "output_bytes": budget.bytes,
                      "elapsed_seconds": summary["elapsed_seconds"],
                      "manifest_sha256": sha256_file(args.expansion_root / "expansion-manifest.json")}, sort_keys=True))


if __name__ == "__main__":
    main()
