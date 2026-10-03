# Swypik — ce trebuie adus de proprietar (salvat 2026-09-26)

Aplicația e gata pentru fiecare dintre ele. Fără cheie, modulul arată o stare cinstită
(„neconfigurat” / „în pregătire”) și nu cade.

| # | Ce | Pentru ce | Unde se pune |
|---|----|-----------|--------------|
| 1 | ❌ NU e configurat (corectat 2026-09-28): în producție `RESEND_API_KEY=re_placeholder`. Cheie reală Resend (resend.com → API Keys; domeniul swypik.com are deja înregistrările DNS Resend) | confirmări de comandă, coduri de logare pe email, notificări | pe serverul Azure: `/opt/swypik/env/swypik.env` (o pun eu) |
| 1b | ❌ Stripe NU e configurat: în producție `sk_placeholder`/`pk_placeholder`/`whsec_placeholder`. Cheile Stripe (test sau live) + webhook `https://swypik.com/api/webhooks/stripe` | toate plățile cu cardul | pe serverul Azure (o pun eu) |
| 2 | ✅ REZOLVAT 2026-09-26: AI-ul trece pe Azure AI Foundry (gpt-5.4-mini + Whisper + Content Safety), plătit din creditele Azure — Gemini nu mai e necesar | — | — |
| 3 | Cloudflare Realtime (în locul LiveKit): `CF_REALTIME_APP_ID`/`CF_REALTIME_APP_TOKEN` (live) + `CF_REALTIMEKIT_*` (apeluri) + webhook `https://swypik.com/api/messenger/calls/webhook` | Live shopping + apeluri video | le creez eu din dashboard-ul Cloudflare |
| 4 | `JAMENDO_CLIENT_ID` (+ contract Jamendo Licensing pentru uz comercial) | Swypik Music | `.env.production` |
| 5 | Stripe Connect (`FEATURE_STRIPE_CONNECT` + cont Connect activat) | plăți automate către creatori, vânzători, gazde, șoferi (acum: transfer manual pe IBAN) | `.env.production` |
| 6 | Hartă + căutare adrese pentru Go: tile-uri (`NEXT_PUBLIC_MAP_TILE_URL`), rutare (`NEXT_PUBLIC_OSRM_URL`) și geocoder plătit/self-hosted, sau `GOOGLE_MAPS_API_KEY` | Swypik Go în trafic real | `.env.production` |
| 7 | Furnizor de zboruri: Duffel (vânzător direct, cont verificat + sold) / Travelpayouts (afiliere ~1–1,5%) / Kiwi Tequila (doar pe invitație) | Swypik Fly (acum „în curând” + listă de așteptare) | decizie + chei |
| 8 | Notificare la CNA ca serviciu media audiovizual la cerere (Decizia 116/2026, în vigoare din 27.09.2026) | Swypik Movies — **cu cel puțin 7 zile înainte de lansarea modulului** | depunere la CNA |

Alte decizii deschise: orașe + tarife Go la lansare, cash da/nu (acum oprit, se pornește din /admin/go),
documentele cerute șoferilor, politica de livrare/TVA pentru Shop, filmele de pornire (Blender CC-BY + seriale proprii).
