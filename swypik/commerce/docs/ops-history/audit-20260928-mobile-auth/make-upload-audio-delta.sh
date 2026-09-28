#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
import hashlib
import json
import os
import tarfile

base = Path('/opt/swypik/app')
snapshot = Path('/opt/swypik/builds/upload-audio-20260927-191040')
out_dir = Path('/tmp/swypik-upload-audio-delta')
out_dir.mkdir(parents=True, exist_ok=True)

excluded_dirs = {
    '.git', 'node_modules', '.next', 'playwright-report', 'test-results',
    'coverage', 'dist', '.turbo', '.expo'
}
excluded_files = {'tsconfig.tsbuildinfo', 'PREVIOUS_TAG'}

def excluded(relative: Path) -> bool:
    return any(part in excluded_dirs for part in relative.parts) or relative.name in excluded_files

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

def collect(root: Path):
    result = {}
    for path in root.rglob('*'):
        relative = path.relative_to(root)
        if excluded(relative):
            continue
        key = relative.as_posix()
        if path.is_symlink():
            result[key] = {'kind': 'symlink', 'target': os.readlink(path)}
        elif path.is_file():
            stat = path.stat()
            result[key] = {
                'kind': 'file',
                'sha256': sha256(path),
                'size': stat.st_size,
            }
    return result

base_files = collect(base)
snapshot_files = collect(snapshot)
changed = sorted(
    relative for relative, metadata in snapshot_files.items()
    if relative not in base_files or base_files[relative] != metadata
)
deleted = sorted(relative for relative in base_files if relative not in snapshot_files)

manifest = {
    'base': str(base),
    'snapshot': str(snapshot),
    'changed': changed,
    'deleted': deleted,
    'changed_meta': {relative: snapshot_files[relative] for relative in changed},
}
manifest_path = out_dir / 'manifest.json'
manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding='utf-8')

archive_path = out_dir / 'changed-files.tar.gz'
with tarfile.open(archive_path, 'w:gz', compresslevel=9) as archive:
    archive.add(manifest_path, arcname='.swypik-delta/manifest.json')
    for relative in changed:
        archive.add(snapshot / relative, arcname=relative, recursive=False)

print(json.dumps({
    'changed_count': len(changed),
    'deleted_count': len(deleted),
    'archive_bytes': archive_path.stat().st_size,
    'manifest_bytes': manifest_path.stat().st_size,
    'first_changed': changed[:25],
    'deleted': deleted,
}, indent=2))
PY
