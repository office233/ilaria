# Replici web fără stare — checklist (w5-stateless, 2026-09-27)

Țintă: sute de mii de utilizatori → **N replici identice** `web-next` (mai multe VM-uri, în spatele
replicilor Cloudflare Tunnel, **fără sticky sessions**), **Postgres + Redis pe un server separat**,
**workeri video scalabili independent** pe coadă, totul în Docker (portabil Azure ↔ Hetzner).

Regula: o cerere poate ajunge pe **orice** replică; tot ce trebuie să supraviețuiască cererii stă în
Postgres (sursa de adevăr), Redis (partajat, efemer) sau R2 (fișiere). Memoria și discul unei replici
sunt doar cache/scratch.

## 1. Stare în proces

| Constatare | Fix |
|---|---|
| SSE (DM, dispatch, cursă): **o conexiune Redis per client** (`createSubscriber()` în fiecare stream) — 10k clienți = 10k conexiuni Redis per replică | `lib/realtime/hub.ts`: **un singur abonat Redis per replică**, SUBSCRIBE la primul ascultător al unui canal, UNSUBSCRIBE la ultimul, fan-out local. `lib/realtime/sse.ts` = răspuns SSE comun (heartbeat, abort, snapshot, oprire). Rute refăcute: `api/dm/stream/[id]`, `api/dispatch/[jobId]/stream`, `api/rides/[id]/stream` |
| Fan-out între replici | Verificat: toți publisherii fac `PUBLISH` în Redis — `lib/dm/repository.ts` (`dm:conv:<id>`), `lib/dispatch/engine.ts#publishJobEvent` (`dispatch:job:<id>`, folosit de couriers/status, rides, food, admin-ops). Abonații trec prin hub → un client pe replica A primește evenimentul publicat pe B (test: `tests/unit/realtime-hub.test.ts`). La conectare, fiecare stream trimite un **snapshot din DB**, deci reconectarea pe altă replică nu pierde starea |
| Chat live: polling DB la 1,5 s **per spectator** (10k spectatori ≈ 6.700 SELECT/s) | `lib/live/chat-stream.ts`: POST inserează + `PUBLISH live:chat:<id>`; SSE = abonare prin hub + catch-up din DB după `Last-Event-ID`; dedup pe id (set mărginit, mesajele sosite în ordine inversă de la două replici nu se pierd); polling DB doar cât abonarea Redis nu e sănătoasă (`LIVE_CHAT_FALLBACK_POLL_MS`, 15 s) |
| Notificări, statusuri comenzi, live status | Polling HTTP stateless (fără stare în proces) — OK |
| `lib/fly/repricing.ts`: invalidare `cache = null` doar pe replica care scrie (celelalte: până la 5 min vechi) | `lib/cache/invalidation.ts`: `broadcastCacheInvalidate()` golește local + `PUBLISH cache:invalidate`; fiecare replică rulează handlerele. Fără Redis → TTL |
| `api/search/suggest`: `Map` nemărginit (scurgere de memorie per replică) | Mărginit la 1000 intrări; rămâne cache per replică (date publice, TTL 5 min) — acceptabil |
| `lib/security/rate-limit.ts`: fallback în memorie + `setInterval` la încărcarea modulului | În producție fără Redis limitarea **eșuează închis** (deja) → memoria e doar pentru dev; timerul are `unref()` |
| `lib/rate-limit.ts#idempotencyClaim` fail-open fără Redis | Documentat: fără Redis, protecția la dublă execuție rămâne pe constrângerile DB (chei unice/`ON CONFLICT`) ale fiecărui flux |
| `lib/fly/service.ts` fallback ofertă în memorie | Ofertele sunt date autoritare generate de server (nu starea utilizatorului); cu Redis căzut, checkout-ul pe altă replică dă „ofertă expirată” (sigur). Acceptat |
| Cache-uri mici cu TTL (per replică): `lib/algo/scoring.ts` 60 s, `lib/feed/config.ts` 60 s, `lib/feed/slots.ts` 60 s, `lib/ai/orchestrator.ts` categorii, `lib/fx/*`, `lib/i18n/fx.ts`, `lib/audio/*` trending, `api/seller/products/classify` taxonomie, `lib/payments/platform-account.ts` | Acceptabile: config citit din DB, consistență eventuală ≤ TTL, fără invalidare explicită. Singletons de client (pg Pool, ioredis, S3, Stripe, email) nu țin date de utilizator |
| `lib/ai/github-models-tokens.ts`: tokenuri de sesiune Copilot în memorie + fișier în `tmpdir()` | Cache per replică de tokenuri cu TTL ~30 min; fiecare replică își face propriul schimb — acceptabil, nimic durabil |
| Sesiuni / auth | Confirmat: `user_sessions`/`seller_sessions`/sesiuni admin în Postgres (token SHA-256 în cookie), OAuth state în cookie, CSP nonce per cerere, CSRF = verificare Origin (fără token server-side). Nimic în memorie |

