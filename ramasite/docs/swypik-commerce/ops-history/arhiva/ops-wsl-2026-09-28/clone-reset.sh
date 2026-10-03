set -euo pipefail
cd /opt/swypik/app
G="git -c safe.directory=/opt/swypik/app"
ts=$(date +%Y%m%d-%H%M)
B=/opt/swypik/backups/live-clone-dirty-$ts
mkdir -p $B
$G diff > $B/working-tree.patch
$G stash show -p stash@{0} > $B/stash0.patch 2>/dev/null || true
$G status --porcelain | grep '^??' | awk '{print $2}' | while read f; do mkdir -p "$B/untracked/$(dirname "$f")"; cp -a "$f" "$B/untracked/$f"; done
echo "HEAD before: $($G rev-parse --short HEAD)" > $B/README.txt
ls -la $B; du -sh $B
chown -R root:root $B; chmod -R go-rwx $B
# reset to exactly origin/main
sudo -u dev git -C /opt/swypik/app fetch -q origin
sudo -u dev git -C /opt/swypik/app reset -q --hard origin/main
sudo -u dev git -C /opt/swypik/app clean -fdq -e infra/hetzner/.env.production
sudo -u dev git -C /opt/swypik/app stash clear
echo "HEAD now: $($G rev-parse --short HEAD)  dirty: $($G status --porcelain | wc -l)"
# lock down secrets
E=infra/hetzner/.env.production
chown dev:dev $E; chmod 600 $E; stat -c '%A %U:%G %n' $E
