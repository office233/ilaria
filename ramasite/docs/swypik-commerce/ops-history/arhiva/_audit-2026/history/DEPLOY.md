# Deploy efectuat — 2026-08-25, 08:14–08:38

Totul e livrat și verificat pe stack-ul din WSL. Site-ul a fost jos **sub 2 minute**, o singură dată, pentru repornirea WSL.

---

## Ce s-a întâmplat, în ordine

| Ora | Pas | Rezultat |
|---|---|---|
| 08:14 | Stare inițială înregistrată | swypik.com 200, app 200 |
| 08:14 | `wsl --shutdown` | oprit curat |
| 08:15 | Distro repornit cu ancoră | exec **funcțional din nou** (după 11 zile) |
| 08:16 | Docker + containere | pornite automat (`restart: unless-stopped`), cloudflared activ, site 200 |
| 08:18 | Cod transferat în `/opt/swypik/app` | patch aplicat curat, CRLF normalizat, comis pe `audit/2026-08-25` |
| 08:20–08:30 | `wsl-deploy-web.sh` (fără argumente) | web-next, video-worker, cron-worker rebuild-uite |
| 08:30 | Smoke test | toate verde |
| 08:36 | `refresh-rank` | `{"ok":true, max_score:"20.0"}` |

**Site-ul a rămas 200 pe tot parcursul build-ului** — containerul vechi a servit până la înlocuire.

---

## Dovada că rulează cod nou

```
web-next      2c85eb8b  →  e6a44c5e   ✅ imagine nouă
video-worker  a7ab090f  →  ca42b860   ✅
cron-worker   5b9eaa31  →  c1deb79f   ✅
platform-api  023747d2  →  023747d2   (neschimbat)
```

Scriptul a raportat „DEPLOY INCOMPLET" pentru `platform-api` și a ieșit cu cod 1. **E o alarmă falsă aici**: commit-ul conține **0 fișiere Go** (`git show --stat | grep -c services/platform-api` → 0), deci imaginea corect nu s-a schimbat. Scriptul nu poate ști asta — el compară doar hash-uri, ceea ce e comportamentul dorit după incidentele din 10 și 17 august.

---

## Verificat pe stack-ul live (`:3005`, cod nou)

| Test | Rezultat |
|---|---|
| `swypik.com` | 200 |
| `/api/explore/feed` | 200, **12 clipuri**, 105 ms |
| `/api/feed/universal` | 200, **10 itemi** — înainte returna `0`, mereu |
| `/api/videos/{id}/like` fără autentificare | **401** (comportament deliberat) |
| `/api/products` în RON | `public, s-maxage=60` — cache CDN păstrat |
| `/api/products` în EUR | **`private`** — bug-ul cu prețuri în valuta greșită e închis |
| `refresh-rank` | 200, `max_score: 20.0` (era 2.0 înainte de migrare) |
| Containere | 17 pornite, **0 nesănătoase**, cloudflared activ |

---

## Baza de date

Aplicate mai devreme, prin portul 5433 (5432 e al ERP-ului `meister-postgres` — verificat înainte, altfel migram baza greșită):

- `20260824_0001_video_rank_fix_events` — rescrisă ca „construiește nou → `RENAME`", ca să nu blocheze feed-ul cât se repopulează view-ul
- `20260824_0002_hot_path_indexes`
- 2 indexuri `CONCURRENTLY` pe `feed_events` — ambele `indisvalid = true`

---

## Efect secundar important: ți-ai recăpătat controlul

Canalul Windows↔WSL era mort din **14 august**. Keepalive-ul tău a încercat de **5796 de ori** să repornească distro-ul și **nu a reușit niciodată** — nicio linie „OK" în tot log-ul. Aveai un site live pe care nu-l puteai administra, fără plasă de siguranță.

Acum `wsl -l --running` detectează corect distro-ul, deci keepalive-ul redevine funcțional și log-ul ar trebui să nu mai crească.

Notă practică: din Git Bash, comenzile WSL au nevoie de `MSYS_NO_PATHCONV=1`, altfel căile Linux (`/bin/echo`) sunt traduse în căi Windows și exec-ul eșuează cu un mesaj derutant.

---

## Stare git

- **În distro** (`/opt/swypik/app`): branch `audit/2026-08-25`, commit `c2a1964b`. `main` a rămas la `d8b42f55` — merge-ul îl faci tu când ești mulțumit.
- **Pe Windows** (`E:\Swypik\swypik\app`): branch `fix/audit-swypik`, modificările sunt necomise, exact cum le-ai lăsat.

Dacă vrei revenire rapidă în distro: `git checkout main && bash scripts/deploy/wsl-deploy-web.sh`.

---

## Ce a rămas nefăcut (deliberat)

Toate cer fie o decizie de-a ta, fie o lucrare separată — niciuna nu e un bug nereparat:

- **Cache Redis în fața feed-ului** — cel mai mare câștig de performanță rămas.
- **Paginare pe cursor** — acum paginile se suprapun pe ~75% din rânduri.
- **Tree-shaking Sentry** (~22-49 kB/pagină) — am măsurat varianta sigură, bundle-ul a crescut; câștigul real cere dezactivarea monitorizării de performanță.
- **Rezervare de stoc** — previne oversell-ul între inițierea plății și plata efectivă; e funcționalitate de produs.
- **Pipeline video** — time-to-first-frame 1.5–2.5 s față de ~300 ms la TikTok (segmente de 6 s, ladder landscape pentru feed vertical, postere la rezoluția sursă).
- **i18n**: 162 de namespace-uri (117 kB) în payload-ul fiecărei pagini.

Detalii și justificări: [RAPORT.md](RAPORT.md).
