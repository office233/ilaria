#!/bin/bash
#
# wsl-deploy-web.sh [serviciu...] — deploy pe producția din WSL (distro `swypik`).
#
# DE CE A FOST REFĂCUT (2026-08-17):
#   Versiunea anterioară rula `up -d --build web-next` — UN SINGUR serviciu — și
#   raporta succes. Consecință reală: fix-ul P1-01 (timeout ffmpeg, `video-worker`)
#   a stat 2 zile în `main`, comis și pushed, fără să ruleze în producție. Nimic
#   nu semnala asta: `git pull` zicea ok, containerul era `healthy`, site-ul 200.
#   Același tipar se produsese pe 10 august (imagine veche de 22h după un deploy
#   „reușit").
#
# CE FACE ACUM:
#   - fără argumente  → rebuild TOATE serviciile care conțin cod din repo;
#   - cu argumente    → rebuild doar serviciile cerute (validate față de listă);
#   - afișează hash-ul imaginii ÎNAINTE și DUPĂ pentru fiecare serviciu;
#   - iese cu cod ≠ 0 dacă vreun serviciu atins a rămas pe același hash.
#
#   Ultima regulă e esența: „a rulat fără eroare" nu înseamnă „a livrat cod nou".
#   Docker reutilizează silent imaginea din cache dacă nu detectează schimbări,
#   iar un `git pull` fără efect nu produce niciun avertisment.
#
# UTILIZARE:
#   bash scripts/deploy/wsl-deploy-web.sh                       # tot codul de aplicație
#   bash scripts/deploy/wsl-deploy-web.sh web-next              # doar frontend/API
#   bash scripts/deploy/wsl-deploy-web.sh video-worker cron-worker
#   NO_PULL=1 bash scripts/deploy/wsl-deploy-web.sh             # fără `git pull`
#   MIN_FREE_GB=20 bash scripts/deploy/wsl-deploy-web.sh        # alt prag de spațiu
#   PRUNE=1 bash scripts/deploy/wsl-deploy-web.sh               # curăță build cache întâi
#
# ⚠ ARGUMENTUL E O CAPCANĂ (constatat 2026-08-21):
#   Scriptul a fost refăcut tocmai pentru problema „un serviciu deployat,
#   restul nu". Apoi am reintrodus-o manual: toate deploy-urile din 18-19
#   august au fost rulate cu `web-next` explicit, deși `run.sh` (cron-worker)
#   se schimbase pe 17. Rezultatul — `checkout-health` și `backup-report`
#   au stat 4 zile în `main` fără să ruleze vreodată, exact ca fix-ul ffmpeg
#   din incidentul care a motivat rescrierea.
#
#   Regula, de acum: **nu da argumente decât dacă ești sigur că doar acel
#   serviciu s-a schimbat.** Verificare rapidă înainte de deploy:
#     git diff --name-only <ultimul-deploy>..HEAD | cut -d/ -f1-3 | sort -u
#   Dacă apar `infra/hetzner/cron-worker`, `workers/`, sau `services/`,
#   rulează scriptul FĂRĂ argumente.
#
# EXIT: 0 = toate serviciile atinse au imagine nouă
#       1 = cel puțin un serviciu a rămas pe același hash (deploy incomplet)
#       2 = eroare de configurare/rulare

set -uo pipefail

APP_DIR=${APP_DIR:-/opt/swypik/app}
cd "$APP_DIR" || { echo "EROARE: $APP_DIR inaccesibil" >&2; exit 2; }

COMPOSE=(docker compose
	-f infra/hetzner/docker-compose.prod.yml
	-f infra/hetzner/docker-compose.vps.yml
	-f infra/hetzner/docker-compose.minio.yml
	--env-file infra/hetzner/.env.production)

# Serviciile cu `build:` în compose — singurele care conțin cod din repo și deci
# pot rămâne în urmă la un deploy parțial. Verificat 2026-08-17:
#   web-next      → context /opt/swypik/app          (Next.js: app/, lib/, components/)
#   platform-api  → context services/platform-api    (Go)
#   video-worker  → context workers/video-worker     (Python: transcodare HLS)
#   cron-worker   → context infra/hetzner/cron-worker (run.sh — declanșator de cron)
# Restul sunt imagini externe pinned (postgres, redis, minio) sau
# dezactivate prin `profiles: [disabled]` (caddy, pgbouncer) — nu se reconstruiesc.
CODE_SERVICES=(web-next platform-api video-worker cron-worker)

