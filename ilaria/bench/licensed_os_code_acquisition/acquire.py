"""Acquire locked public OS snapshots; emit source-qualified canonical candidates.

No repository code is executed. Archives are streamed, only bounded UTF-8 code
files are extracted, then canonical SPDX/secret/agent gates decide eligibility.
The new package is not a production mixture or a promoted training dataset.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile
import time
import urllib.request

NETWORK_CAP = 500 * 1024**2
DISK_CAP = 1024**3
WALL_CAP_SECONDS = 25 * 60
FILE_CAP = 512 * 1024  # canonical secret-marker inspection covers every byte
CODE_EXTENSIONS = frozenset({
    ".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".s",
    ".rs", ".py", ".sh", ".js", ".ts", ".java", ".swift", ".kt",
})


def file_sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for data in iter(lambda: f.read(1024 * 1024), b""):
            h.update(data)
    return h.hexdigest()


def write_json_new(path: Path, value: dict) -> None:
    payload = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)
               + "\n").encode("utf-8")
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("xb") as f:
        f.write(payload)
        f.flush()
        os.fsync(f.fileno())
    os.link(temporary, path)  # atomic no-clobber publication
    temporary.unlink()


def safe_member_path(name: str, prefix: str) -> PurePosixPath | None:
    if name.startswith("/") or "\\" in name or ":" in name:
        return None
    parts = name.rstrip("/").split("/")
    if not parts or parts[0] != prefix or any(p in {"", ".", ".."} for p in parts):
        return None
    if len(parts) < 2:
        return None
    relative = PurePosixPath(*parts[1:])
    return relative if len(str(relative)) <= 160 else None


class Budget:
    def __init__(self):
        self.started = time.monotonic()
        self.network = 0
        self.disk = 0

    def check(self, *, network=0, disk=0):
        if time.monotonic() - self.started > WALL_CAP_SECONDS:
            raise ValueError("wall budget exceeded")
        if self.network + network > NETWORK_CAP or self.disk + disk > DISK_CAP:
            raise ValueError("network or disk budget exceeded")
        self.network += network
        self.disk += disk


def download(url: str, target: Path, budget: Budget) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "Ilaria-public-source-audit/1"})
    with urllib.request.urlopen(req, timeout=60) as response, target.open("xb") as f:
        if response.status != 200 or not response.geturl().startswith("https://codeload.github.com/"):
            raise ValueError("unexpected archive response")
        length = response.headers.get("Content-Length")
        if length and int(length) > NETWORK_CAP - budget.network:
            raise ValueError("archive exceeds remaining network cap")
        h = hashlib.sha256()
        for block in iter(lambda: response.read(1024 * 1024), b""):
            budget.check(network=len(block), disk=len(block))
            f.write(block)
            h.update(block)
        f.flush()
        os.fsync(f.fileno())
        return {"url": url, "sha256": h.hexdigest(), "bytes": target.stat().st_size,
                "http_status": response.status, "etag": response.headers.get("ETag"),
                "upstream_checksum_published": False}


def extract_code(archive: Path, tree: Path, prefix: str, budget: Budget,
                 denied: frozenset[str], skipped: frozenset[str]) -> dict:
    counts = Counter()
    tree.mkdir()
    with tarfile.open(archive, "r|gz") as tar:
        for member in tar:
            budget.check()
            counts["archive_members"] += 1
            if member.isdir():
                continue
            relative = safe_member_path(member.name, prefix)
            if relative is None:
                counts["unsafe_or_long_path"] += 1
                continue
            if not member.isfile():
                counts["non_regular_link_or_special"] += 1
                continue
            if relative.name in denied:
                counts["agent_instruction_file"] += 1
                continue
            if any(part in skipped for part in relative.parts):
                counts["skipped_directory"] += 1
                continue
            if relative.suffix.lower() not in CODE_EXTENSIONS:
                counts["not_code_extension"] += 1
                continue
            if not 0 < member.size <= FILE_CAP:
                counts["empty_or_oversize_no_truncation"] += 1
                continue
            source = tar.extractfile(member)
            if source is None:
                raise ValueError("missing regular tar payload")
            content = source.read(FILE_CAP + 1)
            if len(content) != member.size or len(content) > FILE_CAP:
                raise ValueError("tar payload size mismatch")
            try:
                content.decode("utf-8")
            except UnicodeDecodeError:
                counts["non_utf8"] += 1
                continue
            if b"\0" in content:
                counts["binary_nul"] += 1
                continue
            destination = tree.joinpath(*relative.parts)
            if tree.resolve() not in destination.resolve().parents:
                raise ValueError("path escape")
            destination.parent.mkdir(parents=True, exist_ok=True)
            budget.check(disk=len(content))
            with destination.open("xb") as f:
                f.write(content)
            counts["extracted_utf8_code_files"] += 1
            counts["extracted_bytes"] += len(content)
    return dict(sorted(counts.items()))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("output_root", type=Path)
    parser.add_argument("--forge-root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--tokenizer", type=Path, required=True)
    args = parser.parse_args()
    budget = Budget()
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["RAYON_NUM_THREADS"] = "2"
    os.environ["OMP_NUM_THREADS"] = "2"
    forge = args.forge_root.resolve() / "ilaria" / "forge"
    sys.path.insert(0, str(forge))
    from data_contract import load_rights_registry, require_approved_rights
    from rights_evidence import load_and_validate_evidence, require_approved_evidence
    from licensed_tree_source import build_manifest, validate_manifest, DEFAULT_ALLOWED_SPDX, DENY_FILENAMES, SKIP_PARTS
    from licensed_tree_corpus import build_raw_corpus
    from data_audit import document_sha256
    from hf_tokenizer import load, EOS

    cfg = forge / "config"
    registry = load_rights_registry(cfg / "data_rights.json")
    evidence = load_and_validate_evidence(
        cfg / "data_rights_evidence.json", source_lock_path=cfg / "corpus_sources.lock.json",
        rights_registry_path=cfg / "data_rights.json", git_source_lock_path=cfg / "git_sources.lock.json",
    )
    names = ["freertos_kernel", "zephyr"]
    require_approved_rights(registry, names)
    require_approved_evidence(registry, evidence, names)
    lock = json.loads((cfg / "git_sources.lock.json").read_text(encoding="utf-8"))
    inputs = [cfg / name for name in ("git_sources.lock.json", "data_rights.json",
                                    "data_rights_evidence.json", "corpus_sources.lock.json")]
    inputs += [forge / name for name in ("licensed_tree_source.py", "licensed_tree_corpus.py",
                                        "data_contract.py", "data_audit.py", "hf_tokenizer.py",
                                        "rights_evidence.py", "corpus_source_lock.py", "git_source_lock.py")]
    hashes = {str(p): file_sha(p) for p in inputs}
    recipe_hash = file_sha(Path(__file__))
    tokenizer_hash = file_sha(args.tokenizer)
    tokenizer = load(str(args.tokenizer))
    if tokenizer.token_to_id(EOS) is None:
        raise ValueError("missing canonical EOS")
    # Refuse all reuse/overwrite, including partial previous acquisitions.
    args.output_root.mkdir(parents=True, exist_ok=False)
    global_seen = set()
    source_reports = []
    for name in names:
        entry = lock["sources"][name]
        repo = entry["url"].removeprefix("https://github.com/").removesuffix(".git")
        commit = entry["commit"]
        if not entry["url"].startswith("https://github.com/") or len(commit) != 40:
            raise ValueError("invalid locked source identity")
        folder = args.output_root / name
        folder.mkdir()
        archive = folder / "source.tar.gz"
        url = f"https://codeload.github.com/{repo}/tar.gz/{commit}"
        observation = download(url, archive, budget)
        write_json_new(folder / "download-observation.json", observation)
        selection = extract_code(archive, folder / "tree", repo.split("/")[-1] + "-" + commit,
                                 budget, DENY_FILENAMES, SKIP_PARTS)
        manifest = build_manifest(folder / "tree", source_name=name, source_revision=commit,
                                  allowed_spdx=DEFAULT_ALLOWED_SPDX, extensions=CODE_EXTENSIONS)
        licensed_path = folder / "licensed-tree.manifest.json"
        write_json_new(licensed_path, manifest)
        validate_manifest(licensed_path, root=folder / "tree")
        # Conservative bound includes JSON escaping and all record headers.
        projected_raw = manifest["totals"]["bytes"] * 2 + manifest["totals"]["files"] * 2048
        budget.check()
        if budget.disk + projected_raw > DISK_CAP:
            raise ValueError("canonical raw corpus would exceed disk cap")
        raw = build_raw_corpus(licensed_path, root=folder / "tree", out_dir=folder / "raw",
                               source_name=name, provider=entry["url"], language="code", shard_docs=1000)
        source_seen = set()
        exact_file_seen = set()
        tokens = documents = duplicate_file_bytes = duplicate_normalized_body = duplicate_global_body = 0
        index = folder / "document-index.jsonl"
        with index.open("xb") as out:
            records = {r["path"]: r for r in manifest["files"]}
            for shard in raw["shard_records"]:
                path = folder / "raw" / shard["filename"]
                if file_sha(path) != shard["sha256"]:
                    raise ValueError("raw shard hash mismatch")
                for line_no, line in enumerate(path.open(encoding="utf-8"), 1):
                    budget.check()
                    row = json.loads(line)
                    record = records[row["path"]]
                    file = folder / "tree" / row["path"]
                    body = file.read_text(encoding="utf-8").strip()
                    expected = f"[FILE {row['path']} SPDX={record['spdx']}]\n{body}"
                    if row["text"] != expected or file_sha(file) != row["file_sha256"]:
                        raise ValueError("canonical file binding or full-text equality failed")
                    body_hash = document_sha256(body)
                    duplicate_file_bytes += row["file_sha256"] in exact_file_seen
                    duplicate_normalized_body += body_hash in source_seen
                    duplicate_global_body += body_hash in global_seen
                    exact_file_seen.add(row["file_sha256"])
                    source_seen.add(body_hash)
                    global_seen.add(body_hash)
                    count = len(tokenizer.encode(row["text"], add_special_tokens=False).ids) + 1
                    tokens += count
                    documents += 1
                    out.write((json.dumps({"source": name, "revision": commit, "path": row["path"],
                        "spdx": row["spdx"], "file_sha256": row["file_sha256"],
                        "document_sha256": document_sha256(row["text"]),
                        "normalized_body_sha256": body_hash, "raw_shard_sha256": shard["sha256"],
                        "raw_line": line_no, "tokens_including_eos": count}, sort_keys=True) + "\n").encode())
        report = {"source": name, "provider": entry["url"], "revision": commit,
                  "archive": observation, "archive_selection": selection,
                  "license_totals": manifest["totals"], "licensed_manifest_sha256": file_sha(licensed_path),
                  "raw_manifest_sha256": file_sha(folder / "raw" / f"{name}.manifest.json"),
                  "raw_shards": raw["shard_records"], "document_index_sha256": file_sha(index),
                  "documents": documents, "tokens_including_eos_diagnostic": tokens,
                  "byte_duplicate_files": duplicate_file_bytes,
                  "normalized_duplicate_bodies": duplicate_normalized_body,
                  "cross_source_or_within_duplicate_bodies": duplicate_global_body,
                  "dedup_policy": "retained file lineage; duplicates measured, not silently removed",
                  "rights_review_ref": registry["sources"][name]["review_ref"],
                  "rights_evidence_ref": registry["sources"][name]["evidence_ref"]}
        write_json_new(folder / "source-candidate.json", report)
        source_reports.append(report)
        actual_disk = sum(p.stat().st_size for p in args.output_root.rglob("*") if p.is_file())
        if actual_disk > DISK_CAP:
            raise ValueError("disk cap exceeded")
        budget.disk = actual_disk
        print(json.dumps({"source": name, "documents": documents, "tokens_diagnostic": tokens,
                          "network_bytes": budget.network, "disk_bytes": actual_disk}), flush=True)
    if any(file_sha(Path(p)) != h for p, h in hashes.items()) or file_sha(args.tokenizer) != tokenizer_hash:
        raise ValueError("canonical input drift")
    package = {"format": "ilaria-licensed-os-code-candidate-v1",
               "status": "SOURCE_QUALIFIED_CANDIDATE_NOT_PRODUCTION_MIXTURE_APPROVED",
               "production_dataset_approved": False, "training_performed": False,
               "source_reports": source_reports, "input_file_sha256": hashes,
               "acquisition_recipe_sha256": recipe_hash, "tokenizer_sha256": tokenizer_hash,
               "tokenizer_path": str(args.tokenizer), "eos_id": tokenizer.token_to_id(EOS),
               "code_extensions": sorted(CODE_EXTENSIONS), "max_file_bytes_no_truncation": FILE_CAP,
               "caps": {"network_bytes": NETWORK_CAP, "disk_bytes": DISK_CAP, "wall_seconds": WALL_CAP_SECONDS},
               "network_bytes": budget.network, "elapsed_seconds": round(time.monotonic() - budget.started, 2),
               "documents": sum(r["documents"] for r in source_reports),
               "tokens_including_eos_diagnostic": sum(r["tokens_including_eos_diagnostic"] for r in source_reports),
               "unique_normalized_file_bodies": len(global_seen)}
    write_json_new(args.output_root / "package-manifest.json", package)
    print(json.dumps({"package_sha256": file_sha(args.output_root / "package-manifest.json"),
                      "documents": package["documents"], "tokens_diagnostic": package["tokens_including_eos_diagnostic"],
                      "network_bytes": budget.network, "elapsed_seconds": package["elapsed_seconds"]}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
