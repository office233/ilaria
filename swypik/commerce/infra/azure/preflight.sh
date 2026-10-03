#!/usr/bin/env bash
# Swypik — validează fișierele env ÎNAINTE de deploy/cutover. Nu afișează
# NICIODATĂ valori: doar numele cheilor și motivul (lipsă/gol/format/nepotrivire).
#
#   preflight.sh --env /opt/swypik/env/swypik.env \
#     [--data-env /opt/swypik/env/data.env] \
#     [--topology multi|single] [--scan [--app DIR]]
#
#   --topology multi (implicit): Postgres/Redis pe nodul data → DATABASE_URL /
#              REDIS_URL NU pot indica localhost/"postgres"/"redis", Redis cu parolă.
#   --scan     listează și cheile citite în cod (process.env / os.environ /
#              os.Getenv) care lipsesc din env (informativ; multe au default-uri).
# Ieșire: 0 = OK (eventual cu avertismente), 1 = erori.
set -uo pipefail

ENV_FILE=""; DATA_ENV=""; TOPOLOGY=multi; SCAN=0
APP_DIR=$(cd "$(dirname "$0")/../.." && pwd)
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE=$2; shift 2 ;;
    --data-env) DATA_ENV=$2; shift 2 ;;
    --topology) TOPOLOGY=$2; shift 2 ;;
    --scan) SCAN=1; shift ;;
    --app) APP_DIR=$2; shift 2 ;;
    *) echo "argument necunoscut: $1"; exit 2 ;;
  esac
done
[ -n "$ENV_FILE" ] || { echo "folosire: $0 --env FIȘIER [...]"; exit 2; }

ERRORS=0; WARNS=0
err()  { printf '  ERR   %-40s %s\n' "$1" "$2"; ERRORS=$((ERRORS + 1)); }
warn() { printf '  WARN  %-40s %s\n' "$1" "$2"; WARNS=$((WARNS + 1)); }
ok()   { printf '  ok    %s\n' "$1"; }

declare -A S D   # swypik / data

