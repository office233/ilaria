# Audit hardcodări — Swypik

> Faza 1 (2026-08-02). Instrumente: `scripts/scan-hardcoded.mjs`, `scripts/audit-i18n.mjs`, `scripts/wsl-audit-hardcode.sh`.

## 1. Secrete / IP-uri / URL-uri

| Găsire | Verdict |
|---|---|
| IP VPS mort (178.105.46.66) în cod TS | ✅ 0 apariții |
| Chei live (sk_live, whsec_, AIzaSy) în cod | ✅ 0 (doar `whsec_test_secret` în test Go + `whsec_CHANGE_ME` în env.example — OK) |
| `http://localhost:3000` fallback-uri | JUSTIFICATE — doar când `NODE_ENV !== production` sau ca fallback dev (`lib/url.ts`, `lib/auth/oauth/helpers.ts`, `app/api/v1/feed`, `trips/packages`, `cron/daily-maintenance`). Nicio cale de producție nu le folosește. |
| Fallback-uri `process.env.X \|\| "..."` | JUSTIFICATE — valori default nesecrete: modele AI (gpt-4o-mini, gemini-2.0-flash, claude-opus-4-7), email-uri @swypik.com, `Europe/Bucharest`, nume cozi Redis. Niciun secret cu fallback. |

## 2. Stringuri UI hardcodate (scan-hardcoded.mjs)

**Stare: 461 hituri în 126 fișiere `.tsx`** — texte în JSX netrecute prin next-intl. Top ofensatori:

| Fișier | Hituri |
|---|---|
| `app/seller/listings/page.tsx` | 25 |
| `app/admin/fleet/FleetActions.tsx` | 17 |
| `app/seller/merchant/MerchantPanelClient.tsx` | 16 |
| `app/courier/earnings/EarningsClient.tsx` | 13 |
| `components/ChatInterface.tsx` | 12 |
| `app/admin/disputes/DisputeEvidenceForm.tsx` | 11 |
| `app/[locale]/legal/anpc/page.tsx` | 10 |

Notă: zonele admin/seller/courier sunt interne (RO-first) — prioritate mai mică decât paginile `[locale]/` publice. Plan: fixare pe loturi în fazele următoare, țintă finală 0 sau justificat (ex. denumiri proprii). Listă completă: rulează scanerul.

## 3. i18n (audit-i18n.mjs)

- Chei lipsă: **0** în toate cele 7 limbi ✅
- Orfane: **0** ✅; namespace-uri nefolosite: **0** ✅ (159 totale)
- Netraduse: 1 cheie × 5 limbi — `sellerAddProduct.courier_posta_romana` = **JUSTIFICAT** („Poșta Română" e nume propriu).

## 4. Multi-ERP (Go)

- `modules/hardware/installer.go:27` — fallback hardcodat la IP-ul VPS mort → **FIXAT** (acum eroare 500 explicită dacă `VPS_PUBLIC_IP` nesetat).
- Alte apariții 178.105.46.66 în backend Go: 0.
