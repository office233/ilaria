#!/usr/bin/env bash
# Copy source from Windows into a private native Linux build directory.
# No disk device is attached, mounted or formatted. WSL is a development host.
set -euo pipefail
source_dir= mode=verify kernel=
while (($#)); do
 case "$1" in
  --source) source_dir=$2; shift 2;;
  --mode) mode=$2; shift 2;;
  --kernel-version) kernel=$2; shift 2;;
  *) echo "Unknown argument: $1" >&2; exit 2;;
 esac
done
[[ -n $source_dir && -f $source_dir/go.mod && -d $source_dir/.git ]] || { echo 'Pass --source with the local Git project directory.' >&2; exit 2; }
[[ $mode = verify || $mode = build ]] || { echo 'Mode must be verify or build.' >&2; exit 2; }
[[ $mode != build || -n $kernel ]] || { echo 'An explicit --kernel-version is required for image builds.' >&2; exit 2; }
source_dir=$(realpath "$source_dir")
for tool in git go gcc python3 tar; do command -v "$tool" >/dev/null || { echo "Missing Linux build dependency: $tool" >&2; exit 1; }; done
revision=$(git -c safe.directory="$source_dir" -C "$source_dir" rev-parse HEAD)
dirty=false
[[ -z $(git -c safe.directory="$source_dir" -C "$source_dir" status --porcelain) ]] || dirty=true
mkdir -p "$HOME/.cache/swypik-native"
stage=$(mktemp -d "$HOME/.cache/swypik-native/build.XXXXXXXX")
mkdir -p "$stage/out"
result_dir="$source_dir/out/linux-$(date -u +%Y%m%dT%H%M%SZ)-${stage##*.}"
finish() {
 rc=$?
 trap - EXIT
 mkdir -p "$result_dir"
 cp -R "$stage/out/." "$result_dir/" || rc=1
 printf 'exit_code=%s\nsource_revision=%s\nsource_dirty=%s\nmode=%s\n' "$rc" "$revision" "$dirty" "$mode" > "$result_dir/result.txt"
 printf '%s\n' "$result_dir" > "$source_dir/out/last-linux-build.txt"
 printf 'OUTPUT_DIRECTORY=%s\nEXIT_CODE=%s\n' "$result_dir" "$rc"
 if [[ $rc = 0 ]]; then rm -rf -- "$stage"; else echo "Failed build snapshot retained: $stage" >&2; fi
 exit "$rc"
}
trap finish EXIT
# Null-delimited tracked + nonignored new paths. Never export .git, .env,
# node_modules, data, old executables or build output.
git -c safe.directory="$source_dir" -C "$source_dir" ls-files --cached --others --exclude-standard --deduplicate -z > "$stage/out/source-paths.nul"
tar -C "$source_dir" --null -T "$stage/out/source-paths.nul" -cf - | tar -C "$stage" -xf -
cd "$stage"
# Git may have checked out historical files as CRLF before attributes existed.
python3 - <<'PY'
from pathlib import Path
import hashlib
paths = Path('out/source-paths.nul').read_bytes().split(b'\0')
manifest = []
for raw in paths:
    if not raw: continue
    p = Path(raw.decode('utf-8'))
    if p.is_symlink(): raise RuntimeError(f'Source symlink requires review: {p}')
    if p.suffix in ('.go', '.sh', '.py', '.yml') or str(p).startswith('system/rootfs/'):
        p.write_bytes(p.read_bytes().replace(b'\r\n', b'\n'))
    manifest.append(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + str(p))
Path('out/source-files.sha256').write_text('\n'.join(manifest) + '\n')
PY
tar --exclude='./out' -czf out/source-working-tree.tar.gz .
export GOMAXPROCS=4
printf 'Source %s dirty=%s; native Linux build, mode=%s\n' "$revision" "$dirty" "$mode"
go version > out/toolchain.txt
go test -p 2 -race -count=1 -timeout=3m -json ./... > out/go-tests.jsonl 2>out/go-tests.err
go vet ./... > out/go-vet.log 2>&1
go test -race -count=10 -timeout=3m ./core/agent ./core/service ./core/search > out/repeated-tests.log 2>&1
bash -n scripts/build-os.sh scripts/build-wsl.sh
python3 -m py_compile scripts/smoke-os.py
python3 - <<'PY'
import collections, json
counts = collections.Counter()
for line in open('out/go-tests.jsonl'):
    event = json.loads(line)
    if event['Action'] in ('pass', 'fail', 'skip'):
        counts[('tests_' if 'Test' in event else 'packages_') + event['Action']] += 1
open('out/test-summary.json', 'w').write(json.dumps(counts, indent=2) + '\n')
print(json.dumps(counts))
PY
if [[ $mode = build ]]; then
 sudo -n env KERNEL_VERSION="$kernel" SOURCE_REVISION="$revision" SOURCE_DIRTY="$dirty" bash scripts/build-os.sh > out/build.log 2>&1
 python3 scripts/smoke-os.py --out out/smoke-bios > out/bios-smoke.log 2>&1
 python3 scripts/smoke-os.py --uefi --out out/smoke-uefi > out/uefi-smoke.log 2>&1
fi
