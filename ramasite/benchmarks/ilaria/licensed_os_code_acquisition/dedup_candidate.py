"""Build a new exact-body deduplicated view, preserving every file alias.

Code case/indentation/Unicode are not normalized for pruning. Canonical raw
shards remain intact. No repository code or training is executed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys as _nexus_sys
_nexus_sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nexus_ilaria_benchmark_paths import workspace_root
import sys
import time

from acquire import DISK_CAP, WALL_CAP_SECONDS, file_sha, write_json_new


def body_bytes(row: dict) -> bytes:
    prefix = f"[FILE {row['path']} SPDX={row['spdx']}]\n"
    if not row["text"].startswith(prefix):
        raise ValueError("canonical raw file prefix mismatch")
    return row["text"][len(prefix):].encode("utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("package_root", type=Path)
    parser.add_argument("--forge-root", type=Path, default=workspace_root(__file__))
    args = parser.parse_args()
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["RAYON_NUM_THREADS"] = "2"
    sys.path.insert(0, str(args.forge_root.resolve() / "ilaria" / "forge"))
    from hf_tokenizer import load
    from data_audit import document_sha256
    source_manifest = args.package_root / "package-manifest.json"
    package_hash = file_sha(source_manifest)
    package = json.loads(source_manifest.read_text(encoding="utf-8"))
    tokenizer_path = Path(package["tokenizer_path"])
    if file_sha(tokenizer_path) != package["tokenizer_sha256"]:
        raise ValueError("tokenizer drift")
    tokenizer = load(str(tokenizer_path))
    current_disk = sum(p.stat().st_size for p in args.package_root.rglob("*") if p.is_file())
    started = time.monotonic()
    out_dir = args.package_root / "unique-code"
    out_dir.mkdir(exist_ok=False)
    candidate_path = out_dir / "candidate.jsonl"
    aliases_path = out_dir / "file-aliases.jsonl"
    seen = set()
    normalized_seen = set()
    source_documents = kept_documents = duplicates = tokens = 0
    with candidate_path.open("xb") as candidate, aliases_path.open("xb") as aliases:
        for source in package["source_reports"]:
            folder = args.package_root / source["source"]
            raw_manifest = folder / "raw" / f"{source['source']}.manifest.json"
            if file_sha(raw_manifest) != source["raw_manifest_sha256"]:
                raise ValueError("source manifest drift")
            for shard in source["raw_shards"]:
                path = folder / "raw" / shard["filename"]
                if file_sha(path) != shard["sha256"]:
                    raise ValueError("source shard drift")
                with path.open(encoding="utf-8") as stream:
                    for line_no, line in enumerate(stream, 1):
                        if time.monotonic() - started + package["elapsed_seconds"] > WALL_CAP_SECONDS:
                            raise ValueError("combined acquisition wall cap exceeded")
                        row = json.loads(line)
                        body = body_bytes(row)
                        digest = hashlib.sha256(body).hexdigest()
                        normalized_seen.add(document_sha256(body.decode("utf-8")))
                        source_documents += 1
                        duplicate = digest in seen
                        binding = {"body_byte_sha256": digest, "source": source["source"],
                                   "revision": source["revision"], "path": row["path"],
                                   "spdx": row["spdx"], "file_sha256": row["file_sha256"],
                                   "raw_shard_sha256": shard["sha256"], "raw_line": line_no,
                                   "duplicate_body": duplicate}
                        aliases.write((json.dumps(binding, sort_keys=True) + "\n").encode())
                        if duplicate:
                            duplicates += 1
                        else:
                            seen.add(digest)
                            kept_documents += 1
                            count = len(tokenizer.encode(row["text"], add_special_tokens=False).ids) + 1
                            tokens += count
                            candidate.write((json.dumps({"schema": "ilaria-source-qualified-code-candidate-v1",
                                                         **binding, "text": row["text"],
                                                         "tokens_including_eos": count},
                                                        ensure_ascii=False, sort_keys=True) + "\n").encode())
                        if current_disk + candidate.tell() + aliases.tell() > DISK_CAP - 1024 * 1024:
                            raise ValueError("dedup view would exceed combined disk cap")
        for stream in (candidate, aliases):
            stream.flush()
            os.fsync(stream.fileno())
    if source_documents != kept_documents + duplicates or source_documents != package["documents"]:
        raise ValueError("dedup accounting mismatch")
    manifest = {"format": "ilaria-exact-body-code-candidate-v1",
                "status": "SOURCE_QUALIFIED_CANDIDATE_NOT_PRODUCTION_MIXTURE_APPROVED",
                "production_dataset_approved": False, "training_performed": False,
                "dedup_policy": "canonical-body-utf8-bytes-sha256-v1; preserve code case and indentation",
                "source_package_sha256": package_hash,
                "acquisition_recipe_sha256": package["acquisition_recipe_sha256"],
                "dedup_recipe_sha256": file_sha(Path(__file__)),
                "tokenizer_sha256": package["tokenizer_sha256"],
                "source_documents": source_documents, "unique_body_documents": kept_documents,
                "exact_body_duplicates_removed": duplicates,
                "normalized_unique_bodies_diagnostic_only": len(normalized_seen),
                "tokens_including_eos_diagnostic": tokens,
                "candidate_sha256": file_sha(candidate_path), "candidate_bytes": candidate_path.stat().st_size,
                "aliases_sha256": file_sha(aliases_path), "aliases_bytes": aliases_path.stat().st_size,
                "combined_disk_bytes": current_disk + candidate_path.stat().st_size + aliases_path.stat().st_size,
                "stage_elapsed_seconds": round(time.monotonic() - started, 2)}
    write_json_new(out_dir / "candidate-manifest.json", manifest)
    print(json.dumps(manifest, sort_keys=True))


if __name__ == "__main__":
    main()
