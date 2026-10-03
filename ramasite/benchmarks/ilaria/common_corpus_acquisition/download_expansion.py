"""Download three checksum-pinned public shards into a fresh quarantine folder."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import requests

REVISION = "307910e4c5d040d6f318e6edf2a2b97849155771"
SHARDS = (
    ("subset_100_2.parquet", 432006255, "9fe4ba76b9c2fa2ef06bde654b0396f1d2c1de4d939907b43173efe89580fc49"),
    ("subset_100_3.parquet", 426056523, "5c5e88303b6f24a59bedb9224dd2e591d5096f37de3dbd186749a4c86860adae"),
    ("subset_100_4.parquet", 437586876, "84f0270e652de2c53946689a2f33e6e637521c6235358f126597ec2a352a1857"),
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    deadline = time.monotonic() + 20 * 60
    receipt = {"schema": "ilaria-public-download-receipt-v1", "source": "PleIAs/common_corpus", "revision": REVISION, "production_approved": False, "shards": []}
    total = 0
    for filename, expected_bytes, expected_sha in SHARDS:
        source_path = "common_corpus_1/" + filename
        url = f"https://huggingface.co/datasets/PleIAs/common_corpus/resolve/{REVISION}/{source_path}"
        digest = hashlib.sha256()
        observed = 0
        partial = output / (filename + ".part")
        print(json.dumps({"state": "downloading", "filename": filename, "expected_bytes": expected_bytes}), flush=True)
        with requests.get(url, stream=True, timeout=(30, 60)) as response:
            response.raise_for_status()
            with partial.open("xb") as stream:
                for chunk in response.iter_content(1024 * 1024):
                    if time.monotonic() > deadline:
                        raise RuntimeError("download time budget exceeded")
                    observed += len(chunk)
                    total += len(chunk)
                    if observed > expected_bytes or total > 2 * 1024**3:
                        raise RuntimeError("download byte budget exceeded")
                    digest.update(chunk)
                    stream.write(chunk)
                stream.flush()
                os.fsync(stream.fileno())
            http_metadata = {key: response.headers.get(key) for key in ("ETag", "Last-Modified")}
        actual_sha = digest.hexdigest()
        if observed != expected_bytes or actual_sha != expected_sha:
            raise RuntimeError(f"source size or LFS SHA mismatch: {filename}")
        destination = output / filename
        if destination.exists():
            raise RuntimeError("destination already exists")
        os.link(partial, destination)
        partial.unlink()
        receipt["shards"].append({"path": source_path, "url": url, "filename": filename, "bytes": observed, "sha256": actual_sha, "expected_lfs_sha256": expected_sha, "http_metadata": http_metadata})
        (output / "download-receipt.json").write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"state": "verified", "filename": filename, "bytes": observed, "sha256": actual_sha}), flush=True)
    print(json.dumps({"state": "complete", "shards": len(receipt["shards"]), "bytes": total}), flush=True)


if __name__ == "__main__":
    main()
