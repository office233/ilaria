#!/bin/bash
#
# disk-watch.sh — măsoară spațiul liber pe gazdă și îl raportează aplicației.
#
# DE CE RULEAZĂ PE GAZDĂ, NU ÎNTR-UN CONTAINER (verificat 2026-08-17):
#   Containerele nu au niciun bind mount din gazdă, iar `df` dinăuntru vede
#   capacitatea VHDX-ului, nu partiția fizică:
#     în container: overlay 1006.9G, 937.5G liberi
#     pe gazdă:     /mnt/e             378G liberi
#   În timpul incidentului din 17 august, containerele „vedeau" 885 GB liberi
#   în timp ce gazda avea 0,03 GB — de aceea nimic nu a semnalat problema.
#
# CE PARTIȚIE MĂSURĂM (actualizat 2026-08-19):
#   Pe cea care găzduiește VHDX-ul distro-ului, fiindcă doar acolo crește
#   consumul când build-urile umflă discul. Distro-ul a fost mutat de pe `D:`
#   pe `E:\wsl\swypik\ext4.vhdx`; scriptul măsura în continuare `/mnt/d`, adică
#   o partiție care nu mai are legătură cu problema. Ar fi raportat vesel 148 GB
#   liberi în timp ce `E:` se umplea — exact incidentul din 17 august, doar că
#   de data asta fără niciun semnal.
#   Dacă muți iar distro-ul, schimbă `DISK_WATCH_MOUNT` sau linia de mai jos.
#
# INSTALARE (crontab-ul utilizatorului care rulează stack-ul, orar):
#   0 * * * * /opt/swypik/app/scripts/ops/disk-watch.sh >> /var/log/swypik-disk-watch.log 2>&1
#
# Pragul se configurează din `DISK_WATCH_MIN_FREE_GB` în mediul aplicației
# (implicit 15 GB). Scriptul doar raportează cifra; decizia de alertare e în
# `app/api/cron/disk-watch/route.ts`, ca să fie într-un singur loc.

set -uo pipefail

MOUNT=${DISK_WATCH_MOUNT:-/mnt/e}
WEB=${DISK_WATCH_URL:-http://localhost:3005}
ENV_FILE=${DISK_WATCH_ENV:-/opt/swypik/app/infra/hetzner/.env.production}

# CRON_SECRET din mediu sau din .env.production. Nu îl tipărim niciodată.
if [[ -z "${CRON_SECRET:-}" && -r "$ENV_FILE" ]]; then
	CRON_SECRET=$(grep -m1 '^CRON_SECRET=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"'')
fi
if [[ -z "${CRON_SECRET:-}" ]]; then
	echo "[disk-watch] EROARE: CRON_SECRET indisponibil" >&2
	exit 2
fi

avail_kb=$(df --output=avail -k "$MOUNT" 2>/dev/null | tail -1 | tr -d ' ')
if [[ -z "$avail_kb" ]]; then
	echo "[disk-watch] EROARE: nu pot citi spațiul din $MOUNT" >&2
	exit 2
fi
free_gb=$((avail_kb / 1024 / 1024))

code=$(curl -sS -m 30 -o /tmp/disk-watch.out -w '%{http_code}' \
	-X POST \
	-H "x-cron-secret: ${CRON_SECRET}" \
	-H 'content-type: application/json' \
	-d "{\"freeGb\":${free_gb},\"mount\":\"${MOUNT}\"}" \
	"${WEB}/api/cron/disk-watch" 2>/tmp/disk-watch.err)

if [[ "$code" == "200" ]]; then
	echo "[disk-watch] $(date -Iseconds) ${MOUNT}: ${free_gb} GB liberi → $(cat /tmp/disk-watch.out)"
else
	echo "[disk-watch] $(date -Iseconds) EȘEC http=${code} $(cat /tmp/disk-watch.err 2>/dev/null | head -2)" >&2
	exit 1
fi
