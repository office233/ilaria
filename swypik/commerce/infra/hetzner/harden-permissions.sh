#!/usr/bin/env bash
# Harden Swypik Hetzner file permissions and optionally install the DB backup cron.
# This script does not delete files.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/swypik}"
APP_DIR="${APP_DIR:-${DEPLOY_DIR}/app}"
BACKUP_DIR="${BACKUP_DIR:-${DEPLOY_DIR}/backups}"
LOG_DIR="${LOG_DIR:-${DEPLOY_DIR}/logs}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/infra/hetzner/.env.production}"
BACKUP_SCRIPT="${BACKUP_SCRIPT:-${APP_DIR}/infra/hetzner/backup-postgres.sh}"
BACKUP_CRON_SCHEDULE="${BACKUP_CRON_SCHEDULE:-0 3 * * *}"
INSTALL_BACKUP_CRON="${INSTALL_BACKUP_CRON:-false}"
DRY_RUN="${DRY_RUN:-false}"

run() {
  printf '+ %s\n' "$*"
  if [[ "$DRY_RUN" != "true" ]]; then
    "$@"
  fi
}

chmod_if_exists() {
  local mode="$1"
  local target="$2"
  if [[ -e "$target" ]]; then
    run chmod "$mode" "$target"
  fi
}

mkdir_hardened() {
  local target="$1"
  if [[ ! -d "$target" ]]; then
    run mkdir -p "$target"
  fi
  if [[ -e "$target" ]]; then
    run chmod 750 "$target"
  fi
}

remove_world_writable_bit() {
  local root="$1"
  if [[ ! -d "$root" ]]; then
    return 0
  fi

  while IFS= read -r -d '' target; do
    run chmod o-w "$target"
  done < <(find "$root" -xdev -perm -0002 -print0)
}

install_backup_cron() {
  if [[ ! -x "$BACKUP_SCRIPT" ]]; then
    printf 'Backup script is not executable: %s\n' "$BACKUP_SCRIPT" >&2
    printf 'Run this script after deploy, or check APP_DIR/BACKUP_SCRIPT.\n' >&2
    exit 1
  fi

  local cron_line="${BACKUP_CRON_SCHEDULE} ${BACKUP_SCRIPT} >> ${LOG_DIR}/backup-cron.log 2>&1"
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '+ install crontab line: %s\n' "$cron_line"
    return 0
  fi

  (crontab -l 2>/dev/null | grep -vF "$BACKUP_SCRIPT"; printf '%s\n' "$cron_line") | crontab -
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable cron >/dev/null 2>&1 || true
    systemctl start cron >/dev/null 2>&1 || true
  fi
  printf 'Backup cron installed: %s\n' "$cron_line"
}

printf 'Hardening Swypik permissions\n'
printf '  APP_DIR=%s\n' "$APP_DIR"
printf '  DRY_RUN=%s\n' "$DRY_RUN"

mkdir_hardened "$DEPLOY_DIR"
mkdir_hardened "$APP_DIR"
mkdir_hardened "$BACKUP_DIR"
mkdir_hardened "$LOG_DIR"

chmod_if_exists 750 "${APP_DIR}/infra"
chmod_if_exists 750 "${APP_DIR}/infra/hetzner"
if [[ -e "$ENV_FILE" ]]; then
  run chmod 640 "$ENV_FILE"
fi
chmod_if_exists 644 "${APP_DIR}/infra/hetzner/Caddyfile"
chmod_if_exists 644 "${APP_DIR}/infra/hetzner/docker-compose.prod.yml"

if compgen -G "${APP_DIR}/infra/hetzner/*.sh" >/dev/null; then
  for script in "${APP_DIR}"/infra/hetzner/*.sh; do
    chmod_if_exists 750 "$script"
  done
fi

chmod_if_exists 750 "$BACKUP_SCRIPT"
remove_world_writable_bit "$DEPLOY_DIR"

if [[ "$INSTALL_BACKUP_CRON" == "true" ]]; then
  install_backup_cron
else
  printf 'Backup cron not changed. Set INSTALL_BACKUP_CRON=true to install %s daily.\n' "$BACKUP_SCRIPT"
fi

printf 'Hardening complete.\n'
