#!/usr/bin/env bash
# Configurează accesul SSH cu cheie către Hetzner Storage Box.
# Rulare pe VPS:  bash setup-storagebox.sh u123456 u123456.your-storagebox.de
# Parola se introduce interactiv O SINGURĂ DATĂ (pentru instalarea cheii).
set -euo pipefail

SB_USER="${1:?Usage: $0 <user> <host>}"
SB_HOST="${2:?Usage: $0 <user> <host>}"
SB_PORT=23
KEY=/root/.ssh/storagebox_ed25519

# 1. Cheie dedicată (fără passphrase — folosită de cron)
if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -f "$KEY" -N "" -C "swypik-vps-backup"
  echo "Cheie generata: $KEY"
else
  echo "Cheie existenta: $KEY"
fi

# 2. Instalează cheia pe Storage Box (cere parola o dată)
echo ""
echo ">>> Se cere parola Storage Box (o singura data, pentru instalarea cheii):"
cat "${KEY}.pub" | ssh -p "$SB_PORT" "${SB_USER}@${SB_HOST}" install-ssh-key

# 3. Test fără parolă
echo ""
if ssh -p "$SB_PORT" -i "$KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
     "${SB_USER}@${SB_HOST}" "mkdir -p backups && echo CONECTAT-FARA-PAROLA"; then
  echo "✓ Autentificare cu cheie functioneaza"
else
  echo "✗ Autentificarea cu cheie a esuat"; exit 1
fi

# 4. Salvează configurația pentru backup-all.sh
cat > /etc/swypik-backup.env <<EOF
STORAGE_BOX_USER=$SB_USER
STORAGE_BOX_HOST=$SB_HOST
STORAGE_BOX_PORT=$SB_PORT
SSH_KEY=$KEY
BACKUP_ROOT=/opt/backups
KEEP_LOCAL_DAYS=7
EOF
chmod 600 /etc/swypik-backup.env
echo "✓ Config scris in /etc/swypik-backup.env"
echo ""
echo "Urmatorul pas: bash /usr/local/bin/backup-all.sh"
