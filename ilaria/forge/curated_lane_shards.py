"""Split a lane-annotated curated corpus into content-addressed lane shards."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

try:
    from .curate_corpus import CURATED_FORMAT, CURATED_SCHEMA_VERSION
    from .curriculum_stream import REQUIRED_LANES
    from .data_contract import atomic_write_json, canonical_json_bytes, require_lower_sha256, sha256_file
except ImportError:
    from curate_corpus import CURATED_FORMAT, CURATED_SCHEMA_VERSION
    from curriculum_stream import REQUIRED_LANES
    from data_contract import atomic_write_json, canonical_json_bytes, require_lower_sha256, sha256_file


FORMAT = "ilaria-curated-lane-shards-v1"


class _Writer:
    def __init__(self, root: Path, split: str, lane: str, shard_docs: int):
        self.root = root
        self.split = split
        self.lane = lane
        self.shard_docs = shard_docs
        self.index = 0
        self.buffer: list[dict] = []
        self.records: list[dict] = []
        self.documents = 0

    def add(self, row: dict) -> None:
        self.buffer.append(row)
        if len(self.buffer) >= self.shard_docs:
            self.flush()

    def flush(self) -> None:
        if not self.buffer:
            return
        lane_dir = self.root / self.split / self.lane
        lane_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{self.lane}-{self.index:05d}.jsonl"
        path = lane_dir / filename
        temporary = path.with_suffix(path.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            for row in self.buffer:
                stream.write(
                    json.dumps(
                        row,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                    + "\n"
                )
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        count = len(self.buffer)
        self.records.append(
            {
                "filename": str(path.relative_to(self.root)).replace("\\", "/"),
                "sha256": sha256_file(path),
                "bytes": path.stat().st_size,
                "documents": count,
            }
        )
        self.documents += count
        self.index += 1
        self.buffer.clear()

    def close(self) -> None:
        self.flush()


def _load_curated(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        manifest = json.load(stream)
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema_version") != CURATED_SCHEMA_VERSION
        or manifest.get("format") != CURATED_FORMAT
    ):
        raise ValueError("unsupported curated corpus manifest")
    declared = manifest.get("curated_manifest_sha256", "")
    require_lower_sha256("curated_manifest_sha256", declared)
    payload = dict(manifest)
    payload.pop("curated_manifest_sha256", None)
    if hashlib.sha256(canonical_json_bytes(payload)).hexdigest() != declared:
        raise ValueError("curated corpus manifest identity mismatch")
    lane_rules = manifest.get("lane_rules")
    if not isinstance(lane_rules, dict):
        raise ValueError("curated corpus has no pinned lane rules")
    require_lower_sha256("lane rules sha256", str(lane_rules.get("sha256", "")))
    require_lower_sha256(
        "lane rules identity_sha256",
        str(lane_rules.get("identity_sha256", "")),
    )
    return manifest


def split_curated_lanes(
    curated_manifest_path: str | Path,
    *,
    out_dir: str | Path,
    shard_docs: int = 50_000,
) -> dict:
    if shard_docs < 1:
        raise ValueError("lane shard_docs must be positive")
    manifest_path = Path(curated_manifest_path)
    curated = _load_curated(manifest_path)
    output = Path(out_dir)
    if output.exists() and any(output.rglob("*.jsonl")):
        raise ValueError("lane shard output already contains JSONL files")
    output.mkdir(parents=True, exist_ok=True)

    writers = {
        (split, lane): _Writer(output, split, lane, shard_docs)
        for split in ("train", "validation")
        for lane in sorted(REQUIRED_LANES)
    }
    expected = {"train": 0, "validation": 0}
    observed = {"train": 0, "validation": 0}

    for split in ("train", "validation"):
        records = curated.get("splits", {}).get(split)
        if not isinstance(records, list) or not records:
            raise ValueError(f"curated {split} split is empty")
        for record in records:
            filename = record.get("filename")
            digest = record.get("sha256", "")
            require_lower_sha256(f"curated {split} shard sha256", digest)
            shard = manifest_path.parent / filename
            if not shard.is_file():
                raise ValueError(f"missing curated shard: {shard}")
            if shard.stat().st_size != int(record.get("bytes", -1)):
                raise ValueError(f"curated shard size mismatch: {filename}")
            if sha256_file(shard) != digest:
                raise ValueError(f"curated shard hash mismatch: {filename}")
            expected[split] += int(record.get("documents", 0))
            with shard.open(encoding="utf-8") as stream:
                for line_no, line in enumerate(stream, 1):
                    if not line.strip():
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise ValueError(f"{shard}:{line_no}: invalid JSON") from exc
                    lane = row.get("lane") if isinstance(row, dict) else None
                    if lane not in REQUIRED_LANES:
                        raise ValueError(
                            f"{shard}:{line_no}: missing or invalid curated lane"
                        )
                    writers[(split, lane)].add(row)
                    observed[split] += 1

    for writer in writers.values():
        writer.close()
    if observed != expected:
        raise ValueError(
            f"curated lane split document count mismatch: expected={expected}, observed={observed}"
        )

    splits: dict[str, dict[str, dict]] = {}
    for split in ("train", "validation"):
        splits[split] = {}
        for lane in sorted(REQUIRED_LANES):
            writer = writers[(split, lane)]
            splits[split][lane] = {
                "documents": writer.documents,
                "shards": writer.records,
            }

    report = {
        "format": FORMAT,
        "curated_manifest": {
            "filename": manifest_path.name,
            "file_sha256": sha256_file(manifest_path),
            "identity_sha256": curated["curated_manifest_sha256"],
        },
        "lane_rules": dict(curated["lane_rules"]),
        "splits": splits,
        "totals": dict(observed),
    }
    payload = dict(report)
    report["lane_shards_sha256"] = hashlib.sha256(
        canonical_json_bytes(payload)
    ).hexdigest()
    atomic_write_json(output / "lane-shards.manifest.json", report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--curated-manifest", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--shard-docs", type=int, default=50_000)
    args = parser.parse_args()
    report = split_curated_lanes(
        args.curated_manifest,
        out_dir=args.out_dir,
        shard_docs=args.shard_docs,
    )
    print(
        f"[curated-lanes] train={report['totals']['train']} "
        f"validation={report['totals']['validation']} "
        f"sha256={report['lane_shards_sha256']}"
    )


if __name__ == "__main__":
    main()
