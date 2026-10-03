#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
go_cmd="${GO_COMMAND:-go}"
python_cmd="${PYTHON_COMMAND:-python3}"
cgroup_root="${NEXUS_TEST_CGROUP_ROOT:-}"
tmp_base="${TMPDIR:-/tmp}"
tmp="$(mktemp -d "${tmp_base%/}/nexus-supervisor-v3-worker5-XXXXXXXX")"

cleanup() {
  case "$tmp" in
    "${tmp_base%/}"/nexus-supervisor-v3-worker5-*) rm -rf -- "$tmp" ;;
    *) printf 'refusing to remove unexpected temporary path: %s\n' "$tmp" >&2; return 1 ;;
  esac
}
trap cleanup EXIT

host_os="$("$go_cmd" env GOHOSTOS)"
host_arch="$("$go_cmd" env GOHOSTARCH)"
if [[ "$host_os" != linux ]]; then
  printf 'verify-supervisor-v3.sh requires a native Linux Go toolchain, got %s/%s\n' "$host_os" "$host_arch" >&2
  exit 1
fi
if [[ -z "$cgroup_root" ]]; then
  printf 'Linux supervisor v3 integration requires NEXUS_TEST_CGROUP_ROOT from an explicit delegation.\n' >&2
  exit 1
fi

export GOWORK=off
export GOOS="$host_os"
export GOARCH="$host_arch"

(
  cd "$root/swyp"
  "$go_cmd" build -buildvcs=false -trimpath -o "$tmp/swyp" ./cmd/swyp
)
(
  cd "$root/swypik-os"
  "$go_cmd" build -buildvcs=false -trimpath -o "$tmp/plan-supervisor" ./cmd/plan-supervisor
)
(
  cd "$root/ilaria"
  "$go_cmd" build -buildvcs=false -trimpath -o "$tmp/evidence-check" ./cmd/evidence-check
)

args=(
  "$root/ramasite/scripts/verify-supervisor-v3.py"
  --repo-root "$root"
  --swyp "$tmp/swyp"
  --supervisor "$tmp/plan-supervisor"
  --verifier "$tmp/evidence-check"
  --artifacts-dir "$tmp"
  --cgroup-root "$cgroup_root"
)
if [[ "${NEXUS_V3_ALLOW_SKIPS:-0}" == "1" ]]; then
  args+=(--allow-skips)
fi
"$python_cmd" "${args[@]}"