load() { # FIȘIER NUME_TABLOU — parsare fără `source` (nu execută nimic din fișier)
  local f=$1; local -n arr=$2; local line k v n=0
  [ -f "$f" ] || { err "$f" "fișierul nu există"; return 1; }
  if grep -q $'\r' "$f"; then err "$f" "are terminații CRLF (valorile ar conține \\r) — rulează dos2unix"; fi
  local mode; mode=$(stat -c '%a' "$f" 2>/dev/null || echo "?")
  case "$mode" in 600|400) ;; *) warn "$f" "permisiuni $mode (recomandat 600)";; esac
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    k=${BASH_REMATCH[2]}; v=${BASH_REMATCH[3]}
    if [[ "$v" =~ ^\"(.*)\"$ ]] || [[ "$v" =~ ^\'(.*)\'$ ]]; then v=${BASH_REMATCH[1]}; fi
    [ -n "${arr[$k]+x}" ] && warn "$k" "definită de mai multe ori în $(basename "$f") (câștigă ultima)"
    arr[$k]=$v; n=$((n + 1))
  done < "$f"
  echo "  $(basename "$f"): $n chei"
}

has() { local -n a=$1; [ -n "${a[$2]:-}" ]; }
is_placeholder() { [[ "${1,,}" =~ placeholder|changeme|\<owner: ]]; }
need() { # TABLOU CHEIE [motiv]
  local -n a=$1
  if [ -z "${a[$2]+x}" ]; then err "$2" "lipsește${3:+ ($3)}"
  elif [ -z "${a[$2]}" ]; then err "$2" "e goală${3:+ ($3)}"
  elif is_placeholder "${a[$2]}"; then err "$2" "conține un placeholder${3:+ ($3)}"; fi
}
one_of() { # TABLOU ETICHETĂ CHEI...
  local t=$1 label=$2; shift 2; local k
  local -n values=$t
  for k in "$@"; do has "$t" "$k" && ! is_placeholder "${values[$k]}" && return 0; done
  err "$label" "lipsește sau conține placeholder (oricare dintre: $*)"
}
first_of() { local t=$1; shift; local -n a=$t; local k; for k in "$@"; do [ -n "${a[$k]:-}" ] && { printf '%s' "${a[$k]}"; return; }; done; }
min_len() { local -n a=$1; [ -z "${a[$2]:-}" ] || [ "${#a[$2]}" -ge "$3" ] || warn "$2" "mai scurtă de $3 caractere"; }
truthy() { case "${1,,}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }
urldecode() { local s=${1//+/ }; printf '%b' "${s//%/\\x}"; }

# URL → globale U_USER U_PASS U_HOST U_PORT U_DB (nu se afișează)
parse_url() {
  U_USER=""; U_PASS=""; U_HOST=""; U_PORT=""; U_DB=""
  [[ "$1" =~ ^[a-z]+://(([^:@/]*)(:([^@]*))?@)?([^:/?]+)(:([0-9]+))?(/([^?]*))? ]] || return 1
  U_USER=$(urldecode "${BASH_REMATCH[2]}"); U_PASS=$(urldecode "${BASH_REMATCH[4]}")
  U_HOST=${BASH_REMATCH[5]}; U_PORT=${BASH_REMATCH[7]}; U_DB=${BASH_REMATCH[9]}
}
is_local_host() { case "$1" in localhost|127.*|::1|postgres|redis|host.docker.internal) return 0 ;; *) return 1 ;; esac; }

echo "== swypik.env =="
load "$ENV_FILE" S || { echo "REZULTAT: $ERRORS erori"; exit 1; }

# Obligatorii (derivate din cod: lib/db.ts, lib/redis.ts, lib/auth/totp.ts,
# lib/media/stream-secret.ts, lib/feed/events.ts,
# lib/social/proxy.ts, lib/stripe, lib/email/transport.ts, cron-worker/run.sh).
for k in DATABASE_URL REDIS_URL NEXT_PUBLIC_APP_URL APP_ENCRYPTION_KEY CRON_SECRET ADMIN_SECRET \
         PLATFORM_API_SECRET FEED_EVENT_IP_SALT EMAIL_FROM; do
  need S "$k"
done
# PROVIZORIU (decizia proprietarului, 2026-09-28): producția rulează fără plăți și email
# până se pun cheile reale. Cu PROVISIONAL_NO_PAYMENTS_EMAIL=1 în swypik.env, cheile
# Stripe/Resend lipsă sau placeholder sunt AVERTISMENTE, nu erori. Scoate cheia când pui
# cheile reale — verificarea redevine strictă.
if [ "${S[PROVISIONAL_NO_PAYMENTS_EMAIL]:-}" = "1" ]; then
  for k in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY RESEND_API_KEY; do
    if ! has S "$k" || is_placeholder "${S[$k]}"; then warn "$k" "PROVIZORIU: lipsă/placeholder — plățile/emailul NU funcționează"; fi
  done
else
  for k in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY; do need S "$k"; done
  one_of S "EMAIL (transport)" RESEND_API_KEY SMTP_HOST
fi
one_of S "STORAGE endpoint (R2)" S3_ENDPOINT S3_ENDPOINT_URL R2_ENDPOINT_URL R2_ENDPOINT
one_of S "STORAGE access key" S3_ACCESS_KEY S3_ACCESS_KEY_ID AWS_ACCESS_KEY_ID R2_ACCESS_KEY_ID
one_of S "STORAGE secret key" S3_SECRET_KEY S3_SECRET_ACCESS_KEY AWS_SECRET_ACCESS_KEY R2_SECRET_ACCESS_KEY
one_of S "STORAGE bucket" S3_BUCKET S3_MEDIA_BUCKET R2_BUCKET
one_of S "STORAGE URL public (CDN)" S3_PUBLIC_URL S3_PUBLIC_BASE_URL R2_PUBLIC_URL R2_PUBLIC_BASE_URL
# AI = Azure AI Foundry (EU Data Zone): chat, Whisper (subtitrări), Content Safety (moderare).
# Fără ele aplicația merge, dar fără AI: moderarea rămâne doar euristică, știrile și subtitrările se opresc.
for k in AZURE_OPENAI_ENDPOINT AZURE_OPENAI_API_KEY AZURE_OPENAI_CHAT_DEPLOYMENT AZURE_OPENAI_WHISPER_DEPLOYMENT \
         AZURE_CONTENT_SAFETY_ENDPOINT AZURE_CONTENT_SAFETY_KEY; do
  need S "$k" "Azure AI"
done
if has S AZURE_OPENAI_ENDPOINT && [[ ! "${S[AZURE_OPENAI_ENDPOINT]}" =~ ^https://[a-z0-9-]+\.openai\.azure\.com/?$ ]]; then
  err AZURE_OPENAI_ENDPOINT "format neașteptat (https://<resursă>.openai.azure.com)"
fi
has S AZURE_CONTENT_SAFETY_ENDPOINT && [[ "${S[AZURE_CONTENT_SAFETY_ENDPOINT]}" != https://* ]] && err AZURE_CONTENT_SAFETY_ENDPOINT "trebuie https://"
has S AZURE_OPENAI_EMBEDDING_DEPLOYMENT || warn AZURE_OPENAI_EMBEDDING_DEPLOYMENT "lipsește — căutarea semantică (pgvector) e oprită"
for k in SENTRY_DSN OPS_ALERT_EMAIL; do
  has S "$k" || warn "$k" "lipsește (recomandat)"
done

# Formate
if has S APP_ENCRYPTION_KEY && ! [[ "${S[APP_ENCRYPTION_KEY]}" =~ ^[0-9a-fA-F]{64}$ ]]; then
  err APP_ENCRYPTION_KEY "trebuie să fie 32 bytes hex (64 caractere; openssl rand -hex 32)"
fi
for k in CRON_SECRET ADMIN_SECRET PLATFORM_API_SECRET FEED_EVENT_IP_SALT; do min_len S "$k" 32; done
has S NEXT_PUBLIC_APP_URL && [[ "${S[NEXT_PUBLIC_APP_URL]}" != https://* ]] && err NEXT_PUBLIC_APP_URL "trebuie https://"
has S STRIPE_SECRET_KEY && [[ ! "${S[STRIPE_SECRET_KEY]}" =~ ^(sk|rk)_live_ ]] && warn STRIPE_SECRET_KEY "nu e cheie live (sk_live_/rk_live_)"
has S NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY && [[ "${S[NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY]}" != pk_live_* ]] && warn NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY "nu e cheie live (pk_live_)"
has S STRIPE_WEBHOOK_SECRET && [[ "${S[STRIPE_WEBHOOK_SECRET]}" != whsec_* ]] && err STRIPE_WEBHOOK_SECRET "format neașteptat (whsec_)"

# Topologie: Postgres/Redis pe nodul data
if parse_url "${S[DATABASE_URL]:-}"; then
  if [ "$TOPOLOGY" = multi ] && is_local_host "$U_HOST"; then err DATABASE_URL "host local/„postgres” — pe multi-nod trebuie IP-ul privat al nodului data"; fi
  [ -z "$U_PASS" ] && err DATABASE_URL "fără parolă"
  DB_USER=$U_USER; DB_PASS=$U_PASS; DB_HOST=$U_HOST; DB_NAME=$U_DB
elif has S DATABASE_URL; then err DATABASE_URL "URL invalid (postgres://user:parolă@host:port/db)"; fi
if parse_url "${S[REDIS_URL]:-}"; then
  if [ "$TOPOLOGY" = multi ]; then
    is_local_host "$U_HOST" && err REDIS_URL "host local/„redis” — pe multi-nod trebuie IP-ul nodului data"
    [ -z "$U_PASS" ] && err REDIS_URL "fără parolă (Redis e expus pe rețeaua privată → requirepass)"
  fi
  RD_PASS=$U_PASS; RD_HOST=$U_HOST
elif has S REDIS_URL; then err REDIS_URL "URL invalid (redis://:parolă@host:6379/0)"; fi
for k in SOCIAL_API_URL GO_API_URL; do
  if has S "$k" && [[ "${S[$k]}" =~ (localhost|127\.0\.0\.1) ]]; then warn "$k" "indică localhost — în container folosește http://platform-api:8080"; fi
done

# MinIO a dispărut: storage-ul trebuie să fie R2
ep=$(first_of S S3_ENDPOINT S3_ENDPOINT_URL R2_ENDPOINT_URL R2_ENDPOINT)
if [ -n "$ep" ]; then
  if [[ "$ep" =~ (minio|localhost|127\.0\.0\.1|:9000) ]]; then
    if [ "${S[STORAGE_INTERIM_MINIO]:-}" = "1" ]; then warn "STORAGE endpoint" "MinIO TEMPORAR (STORAGE_INTERIM_MINIO=1) — treci pe R2 după deblocare"
    else err "STORAGE endpoint" "indică MinIO/local — pe Azure media e pe Cloudflare R2 (sau STORAGE_INTERIM_MINIO=1 temporar)"; fi
  elif [[ "$ep" != *r2.cloudflarestorage.com* ]]; then warn "STORAGE endpoint" "nu pare Cloudflare R2 (*.r2.cloudflarestorage.com)"; fi
fi
pub=$(first_of S S3_PUBLIC_URL S3_PUBLIC_BASE_URL R2_PUBLIC_URL R2_PUBLIC_BASE_URL)
[ -n "$pub" ] && [[ "$pub" =~ (minio|localhost|:9000|cdn\.swypik\.com/minio) ]] && [ "${S[STORAGE_INTERIM_MINIO]:-}" != "1" ] && err "STORAGE URL public" "indică MinIO"

# Coada video: web și worker trebuie să vorbească același stream
q1=${S[REDIS_STREAM_VIDEO_JOBS]:-}; q2=${S[VIDEO_QUEUE_NAME]:-}
[ -n "$q1" ] && [ -n "$q2" ] && [ "$q1" != "$q2" ] && err VIDEO_QUEUE_NAME "diferă de REDIS_STREAM_VIDEO_JOBS (producătorul și worker-ele ar folosi cozi diferite)"

# Flag-uri: perechile build-time trebuie identice; dependențe
for m in MOVIES MUSIC NEWS GAMING MESSENGER DM CARES VIRAL_CATALOG; do
  a=${S[FEATURE_$m]:-0}; b=${S[NEXT_PUBLIC_FEATURE_$m]:-0}
  if { truthy "$a" && ! truthy "$b"; } || { ! truthy "$a" && truthy "$b"; }; then
    err "FEATURE_$m" "diferă de NEXT_PUBLIC_FEATURE_$m (ambele se coc la build)"
  fi
done
if truthy "${S[FEATURE_NEWS]:-0}"; then one_of S "NEWS AI deployment (FEATURE_NEWS)" NEWS_AI_DEPLOYMENT AZURE_OPENAI_CHAT_DEPLOYMENT; fi
if truthy "${S[FEATURE_MESSENGER]:-0}"; then
  for k in LIVEKIT_API_KEY LIVEKIT_API_SECRET LIVEKIT_URL NEXT_PUBLIC_LIVEKIT_URL; do has S "$k" || warn "$k" "FEATURE_MESSENGER e pornit (apelurile se mută pe Cloudflare Realtime)"; done
fi
truthy "${S[FEATURE_MUSIC]:-0}" && ! has S JAMENDO_CLIENT_ID && warn JAMENDO_CLIENT_ID "FEATURE_MUSIC pornit fără catalog Jamendo"
truthy "${S[FEATURE_CARES]:-0}" && warn FEATURE_CARES "pornit — decizia owner: OFF până există partener ONG"

# Chei eliminate (crypto/SWYP, YouTube/TMDB, Mystery Drop, MinIO, Multi-ERP) — de scos
for k in "${!S[@]}"; do
  if [[ "$k" =~ (SWYP|CHAIN|TREASURY|_PK$|RPC_URL|COINGECKO|MYSTERY|YOUTUBE|TMDB|MINIO_) ]]; then warn "$k" "cheie a unei funcții eliminate — scoate-o"; fi
  # Furnizori AI înlocuiți de Azure AI Foundry (STUDIAI_* rămâne doar pentru scripts/data, nu runtime).
  if [[ "$k" =~ ^(GEMINI_|NEWS_GEMINI_|GITHUB_MODELS|OPENROUTER_|ORCHESTRATOR_MODEL|MODERATION_(TEXT_)?MODEL|TRANSLATE_MODEL|STUDIAI_) ]]; then
    warn "$k" "furnizor AI vechi — runtime-ul folosește doar AZURE_* (scoate-o)"
  fi
  # Multi-ERP retras 2026-09-28 (API-urile /api/internal și /api/partner nu mai există).
  if [[ "$k" =~ ^(MULTI_ERP_|SELENA_|INTERNAL_SECRET$|PARTNER_PROVISION_SECRET$) ]]; then
    warn "$k" "Multi-ERP retras — cheia nu mai e folosită (scoate-o)"
  fi
done

if [ -n "$DATA_ENV" ]; then
  echo "== data.env =="
  if load "$DATA_ENV" D; then
    for k in DATA_BIND_IP POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD REDIS_PASSWORD; do need D "$k"; done
    min_len D REDIS_PASSWORD 32; min_len D POSTGRES_PASSWORD 24
    [ -n "${DB_HOST:-}" ] && [ "${D[DATA_BIND_IP]:-}" != "$DB_HOST" ] && err DATABASE_URL "host ≠ DATA_BIND_IP din data.env"
    [ -n "${DB_USER:-}" ] && [ "${D[POSTGRES_USER]:-}" != "$DB_USER" ] && err DATABASE_URL "user ≠ POSTGRES_USER"
    [ -n "${DB_NAME:-}" ] && [ "${D[POSTGRES_DB]:-}" != "$DB_NAME" ] && err DATABASE_URL "baza ≠ POSTGRES_DB"
    [ -n "${DB_PASS:-}" ] && [ "${D[POSTGRES_PASSWORD]:-}" != "$DB_PASS" ] && err DATABASE_URL "parola ≠ POSTGRES_PASSWORD (atenție la URL-encoding)"
    [ -n "${RD_HOST:-}" ] && [ "${D[DATA_BIND_IP]:-}" != "$RD_HOST" ] && err REDIS_URL "host ≠ DATA_BIND_IP"
    [ -n "${RD_PASS:-}" ] && [ "${D[REDIS_PASSWORD]:-}" != "$RD_PASS" ] && err REDIS_URL "parola ≠ REDIS_PASSWORD"
  fi
fi

if [ "$SCAN" = 1 ]; then
  echo "== scan cod ($APP_DIR): chei citite în cod, absente din env =="
  skip='^(NODE_ENV|PORT|HOSTNAME|BUILD_COMMIT|BUILD_TIME|DEPLOYED_AT|GIT_COMMIT|NEXT_BUILD_STANDALONE|NEXT_DIST_DIR|PINO_PRETTY|ENVIRONMENT|HOST|CI|VITEST|NEXT_RUNTIME|NEXT_PHASE)$'
  mapfile -t names < <(
    { grep -rhoE "process\.env\.[A-Z][A-Z0-9_]+" "$APP_DIR"/{app,lib,components} "$APP_DIR"/middleware.ts "$APP_DIR"/instrumentation*.ts 2>/dev/null | sed 's/.*\.//'
      grep -rhoE "os\.(environ\.get|getenv)\(['\"][A-Z][A-Z0-9_]+|values\.get\(['\"][A-Z][A-Z0-9_]+" "$APP_DIR/workers" --include=*.py 2>/dev/null | sed -E "s/.*['\"]//"
      grep -rhoE "Getenv\(\"[A-Z][A-Z0-9_]+" "$APP_DIR/services/platform-api" --include=*.go 2>/dev/null | sed 's/.*"//'
    } | sort -u | grep -vE "$skip")
  missing=()
  for k in "${names[@]}"; do [ -n "${S[$k]+x}" ] || missing+=("$k"); done
  echo "  $((${#names[@]})) chei în cod, ${#missing[@]} absente (au default sau țin de module oprite):"
  printf '%s\n' "${missing[@]}" | column -c 110 2>/dev/null | sed 's/^/    /' || printf '    %s\n' "${missing[@]}"
fi

echo
if [ "$ERRORS" -gt 0 ]; then echo "REZULTAT: $ERRORS erori, $WARNS avertismente — NU continua"; exit 1; fi
echo "REZULTAT: OK ($WARNS avertismente)"