is_code_service() {
	local s
	for s in "${CODE_SERVICES[@]}"; do [[ "$s" == "$1" ]] && return 0; done
	return 1
}

# --- ce reconstruim -----------------------------------------------------------
if [[ $# -gt 0 ]]; then
	TARGETS=("$@")
	for t in "${TARGETS[@]}"; do
		if ! is_code_service "$t"; then
			echo "EROARE: '$t' nu e un serviciu cu cod de aplicație." >&2
			echo "Disponibile: ${CODE_SERVICES[*]}" >&2
			exit 2
		fi
	done
else
	TARGETS=("${CODE_SERVICES[@]}")
fi

echo "=== deploy: ${TARGETS[*]} ==="

# --- 3.2 git pull + re-exec ---------------------------------------------------
# Scriptul se auto-actualizează prin `git pull`, dar bash citește fișierul o
# singură dată, la pornire. Consecință reală (17 august): prima rulare a
# versiunii noi a executat de fapt versiunea VECHE (`--build web-next`), a
# raportat exit 0 și a lăsat 3 din 4 servicii nereconstruite — exact eroarea pe
# care versiunea nouă fusese scrisă să o prevină.
#
# Fix: după pull, dacă scriptul s-a schimbat, ne re-executăm o singură dată.
# `DEPLOY_REEXEC` previne bucla infinită: a doua instanță nu mai face pull.
if [[ "${NO_PULL:-0}" != "1" && "${DEPLOY_REEXEC:-0}" != "1" ]]; then
	BEFORE_SHA=$(git rev-parse --short HEAD)
	SELF_HASH_BEFORE=$(sha256sum "$0" 2>/dev/null | cut -d' ' -f1)
	# INCIDENT 2026-08-18: `git pull` a eșuat cu "Aborting" (un fișier avea
	# modul schimbat local), scriptul a ignorat codul de ieșire și a
	# reconstruit vesel codul VECHI, raportând succes — hash-ul imaginii chiar
	# se schimbase, deci nici verificarea de la final n-a prins nimic.
	# Un pull eșuat trebuie să oprească deploy-ul, nu să fie o notă în log.
	pull_out=$(git pull --ff-only 2>&1); pull_rc=$?
	echo "$pull_out" | tail -3
	if (( pull_rc != 0 )); then
		echo >&2
		echo "EROARE: 'git pull' a eșuat (cod $pull_rc). OPRESC deploy-ul." >&2
		echo "        Altfel aș reconstrui codul vechi și aș raporta succes." >&2
		echo >&2
		echo "        Stare locală care blochează pull-ul:" >&2
		git status --porcelain >&2
		echo >&2
		echo "        Dacă sunt doar schimbări de mod (100644 <-> 100755) lăsate în" >&2
		echo "        urmă de un chmod manual:  git checkout -- <fișier>" >&2
		exit 2
	fi
	AFTER_SHA=$(git rev-parse --short HEAD)
	SELF_HASH_AFTER=$(sha256sum "$0" 2>/dev/null | cut -d' ' -f1)

	if [[ "$BEFORE_SHA" == "$AFTER_SHA" ]]; then
		echo "NOTĂ: HEAD neschimbat ($AFTER_SHA) — codul era deja la zi sau nu s-a"
		echo "      publicat nimic. Rebuild-ul continuă, dar dacă aștepți cod nou,"
		echo "      verifică întâi că ai dat push."
	else
		echo "git: $BEFORE_SHA -> $AFTER_SHA"
	fi

	if [[ "$SELF_HASH_BEFORE" != "$SELF_HASH_AFTER" ]]; then
		echo ">>> scriptul de deploy s-a actualizat — repornesc cu versiunea nouă"
		export DEPLOY_REEXEC=1
		exec bash "$0" "$@"
	fi
fi

# --- 3.1 verificare spațiu ----------------------------------------------------
# INCIDENT 2026-08-17: discul gazdă s-a umplut în timpul unui rebuild (cache-ul
# BuildKit ajunsese la 64 GB). VHDX-ul WSL nu a mai putut scrie, filesystem-ul
# distro-ului a intrat în `emergency_ro`, daemonul Docker a murit și producția a
# căzut cu 502. În plus, layerele scrise în timpul incidentului au rămas corupte.
# Un build oprit din lipsă de spațiu e recuperabil; unul care umple discul, nu.
MIN_FREE_GB=${MIN_FREE_GB:-10}
DOCKER_ROOT=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
avail_kb=$(df --output=avail -k "$DOCKER_ROOT" 2>/dev/null | tail -1 | tr -d ' ')
if [[ -n "$avail_kb" ]]; then
	avail_gb=$((avail_kb / 1024 / 1024))
	echo "spațiu liber în $DOCKER_ROOT: ${avail_gb} GB (prag ${MIN_FREE_GB} GB)"
	if (( avail_kb < MIN_FREE_GB * 1024 * 1024 )); then
		echo "EROARE: sub ${MIN_FREE_GB} GB liberi — refuz să pornesc build-ul." >&2
		echo "        Eliberează spațiu: docker builder prune -af && docker image prune -f" >&2
		echo "        (build cache actual: $(docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null | grep -i 'build cache' || echo 'necunoscut'))" >&2
		exit 2
	fi
else
	echo "AVERTISMENT: nu pot citi spațiul din $DOCKER_ROOT — continui fără verificare." >&2
fi

# Spațiul de pe gazda Windows: VHDX-ul crește dinamic, deci `df` din WSL poate
# raporta sute de GB liberi în timp ce partiția care găzduiește VHDX-ul e plină.
# Exact asta s-a întâmplat pe 17 august: WSL vedea spațiu, Windows nu mai avea.
#
# Partiția verificată trebuie să fie cea care GĂZDUIEȘTE VHDX-ul. Din 19 august
# distro-ul stă la `E:\wsl\swypik\ext4.vhdx`, nu pe `D:`. Verificarea rămasă pe
# `/mnt/d` ar fi fost mai rea decât lipsa ei: ar fi confirmat 148 GB liberi în
# timp ce partiția care contează se umplea.
HOST_MOUNT=${HOST_MOUNT:-/mnt/e}
host_free_kb=$(df --output=avail -k "$HOST_MOUNT" 2>/dev/null | tail -1 | tr -d ' ')
if [[ -n "$host_free_kb" ]]; then
	host_free_gb=$((host_free_kb / 1024 / 1024))
	echo "spațiu liber pe gazdă (${HOST_MOUNT}, unde stă VHDX-ul): ${host_free_gb} GB"
	if (( host_free_kb < MIN_FREE_GB * 1024 * 1024 )); then
		echo "EROARE: gazda are sub ${MIN_FREE_GB} GB liberi — VHDX-ul nu poate crește." >&2
		echo "        Asta a cauzat incidentul din 17 august (emergency_ro + 502)." >&2
		exit 2
	fi
else
	echo "AVERTISMENT: nu pot citi spațiul din ${HOST_MOUNT} — continui fără verificarea gazdei." >&2
fi

if [[ "${PRUNE:-0}" == "1" ]]; then
	echo "--- curăț build cache (PRUNE=1) ---"
	docker builder prune -af 2>&1 | tail -2
fi

if [[ "${NO_PULL:-0}" == "1" ]]; then
	echo "git pull sărit (NO_PULL=1). HEAD=$(git rev-parse --short HEAD)"
elif [[ "${DEPLOY_REEXEC:-0}" == "1" ]]; then
	echo "(rulare re-executată după actualizarea scriptului; HEAD=$(git rev-parse --short HEAD))"
fi

# --- hash-uri înainte ---------------------------------------------------------
# Un serviciu poate avea mai multe replici (video-worker are 3); ne uităm la
# imaginea containerului, nu la tag — tagul poate rămâne identic peste un build nou.
declare -A IMG_BEFORE
container_for() {
	"${COMPOSE[@]}" ps -q "$1" 2>/dev/null | head -1
}
image_of() {
	local cid="$1"
	[[ -n "$cid" ]] && docker inspect --format='{{.Image}}' "$cid" 2>/dev/null || echo "none"
}

echo
echo "--- imagini ÎNAINTE ---"
for svc in "${TARGETS[@]}"; do
	IMG_BEFORE[$svc]=$(image_of "$(container_for "$svc")")
	printf '  %-14s %s\n' "$svc" "${IMG_BEFORE[$svc]}"
done

# --- metadate de release ------------------------------------------------------
# `/api/health` raporta commit="unknown" fiindcă build args-urile astea nu erau
# populate niciodată. Fără ele, singurul mod de a afla ce versiune rulează era
# `docker inspect` din interiorul WSL — exact ce nu ai la îndemână când canalul
# de comandă e mort. Acum răspunsul e într-un GET public.
export BUILD_COMMIT="$(git rev-parse --short HEAD)"
export BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export DEPLOYED_AT="$BUILD_TIME"
echo
echo "--- metadate release: commit=$BUILD_COMMIT build_time=$BUILD_TIME ---"

# --- 3.3 build SECVENȚIAL -----------------------------------------------------
# Un serviciu pe rând, nu `up -d --build svc1 svc2 svc3`.
# Motiv (17 august): rebuild-ul simultan al celor 4 servicii a produs un vârf de
# consum pe disc (fiecare build își are propriul context + layere intermediare),
# care a umplut partiția gazdă. Secvențial, vârful e ~o pătrime, iar dacă
# spațiul se termină, se oprește la primul serviciu — celelalte rămân intacte.
# În plus, la eșec știm exact CARE serviciu a picat.
echo
echo "--- build + up (secvențial) ---"
BUILD_FAILED=()
for svc in "${TARGETS[@]}"; do
	echo
	echo "  [$svc] build..."
	# Verificăm spațiul înaintea FIECĂRUI serviciu: un build poate consuma
	# zeci de GB, iar pragul putea fi trecut de build-ul precedent.
	free_kb=$(df --output=avail -k "$DOCKER_ROOT" 2>/dev/null | tail -1 | tr -d ' ')
	if [[ -n "$free_kb" ]] && (( free_kb < MIN_FREE_GB * 1024 * 1024 )); then
		echo "  [$svc] OPRIT: spațiu sub ${MIN_FREE_GB} GB după build-urile precedente." >&2
		BUILD_FAILED+=("$svc")
		break
	fi

	out=$("${COMPOSE[@]}" up -d --build "$svc" 2>&1)
	rc=$?
	echo "$out" | tail -8
	if (( rc != 0 )); then
		echo "  [$svc] EȘEC (rc=$rc)" >&2
		BUILD_FAILED+=("$svc")
	fi
done

if (( ${#BUILD_FAILED[@]} > 0 )); then
	echo
	echo ">>> BUILD EȘUAT pentru: ${BUILD_FAILED[*]}" >&2
	echo "    Serviciile de mai sus rulează în continuare imaginea veche." >&2
fi

# --- hash-uri după + verdict --------------------------------------------------
echo
echo "--- imagini DUPĂ ---"
FAILED=()
for svc in "${TARGETS[@]}"; do
	after=$(image_of "$(container_for "$svc")")
	if [[ "$after" == "${IMG_BEFORE[$svc]}" ]]; then
		printf '  %-14s %s  <-- NESCHIMBAT\n' "$svc" "$after"
		FAILED+=("$svc")
	else
		printf '  %-14s %s  (era %s)\n' "$svc" "$after" "${IMG_BEFORE[$svc]:0:19}"
	fi
done

echo
echo "--- stare containere ---"
"${COMPOSE[@]}" ps --format '  {{.Name}}: {{.Status}}' 2>/dev/null || docker ps --format '  {{.Names}}: {{.Status}}'

if [[ ${#FAILED[@]} -gt 0 ]]; then
	echo
	echo ">>> DEPLOY INCOMPLET: hash identic pentru: ${FAILED[*]}"
	echo "    Serviciile de mai sus rulează ACELAȘI cod ca înainte."
	echo "    Cauze uzuale: (a) nu s-a publicat nimic nou (git push lipsă),"
	echo "    (b) build cache — forțează:"
	echo "        ${COMPOSE[*]} build --no-cache ${FAILED[*]}"
	echo "        ${COMPOSE[*]} up -d --force-recreate ${FAILED[*]}"
	exit 1
fi

echo
echo ">>> OK: toate serviciile atinse rulează imagini noi."
