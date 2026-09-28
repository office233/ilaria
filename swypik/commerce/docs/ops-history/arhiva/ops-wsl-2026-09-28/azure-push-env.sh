#!/usr/bin/env bash
# Din WSL (root): copiază env-urile și cheile pe nodurile Azure + pregătește web-1 ca nod de control.
set -euo pipefail
install -d -m 700 /root/.ssh
install -m 600 /mnt/e/Swypik/ops/keys/swypik_admin /root/.ssh/swypik_admin
install -m 600 /mnt/e/Swypik/ops/keys/swypik_deploy /root/.ssh/swypik_deploy
J=swypikadmin@4.165.143.236
O=(-i /root/.ssh/swypik_admin -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/azure_known_hosts -o ConnectTimeout=20 -o LogLevel=ERROR)
PJ="ssh ${O[*]} -W %h:%p $J"
on() { local h=$1; shift; ssh "${O[@]}" -o ProxyCommand="$PJ" "swypikadmin@$h" "$@"; }
E=/root/azure-env
# env-uri
on 10.60.1.10 'sudo install -d -m 750 -o dev -g dev /opt/swypik/env && sudo install -m 600 -o dev -g dev /dev/stdin /opt/swypik/env/swypik.env' < $E/swypik.env
on 10.60.1.10 'sudo install -m 600 -o dev -g dev /dev/stdin /opt/swypik/env/multi-erp.env' < $E/multi-erp.env
on 10.60.2.10 'sudo install -d -m 750 -o dev -g dev /opt/swypik/env && sudo install -m 600 -o dev -g dev /dev/stdin /opt/swypik/env/data.env' < $E/data.env
# cheia internă de deploy pe web-1 (dev) + hosts.env
on 10.60.1.10 'sudo install -m 600 -o dev -g dev /dev/stdin /home/dev/.ssh/swypik_deploy' < /root/.ssh/swypik_deploy
on 10.60.1.10 'sudo -u dev tee /opt/swypik/env/hosts.env >/dev/null && sudo chmod 640 /opt/swypik/env/hosts.env' <<'EOT'
WEB_HOSTS="10.60.1.10 10.60.1.11"
WORKER_HOSTS="10.60.3.10"
DATA_HOST="10.60.2.10"
SSH_KEY=/home/dev/.ssh/swypik_deploy
PUBLIC_URL=https://swypik.com
REGISTRY_PREFIX=
EOT
# clona Swypik pe web-1
on 10.60.1.10 'sudo install -d -o dev -g dev /opt/swypik && if [ ! -d /opt/swypik/app/.git ]; then sudo -u dev git clone -q git@github.com:office233/swypik-commerce-platform.git /opt/swypik/app; fi && sudo -u dev git -C /opt/swypik/app log --oneline -1'
# web-1 → celelalte noduri ca dev
on 10.60.1.10 'for h in 10.60.1.11 10.60.2.10 10.60.3.10; do sudo -u dev ssh -i /home/dev/.ssh/swypik_deploy -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o LogLevel=ERROR dev@$h hostname; done'
echo PUSH_ENV_OK
