#!/usr/bin/env bash
set -euo pipefail

repo=/opt/swypik/app
snapshot=/opt/swypik/builds/upload-audio-20260927-191040
manifest=/tmp/swypik-upload-audio-delta/manifest.json
worktree=/opt/swypik/recovery/upload-audio-20260928-antigravity
branch=recovery/upload-audio-20260928-antigravity

if [ -e "$worktree" ]; then
  echo "Refusing to overwrite existing worktree: $worktree" >&2
  exit 2
fi
if sudo -iu dev git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
  echo "Refusing to overwrite existing branch: $branch" >&2
  exit 2
fi

install -d -o dev -g dev /opt/swypik/recovery
sudo -iu dev git -C "$repo" worktree add -b "$branch" "$worktree" 28687e3971d18e97d6fdb4e2d2c0bf7f0e4a9f23

python3 - "$snapshot" "$manifest" "$worktree" <<'PY'
from pathlib import Path
import json
import os
import shutil
import sys

snapshot = Path(sys.argv[1])
manifest = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
worktree = Path(sys.argv[3])
exclude = {
    'AZURE_WORKFLOW.md',
    'CAMERA_FEED_SHA256SUMS',
    'CHECKS_PASSED',
    'IMAGE_READY',
    'LAUNCH_SHA256SUMS',
    'azure-build.log',
    'azure-checks.log',
    'azure-rollout.log',
}

copied = []
for relative in manifest['changed']:
    if relative in exclude:
        continue
    source = snapshot / relative
    target = worktree / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        if target.exists() or target.is_symlink():
            target.unlink()
        target.symlink_to(os.readlink(source))
    else:
        shutil.copy2(source, target)
    copied.append(relative)

print(f'Copied {len(copied)} source files; excluded {len(exclude)} build artifacts.')
PY

chown -R dev:dev "$worktree"
sudo -iu dev git -C "$worktree" config user.name "Swypik Recovery"
sudo -iu dev git -C "$worktree" config user.email "recovery@swypik.local"
sudo -iu dev git -C "$worktree" add -A

echo 'RECOVERY_DIFF_STAT'
sudo -iu dev git -C "$worktree" diff --cached --stat

echo 'RECOVERY_STATUS'
sudo -iu dev git -C "$worktree" status --short

sudo -iu dev git -C "$worktree" commit -m "recovery: preserve Azure upload and audio release source"

echo 'RECOVERY_COMMIT'
sudo -iu dev git -C "$worktree" rev-parse HEAD

echo 'PUSH_ATTEMPT'
sudo -iu dev git -C "$worktree" push --set-upstream origin "$branch"
