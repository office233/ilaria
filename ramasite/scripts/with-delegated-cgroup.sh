#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--inside" ]]; then
  shift
  path="$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)"
  root="/sys/fs/cgroup${path}"
  [[ -n "$path" && "$root" != "/sys/fs/cgroup" && -d "$root" && -w "$root" ]] || {
    echo "No writable explicitly delegated cgroup v2 root." >&2
    exit 2
  }
	# cgroup v2 domain controllers cannot be enabled in a cgroup that contains
	# processes. Keep the host/control process in a leaf and reserve the
	# delegated root exclusively for supervisor-created child cgroups.
	mkdir -p "$root/.host"
	echo "$$" > "$root/.host/cgroup.procs"
	echo '+cpu +memory +pids' > "$root/cgroup.subtree_control"
  export NEXUS_TEST_CGROUP_ROOT="$root"
  exec "$@"
fi

[[ $# -gt 0 ]] || { echo "usage: with-delegated-cgroup.sh COMMAND [ARG...]" >&2; exit 2; }
[[ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null || true)" == "cgroup2fs" ]] || {
  echo "cgroup v2 is required." >&2
  exit 2
}

if [[ -n "${NEXUS_TEST_CGROUP_ROOT:-}" ]]; then
  exec "$@"
fi

command -v systemd-run >/dev/null 2>&1 || { echo "systemd-run is required to obtain explicit delegation." >&2; exit 2; }
exec systemd-run --user --scope -p Delegate=yes -- bash "$0" --inside "$@"