## 2. Cache-ul Next.js între replici

| Constatare | Fix |
|---|---|
| ISR (`revalidate` pe `/[locale]`, `/discover`, sitemaps, `feed.xml`, `api/fx`), `unstable_cache` (`lib/home/product-sections.ts`), `revalidatePath` (admin marketplace/sellers) — pe disc + LRU în memorie per replică: o invalidare atinge doar replica care a servit cererea | `lib/next-cache/redis-cache-handler.cjs` + `store.cjs`, configurat în `next.config.mjs` (`cacheHandler`, `cacheMaxMemorySize: 0`). Intrări în Redis cu prefix pe `BUILD_ID`; `revalidateTag`/`revalidatePath` = hash de timestamp-uri pe tag (tagurile explicite, `x-next-cache-tags` și soft tags implicite ale căii). Redis jos/lent → LRU în memorie per replică (timeout 500 ms, circuit breaker 30 s); memoria se umple doar cât Redis e jos, ca să nu servească intrări invalidate între timp. `NEXT_CACHE_HANDLER=off` = comportamentul vechi |
| BUILD_ID aleator per build | `generateBuildId` = `BUILD_COMMIT` + hash-ul variabilelor coapte în bundle (`NEXT_PUBLIC_*`, `FEATURE_*`), deci același commit reconstruit cu alte flag-uri primește alt id. `BUILD_COMMIT` e acum `ARG` și în stadiul de build al imaginii. **Construiește imaginea o singură dată și rulează aceeași imagine pe toate VM-urile** |
| `/_next/static` | Deja `Cache-Control: public, max-age=31536000, immutable` (+ `CDN-Cache-Control`) — Cloudflare le cache-uiește. Notă: regula pe extensii (`/:path*.png` etc.) marchează `immutable` și fișiere din `public/` fără hash — de revizuit separat |
| Optimizarea de imagini (`/_next/image`) | Cache pe disc per replică (`.next/cache/images`) — acceptabil (regenerabil); Cloudflare cache-uiește răspunsurile |

## 3. Scrieri pe discul local

| Constatare | Fix |
|---|---|
| Upload-uri (avatar, imagini, video, dispute) | Merg în R2 (presigned / S3 client) — nimic pe disc |
| Loguri | `lib/logger.ts` → stdout (colectat de Docker) |
| Sitemaps / feed.xml | Route handlers cu `revalidate` → prin cache handler-ul partajat |
| Tokenuri Copilot în `tmpdir()` | Cache, vezi §1 |
| Worker video | `/tmp/video-processing` = scratch per job (șters la final); rezultatele în R2 |
| cron-worker | `/tmp/cron-heartbeat` + marcaje per job — locale containerului, doar pentru healthcheck |

## 4. Cron / bucle de fundal — exact-once

