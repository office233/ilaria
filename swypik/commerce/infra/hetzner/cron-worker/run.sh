#!/bin/sh
# Swypik cron-worker (folosit de imaginea cron-worker din infra/azure/compose/web.yml)
#
# Planificare pe termene, nu pe ferestre modulo:
#   - fiecare job are un interval (și un offset opțional); termenul următor e
#     aliniat la ceas: k*interval + offset. Un job e pornit când now >= termen,
#     deci o iterație întârziată NU mai sare rularea (vechiul `TICK % N < 60`
#     rata ferestrele de 2h/zilnice când bucla depășea 60s);
#   - fiecare job rulează ÎN FUNDAL, cu lock propriu (director /tmp/cron-lock.<job>):
#     un job lent (news-pipeline, embed-batch) nu mai întârzie celelalte, iar
#     același job nu pornește de două ori în paralel (se sare + log SKIP busy);
#   - ieșirea fiecărui job în fișiere proprii (/tmp/cron.<job>.out|err);
#   - heartbeat la fiecare iterație + timestamp de ultim succes per job
#     (healthcheck-ul containerului verifică bucla).
# Fără `set -e`: un job eșuat nu oprește workerul.
set -u

HEARTBEAT=/tmp/cron-heartbeat
LASTOK_PREFIX=/tmp/cron-last-success
STATE_DIR="${CRON_STATE_DIR:-/tmp}"
LOOP_SLEEP="${CRON_LOOP_SLEEP:-15}"
# Orice replică web poate executa jobul: fiecare rută de cron ia un advisory
# lock în Postgres (lib/cron/lock.ts), deci un al doilea cron-worker pornit din
# greșeală (sau un retry) produce doar „200 skipped”, nu dublă execuție.
WEB="${CRON_TARGET_URL:-http://web-next:3000}"

# Jobs: nume|metodă|interval_secunde|offset_secunde|timeout_curl_secunde
# Offset-ul e față de epoch (joi 00:00 UTC): zilnic 0 = 00:00 UTC; săptămânal
# 378000 = luni 09:00 UTC (4 zile + 9 ore). CRON_JOBS suprascrie lista (doar teste).
DEFAULT_JOBS="
refresh-rank|POST|60|0|120
seller-integration-sync|POST|60|0|120
dispatch-tick|POST|60|0|55
food-orders-watchdog|POST|60|0|55
live-sweep|POST|60|0|55
publish-scheduled|POST|300|0|240
stays-lifecycle|POST|300|0|240
watchdog-videos|POST|600|0|300
watchdog-rides|POST|600|0|300
prewarm-catalogs|POST|900|0|600
embed-batch|POST|900|0|600
classify-pending|POST|900|0|600
process-payouts|POST|1800|0|600
refresh-fx|GET|3600|0|300
alert-video-queue|GET|3600|0|300
aggregate-video-stats|POST|3600|0|600
fly-price-watch|GET|3600|0|600
checkout-health|GET|3600|0|300
missions-expire|POST|3600|0|600
news-pipeline|POST|7200|0|1800
abandoned-cart|POST|14400|0|600
backup-report|GET|14400|0|300
email-digest|POST|604800|378000|1800
suspend-unverified|GET|86400|0|600
strikes-decay|POST|86400|0|600
cleanup-tokens|GET|86400|0|600
alert-dispute-deadlines|GET|86400|0|600
reconcile-wallets|POST|86400|0|1200
indexnow|GET|86400|0|600
bing-url-submit|GET|86400|0|600
"
JOBS="${CRON_JOBS:-${DEFAULT_JOBS}}"

# Următorul termen strict după `now`: k*interval + offset.
next_due() {
  interval="$1"; offset="$2"; now="$3"
  echo $(( ((now - offset) / interval + 1) * interval + offset ))
}

