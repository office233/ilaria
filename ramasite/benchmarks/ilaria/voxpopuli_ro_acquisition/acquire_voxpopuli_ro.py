"""Acquire original VoxPopuli Romanian ASR train transcripts into quarantine.

This reads only the public annotation archive. It does not fetch audio, model,
or code assets. Speaker and gender identifiers are intentionally discarded.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import os
import sys
from pathlib import Path
import sys as _nexus_sys
_nexus_sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nexus_ilaria_benchmark_paths import workspace_root


SOURCE = "facebookresearch/voxpopuli"
REVISION = "f7a3bb98d664e1d031763ec4f7639c4a530c64e9"
ARCHIVE_NAME = "asr_ro.tsv.gz"
ARCHIVE_SHA256 = "328018d32d40d48188bf6e752389d0e5b7a80332faed9d657e9824570adf902c"
ARCHIVE_URL = "https://dl.fbaipublicfiles.com/voxpopuli/annotations/asr/asr_ro.tsv.gz"
README_SHA256 = "4133d4ac56b283e295b1704e762a85df88700072fca4d675b914a0f396c855e8"
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_EXTRACTED_BYTES = 512 * 1024 * 1024


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode(
        "utf-8"
    )


def prepare_fresh_output_dir(output_dir: Path) -> None:
    """Claim a new output directory before opening source or tokenizer files."""
    if output_dir.exists():
        raise FileExistsError(
            f"output directory already exists; choose a fresh path: {output_dir}"
        )
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(exist_ok=False)


def publish_no_clobber(temp_path: Path, final_path: Path) -> None:
    """Atomically publish a same-filesystem temp file without replacing output."""
    os.link(temp_path, final_path)
    temp_path.unlink()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("quarantine_output_dir", type=Path)
    parser.add_argument(
        "--forge-root",
        type=Path,
        default=workspace_root(__file__),
        help="checkout root containing ilaria/forge (defaults to this recipe's checkout)",
    )
    args = parser.parse_args()
    source_dir, output_dir = args.source_dir, args.quarantine_output_dir
    if source_dir.resolve() == output_dir.resolve():
        raise ValueError("source and output directories must be distinct")
    prepare_fresh_output_dir(output_dir)
    archive = source_dir / ARCHIVE_NAME
    readme = source_dir / "source-README.md"
    archive_sha = hash_file(archive)
    if archive.stat().st_size > MAX_ARCHIVE_BYTES or archive_sha != ARCHIVE_SHA256:
        raise SystemExit("archive size or observed SHA-256 differs from acquisition record")
    readme_sha = hash_file(readme)
    if readme_sha != README_SHA256:
        raise SystemExit("pinned README SHA-256 differs from acquisition record")

    forge = args.forge_root.resolve() / "ilaria" / "forge"
    sys.path.insert(0, str(forge))
    from prepare_corpus import clean_text, scrub_pii  # noqa: E402
    from hf_tokenizer import load as load_ilarialex, tokenizer_sha256  # noqa: E402

    cleaner_path = forge / "prepare_corpus.py"
    tokenizer_path = args.forge_root.resolve() / "ilaria" / "data" / "production" / "ilarialex.json"
    tokenizer = load_ilarialex(str(tokenizer_path))
    tokenizer_hash = tokenizer_sha256(tokenizer_path)
    cleaner_hash = hash_file(cleaner_path)
    recipe_hash = hash_file(Path(__file__).resolve())

    out_path = output_dir / "voxpopuli-ro-asr-train.quarantine.jsonl"
    temp_path = out_path.with_suffix(out_path.suffix + ".tmp")
    seen: set[str] = set()
    line_number = 0
    train_rows = 0
    rejected_short = 0
    rejected_long = 0
    rejected_empty = 0
    deduplicated = 0
    emitted_docs = 0
    emitted_tokens = 0
    extracted_bytes = 0

    with gzip.open(archive, "rb") as compressed, temp_path.open("xb") as output:
        header = compressed.readline().decode("utf-8").rstrip("\r\n")
        headers = next(csv.reader([header], delimiter="|", quotechar='"'))
        required = {"id_", "original_text", "split"}
        if not required.issubset(headers):
            raise SystemExit("annotation header does not match the expected schema")
        text_index = headers.index("original_text")
        id_index = headers.index("id_")

        for raw_line in compressed:
            line_number += 1
            if len(raw_line) + extracted_bytes > MAX_EXTRACTED_BYTES:
                raise SystemExit("decompressed archive exceeded the 512 MiB cap")
            extracted_bytes += len(raw_line)
            stripped = raw_line.rstrip(b"\r\n")
            # The last fields are split and gender. Inspect split from the raw
            # suffix first, without decoding or parsing transcript text.
            suffix = stripped.rsplit(b"|", 2)
            if len(suffix) != 3:
                continue
            split_name = suffix[-2].strip().strip(b'"').decode("ascii", "ignore")
            if split_name != "train":
                continue

            fields = next(
                csv.reader(
                    [stripped.decode("utf-8")], delimiter="|", quotechar='"'
                )
            )
            if len(fields) != len(headers):
                rejected_empty += 1
                continue
            train_rows += 1
            transcript = fields[text_index].strip()
            if not transcript:
                rejected_empty += 1
                continue
            if len(transcript) < 20:
                rejected_short += 1
                continue
            if len(transcript) > 3000:
                rejected_long += 1
                continue

            cleaned = clean_text(transcript, max_len=3000)
            if not cleaned:
                rejected_short += 1
                continue
            if scrub_pii(cleaned) != cleaned:
                rejected_empty += 1
                continue
            text_bytes = cleaned.encode("utf-8")
            text_sha = hashlib.sha256(text_bytes).hexdigest()
            if text_sha in seen:
                deduplicated += 1
                continue
            seen.add(text_sha)
            token_count = len(tokenizer.encode(cleaned, add_special_tokens=False).ids) + 1
            emitted_tokens += token_count
            emitted_docs += 1
            record = {
                "schema": "ilaria-quarantined-corpus-document-v1",
                "source": SOURCE,
                "source_revision": REVISION,
                "source_archive": ARCHIVE_NAME,
                "source_archive_sha256": archive_sha,
                "source_split": "train",
                "source_line": line_number + 1,
                "source_record_sha256": hashlib.sha256(stripped).hexdigest(),
                "source_id_sha256": hashlib.sha256(
                    fields[id_index].encode("utf-8")
                ).hexdigest(),
                "source_text_sha256": hashlib.sha256(
                    transcript.encode("utf-8")
                ).hexdigest(),
                "candidate_text_sha256": text_sha,
                "text": cleaned,
            }
            payload = canonical_json(record)
            if output.tell() + len(payload) > MAX_EXTRACTED_BYTES:
                raise SystemExit("candidate output exceeded the 512 MiB cap")
            output.write(payload)

        output.flush()
        os.fsync(output.fileno())
    publish_no_clobber(temp_path, out_path)

    manifest = {
        "schema": "ilaria-public-data-quarantine-manifest-v1",
        "status": "QUARANTINE_NOT_PRODUCTION_RIGHTS_APPROVED",
        "source": SOURCE,
        "source_revision": REVISION,
        "source_archive_url": ARCHIVE_URL,
        "source_archive": ARCHIVE_NAME,
        "source_archive_bytes": archive.stat().st_size,
        "source_archive_sha256_observed": archive_sha,
        "upstream_archive_checksum_published": False,
        "http_observation_file": "download-observation.json",
        "source_readme": readme.name,
        "source_readme_sha256": readme_sha,
        "upstream_readme_claim": "VoxPopuli Data CC0; README also refers to European Parliament legal notice for raw data",
        "european_parliament_legal_notice_review": "UNRESOLVED",
        "selected_content": "original_text only; split=train only",
        "excluded_splits": ["dev", "test", "other/non-train"],
        "excluded_fields": ["speaker_id", "session_id", "gender", "normed_text", "decoded", "audio", "code", "models", "LM data"],
        "rows_scanned": line_number,
        "train_rows": train_rows,
        "documents_after_cleaning_and_exact_dedup": emitted_docs,
        "rejected_empty": rejected_empty,
        "rejected_short_under_20_chars": rejected_short,
        "rejected_long_over_3000_chars_without_truncation": rejected_long,
        "exact_duplicates_removed": deduplicated,
        "tokens_ilarialex_diagnostic_including_eos": emitted_tokens,
        "tokenizer_path": str(tokenizer_path),
        "tokenizer_sha256": tokenizer_hash,
        "cleaner_path": str(cleaner_path),
        "cleaner_sha256": cleaner_hash,
        "acquisition_recipe_path": str(Path(__file__).resolve()),
        "acquisition_recipe_sha256": recipe_hash,
        "output_file": out_path.name,
        "output_bytes": out_path.stat().st_size,
        "output_sha256": hash_file(out_path),
        "training_performed": False,
        "production_rights_approved": False,
    }
    manifest_path = output_dir / "candidate-manifest.json"
    manifest_bytes = canonical_json(manifest)
    manifest_temp = manifest_path.with_suffix(manifest_path.suffix + ".tmp")
    with manifest_temp.open("xb") as stream:
        stream.write(manifest_bytes)
        stream.flush()
        os.fsync(stream.fileno())
    publish_no_clobber(manifest_temp, manifest_path)
    print(
        json.dumps(
            {
                "rows_scanned": line_number,
                "train_rows": train_rows,
                "documents": emitted_docs,
                "tokens_diagnostic": emitted_tokens,
                "deduplicated": deduplicated,
                "rejected_short": rejected_short,
                "rejected_long": rejected_long,
                "candidate_bytes": out_path.stat().st_size,
                "candidate_sha256": manifest["output_sha256"],
                "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
                "status": manifest["status"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