| Constatare | Fix |
|---|---|
| Rute de cron **fără** lock: `refresh-rank`, `strikes-decay`, `dispatch-tick`, `news-pipeline` (comentariul din `run.sh` pretindea un advisory lock inexistent), `daily-maintenance`, `indexnow`, `indexnow-submit`, `bing-url-submit` | `lib/cron/lock.ts`: `withAdvisoryLock` / `withCronLock` (`pg_try_advisory_xact_lock`, neblocant, eliberat la COMMIT/ROLLBACK sau moartea conexiunii). A doua rulare concurentă → **200 `{skipped:true}`** (cron-worker nu alertează). Autentificarea se face ÎNAINTE de lock. `runCron` (audit în `cron_runs`) refolosește același helper |
| Restul rutelor de cron | Aveau deja `runCron` (advisory lock + audit) |
| `dispatch-worker.mjs` (systemd `swypik-dispatch`) — o buclă de 10 s; două instanțe ar avansa valurile de două ori | `dispatch-tick` rulează sub `withCronLock("dispatch-tick")` = singleton global (leader per tick). Serviciu compose `dispatch-worker` (profil `dispatch`) ca înlocuitor Docker al unității systemd; rularea dublă e inofensivă |
| `cron-worker` țintea fix `http://web-next:3000` | `CRON_TARGET_URL` (URL-ul intern load-balansat); rulează **un** cron-worker, oriunde — un al doilea produce doar „skipped” |
| `daily-maintenance` apelează sub-joburi prin `CRON_INTERNAL_BASE` | Sub-joburile au propriul `runCron` |
| `setInterval` în procesele web | Doar heartbeat-urile SSE (per conexiune, curățate la închidere) și sweep-ul rate-limit din dev (`unref`) |

## 5. Coada de procesare video

**Înainte:** rândul `video_processing_jobs` (Postgres) + mesaj în Redis Stream `video:jobs` (XADD din
Next și din Go) → dual-write: job `queued` fără mesaj când XADD cădea (503 la upload), watchdog care
re-publica după 30 min, `try_claim` ca să nu se proceseze de două ori, reîncercări doar inline (același
worker), Redis cu `allkeys-lru` putea evacua streamul.

**Decizie: Postgres `FOR UPDATE SKIP LOCKED`** (nu Redis Streams): jobul e deja un rând durabil, inserat
în aceeași tranzacție cu clipul; o singură sursă de adevăr, fără dual-write; lease/retry/dead-letter
sunt coloane interogabile (metrici, admin) cu SQL simplu; Redis rămâne efemer (poate fi evacuat sau
repornit fără pierderi). Volumul (joburi de minute, nu mii/s) e mult sub pragul la care `SKIP LOCKED`
ar deveni o problemă.

| Element | Implementare |
|---|---|
| Migrare | `db/migrations/20260927_0010_video_job_queue_lease.sql`: `locked_by`, `lease_expires_at`, `heartbeat_at`, `dead_lettered_at` + indexuri (claim, lease, dead-letter); joburile `running` vechi primesc un lease derivat |
| Claim | `workers/video-worker/video_worker/pg_queue.py`: `WITH next AS (… FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE … RETURNING` — `queued` scadente sau `running` cu lease expirat, cât `attempt_count < max_attempts`, ordonate după `priority DESC, scheduled_at` |
| Lease + heartbeat | `lease.py`: thread care prelungește lease-ul (`VIDEO_LEASE_SECONDS`=120, bătaie la 40 s) pe toată durata jobului; lease pierdut → flag + scrieri finale **fenced** (`locked_by = worker`) în `db.py` |
| Retry cu backoff | eroare tranzitorie → `queued` cu `scheduled_at = now + min(5·2^(n-1), 900) s + jitter`; poate fi reluat de **orice** worker |
| Dead-letter | încercări epuizate → `failed` + `dead_lettered_at` (reaper în worker + `watchdog-videos`); erorile permanente rămân `failed` fără dead-letter (creatorul poate reîncerca) |
| Idempotență | ieșirile au chei deterministe (`output_prefix`) → o reluare suprascrie aceleași obiecte; doar deținătorul lease-ului scrie rândurile |
| Oprire grațioasă | SIGTERM în timpul unui job → ffmpeg oprit, jobul **eliberat** în coadă fără să consume o încercare (`VIDEO_SHUTDOWN_MODE=release`); `finish` = termină jobul |
| Trezire | web: `PUBLISH video:jobs:wakeup <job_id>` (`lib/video/redis-queue.ts` → `lib/queue/video-jobs.ts`); worker: pub/sub cu fallback pe polling la 2 s. Upload-ul nu mai dă 503 când Redis e jos |
| Metrici | `GET /api/admin/video-queue` (RBAC `system`): queued, retry programat, running, lease-uri expirate, dead-letter, workeri activi, vârsta celui mai vechi job + ultimele dead-letter; `POST {action:"requeue", jobId}` (audit). `/api/health/queue` și `alert-video-queue` citesc aceleași metrici; `python -m video_worker.main --stats` |
| Scalare | `docker compose up --scale video-worker=N` sau containere pe alte host-uri: au nevoie doar de `DATABASE_URL` + credențiale R2 (Redis opțional) |
| Rollback | `VIDEO_QUEUE_BACKEND=stream` pe web și worker = comportamentul vechi (coloanele noi sunt ignorate) |