run_job() {
  job="$1"; method="$2"; max_time="$3"
  url="${WEB}/api/cron/${job}"
  out="${STATE_DIR}/cron.${job}.out"
  err="${STATE_DIR}/cron.${job}.err"
  started=$(date +%s)
  echo "[cron] $(date -Iseconds) → ${job} (${method})"

  http_code=$(curl -sS -m "${max_time}" -o "${out}" -w '%{http_code}' \
    -X "${method}" \
    -H "Authorization: Bearer ${CRON_SECRET:-}" \
    "${url}" 2>"${err}")
  curl_rc=$?
  took=$(( $(date +%s) - started ))

  if [ "${curl_rc}" -ne 0 ]; then
    echo "[cron] ${job} TRANSPORT_FAIL rc=${curl_rc} took=${took}s err=$(head -c 300 "${err}" 2>/dev/null)"
    return 1
  fi
  case "${http_code}" in
    2*)
      echo "[cron] ${job} OK status=${http_code} took=${took}s"
      date +%s > "${LASTOK_PREFIX}.${job}"
      return 0
      ;;
    410)
      # Feature înghețat intenționat — SKIP, nu FAIL.
      echo "[cron] ${job} SKIP status=410 (feature_frozen)"
      date +%s > "${LASTOK_PREFIX}.${job}"
      return 0
      ;;
    *)
      echo "[cron] ${job} FAIL status=${http_code} took=${took}s body=$(head -c 500 "${out}" 2>/dev/null | tr -d '\n')"
      return 1
      ;;
  esac
}

# Lock per job: mkdir e atomic. Un lock rămas de la un proces mort (pid
# inexistent) e curățat.
acquire_lock() {
  lock="${STATE_DIR}/cron-lock.$1"
  if mkdir "${lock}" 2>/dev/null; then return 0; fi
  pid=$(cat "${lock}/pid" 2>/dev/null || echo "")
  if [ -n "${pid}" ] && ! kill -0 "${pid}" 2>/dev/null; then
    rm -rf "${lock}"
    mkdir "${lock}" 2>/dev/null && return 0
  fi
  return 1
}

start_job() {
  job="$1"; method="$2"; max_time="$3"
  if ! acquire_lock "${job}"; then
    echo "[cron] ${job} SKIP busy (rularea anterioară încă merge)"
    return 0
  fi
  (
    lock="${STATE_DIR}/cron-lock.${job}"
    echo "$(sh -c 'echo $PPID')" > "${lock}/pid"
    run_job "${job}" "${method}" "${max_time}"
    rm -rf "${lock}"
  ) &
}

# Un pas al planificatorului: pornește joburile scadente, calculează termenele noi.
# Bucla citește din here-doc (NU din pipe), ca să ruleze în shell-ul curent:
# joburile pornite în fundal rămân copiii lui și sunt culese de `jobs`.
schedule_tick() {
  tick_now="$1"
  while IFS='|' read -r s_job s_method s_interval s_offset s_max; do
    [ -z "${s_job}" ] && continue
    due_file="${STATE_DIR}/cron-due.${s_job}"
    due=$(cat "${due_file}" 2>/dev/null || echo "")
    if [ -z "${due}" ]; then
      # Prima pornire: nu rulăm totul la fiecare deploy — așteptăm primul termen.
      next_due "${s_interval}" "${s_offset}" "${tick_now}" > "${due_file}"
      continue
    fi
    if [ "${tick_now}" -ge "${due}" ]; then
      start_job "${s_job}" "${s_method}" "${s_max}"
      next_due "${s_interval}" "${s_offset}" "${tick_now}" > "${due_file}"
    fi
  done <<EOF
${JOBS}
EOF
  # Culege joburile de fundal terminate (fără zombi când shell-ul e PID 1).
  jobs > /dev/null 2>&1
}

# Doar funcțiile (teste): CRON_LIB_ONLY=1 . run.sh
if [ "${CRON_LIB_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

echo "🕐 Swypik cron-worker started (pid=$$)"
rm -rf "${STATE_DIR}"/cron-lock.* 2>/dev/null

while true; do
  TICK=$(date +%s)
  echo "${TICK}" > "${HEARTBEAT}"
  schedule_tick "${TICK}"
  sleep "${LOOP_SLEEP}"
done
