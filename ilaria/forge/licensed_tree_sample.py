"""Deterministically derive tokenizer/corpus samples from a licensed-tree manifest."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

try:
    from .licensed_tree_source import validate_manifest
except ImportError:  # direct script execution
    from licensed_tree_source import validate_manifest

SAMPLE_FORMAT = "ilaria-licensed-tree-sample-v1"


def _build_sample_from_manifest(
    manifest: dict,
    *,
    root: str | Path,
    prefixes: list[str],
    out_path: str | Path,
    max_bytes: int,
) -> dict:
    if max_bytes < 1:
        raise ValueError("licensed-tree sample max_bytes must be positive")
    normalized = sorted({prefix.replace("\\", "/").lstrip("/") for prefix in prefixes})
    if not normalized or any(not prefix for prefix in normalized):
        raise ValueError("licensed-tree sample requires non-empty path prefixes")
    tree = Path(root).resolve()
    groups = [
        [record for record in manifest["files"] if record["path"].startswith(prefix)]
        for prefix in normalized
    ]
    if not any(groups):
        raise ValueError("licensed-tree sample prefixes matched no licensed files")

    selected = []
    seen: set[str] = set()
    positions = [0 for _ in groups]
    active = True
    while active:
        active = False
        for index, group in enumerate(groups):
            while positions[index] < len(group):
                record = group[positions[index]]
                positions[index] += 1
                if record["path"] in seen:
                    continue
                seen.add(record["path"])
                selected.append(record)
                active = True
                break

    destination = Path(out_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    included = []
    with destination.open("w", encoding="utf-8", newline="\n") as stream:
        for record in selected:
            source = tree / record["path"]
            text = source.read_text(encoding="utf-8", errors="ignore").strip()
            if not text:
                continue
            header = f"\n<|source-file:{record['path']}|>\n"
            payload = (header + text + "\n").encode("utf-8")
            if written and written + len(payload) > max_bytes:
                break
            if not written and len(payload) > max_bytes:
                payload = payload[:max_bytes]
                decoded = payload.decode("utf-8", errors="ignore")
                stream.write(decoded)
                written = len(decoded.encode("utf-8"))
                included.append(record["path"])
                break
            stream.write(payload.decode("utf-8"))
            written += len(payload)
            included.append(record["path"])
            if written >= max_bytes:
                break
    if written == 0:
        raise ValueError("licensed-tree sample produced no text")
    return {
        "format": SAMPLE_FORMAT,
        "source_manifest_sha256": manifest["manifest_sha256"],
        "source_name": manifest["source_name"],
        "source_revision": manifest["source_revision"],
        "prefixes": normalized,
        "files": included,
        "file_count": len(included),
        "bytes": written,
        "output": str(destination),
    }


def build_sample(
    manifest_path: str | Path,
    *,
    root: str | Path,
    prefixes: list[str],
    out_path: str | Path,
    max_bytes: int,
) -> dict:
    manifest = validate_manifest(manifest_path, root=root)
    return _build_sample_from_manifest(
        manifest,
        root=root,
        prefixes=prefixes,
        out_path=out_path,
        max_bytes=max_bytes,
    )


def build_sample_set(
    manifest_path: str | Path,
    *,
    root: str | Path,
    lanes: dict[str, list[str]],
    out_dir: str | Path,
    max_bytes: int,
) -> dict[str, dict]:
    if not lanes:
        raise ValueError("licensed-tree sample set requires at least one lane")
    manifest = validate_manifest(manifest_path, root=root)
    destination = Path(out_dir)
    destination.mkdir(parents=True, exist_ok=True)
    reports = {}
    for lane in sorted(lanes):
        if not lane or any(ch in lane for ch in "\\/:"):
            raise ValueError(f"licensed-tree sample lane name is invalid: {lane!r}")
        reports[lane] = _build_sample_from_manifest(
            manifest,
            root=root,
            prefixes=lanes[lane],
            out_path=destination / f"{lane}.txt",
            max_bytes=max_bytes,
        )
    return reports


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--prefix", action="append", required=True)
    parser.add_argument("--max-bytes", type=int, required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    report = build_sample(
        args.manifest,
        root=args.root,
        prefixes=args.prefix,
        out_path=args.out,
        max_bytes=args.max_bytes,
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