Notă: acțiunea admin „reprocess” din `api/admin/videos` inserează un job cu `payload='{}'` (bug
preexistent — nu era publicat niciodată în stream). Acum workerul îl marchează `failed`/`invalid_payload`
în loc să-l ignore; de înlocuit cu `reprocessVideo(videoId, { reencode: true })`.

## 6. Sesiuni, secrete, boot

| Constatare | Fix |
|---|---|
| Secrete comune citite leneș, cu fallback-uri per proces (`APP_ENCRYPTION_KEY || NEXTAUTH_SECRET`) | `lib/runtime/env-check.ts` (apelat din `instrumentation.ts` → `lib/runtime/boot.ts`): în producție replica **nu pornește** fără `DATABASE_URL`, `REDIS_URL`, `APP_ENCRYPTION_KEY` (64 hex) și `CRON_SECRET`, cu log `[boot] FATAL` clar. `SKIP_ENV_CHECK=1` doar local. Toate replicile citesc același `.env.production` |

## 7. Health / readiness

- `GET /api/health`: + `replica: { id (hostname sau REPLICA_ID), pid, uptime_s }` și `release.commit`.
- `GET /api/ready` (nou): 200 doar dacă Postgres și Redis răspund și replica nu e în oprire; 503 imediat
  după SIGTERM. Healthcheck-ul containerului `web-next` folosește acum `/api/ready` (fără R2/email).

## 8. Oprire grațioasă

- Next standalone prinde SIGTERM: `server.close()` (nu mai acceptă conexiuni, așteaptă cererile în curs),
  apoi exit. Stream-urile SSE nu se termină singure → `lib/runtime/shutdown.ts` le închide imediat cu
  `event: reconnect` (+ `retry: 3000`), EventSource se reconectează la altă replică.
- Compose: `web-next` `stop_grace_period: 30s`; `video-worker` `stop_grace_period: 30s` (mod `release`;
  cu `finish` trebuie > `FFMPEG_TIMEOUT_SECONDS`).
- Rolling deploy: pornește replica nouă, așteaptă `/api/ready` = 200 cu noul commit, apoi oprește una
  veche; repetă. Clienții SSE ai replicii oprite se reconectează singuri.

## Rămase / în afara acestui task

- Redis are `allkeys-lru` + `maxmemory 512mb`: după mutarea cozii în Postgres, în Redis stau doar date
  efemere (rate limit, cache Next, idempotență, oferte Fly) — evacuarea e acceptabilă, dar pe serverul
  separat mărește `maxmemory` (cache-ul Next îl va umple).
- `mediamtx` (ingest RTMP live) e stateful prin natură — rămâne un serviciu unic, separat de replicile web.
- Pool-ul Postgres: N replici × `max` din `lib/db.ts` conexiuni — la >4 replici activează PgBouncer
  (serviciul `pgbouncer` există, dezactivat) în mod `transaction`. Atenție: advisory lock-urile de cron sunt
  `xact`-scoped, compatibile cu transaction pooling.
- Go `platform-api` e stateless (verificat: fără stare în proces); continuă să facă XADD în streamul vechi
  — inofensiv (workerul Postgres îl ignoră; `watchdog-videos` îl taie la ~1000 intrări cu XTRIM).
