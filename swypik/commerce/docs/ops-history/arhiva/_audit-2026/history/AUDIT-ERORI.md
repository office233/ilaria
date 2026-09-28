# Audit de erori Swypik — 2026-08-25

Metodă: 6 dimensiuni analizate (auth, bani/webhooks, pipeline video, contracte API, i18n, autorizare), fiecare constatare trecută printr-un verificator adversarial. Rezultat brut: **22 confirmate, 1 respinsă**. Verificarea a rulat pe codul real din WSL; unde s-a putut, am confirmat empiric pe baza de date live.

> Sursele brute: `audit2-findings.txt`, `audit2-fixes.txt` (artefacte, se pot șterge).

---

## 🔴 REPARAT ȘI DESFĂȘURAT (securitate — prioritate maximă)

### [1][2][7][8] Breșă critică: OTP-ul funcționa ca token de sesiune — preluare completă de cont
OTP-urile (email + seller) erau salvate în aceleași tabele ca sesiunile, cu `token_hash = sha256("otp:" + cod)`. Cum fiecare resolver de cookie hash-uia valoarea brută, un cookie literal `swypik_session=otp:123456` producea exact hash-ul rândului de OTP ⇒ autentificare pe contul victimei. Interogarea nici nu lega hash-ul de email, deci se potrivea **orice** OTP activ din sistem — reducând atacul mult sub 10⁶ încercări. Același defect pe `seller_session`.

**Dovadă empirică** (pe baza live): interogarea veche accepta hash-ul unui OTP real ca sesiune validă (`→ vargaabel12@gmail.com`); cea nouă cu filtru de tip îl respinge. După deploy, toate variantele `otp:XXXXXX` testate în producție → **respinse**.

**Fix** (3 straturi):
1. `isSessionTokenFormat()` — gardă de format (64 hex) în **toți** cei 6 resolveri (`lib/auth/session.ts`, `getAuthUser.ts`, `social/session.ts`, `seller-auth.ts`, `creator/session.ts`, GET `/api/auth`). Un token real e `randomBytes(32).toString("hex")`; `otp:NNNNNN` nu trece.
2. Filtru `COALESCE(metadata->>'type','session')='session'` pe toate interogările de sesiune (defense-in-depth).
3. OTP-urile anterioare se revocă la emiterea unuia nou (elimină acumularea care înmulțea șansele atacului).
+ test de regresie `tests/unit/session-token-format.test.ts`.

### [11] Suspendarea nu rezista la re-login
`login_password` verifica doar `status='suspended'`, nu și `suspended_until`. Un user suspendat temporar (30 zile) se re-loga imediat cu aceeași parolă. **Fix**: verifică și `suspended_until`.

### [13] `set_password` nu evacua atacatorul
Schimbarea parolei nu revoca nicio altă sesiune — un atacator cu cookie furat rămânea logat exact după ce victima își schimba parola ca să-l dea afară. **Fix**: revocă toate celelalte sesiuni user + seller, păstrează sesiunea curentă.

### [12] Escaladare la rol de seller prin email neverificat
Rolul de seller se deriva din potrivirea email-ului cu un rând `sellers` aprobat — fără dovada că userul deține emailul. Un atacator își făcea cont cu emailul public al unui seller aprobat (care nu-și crease cont) și prelua portalul. **Fix**: rolul se acordă doar cu `email_verified_at` setat, în ambele locuri — `auth/route.ts` **și** `buildSession` (evaluat la fiecare cerere, locul decisiv).

---

## 🟠 REPARAT ȘI DESFĂȘURAT (bani)

### [3] Webhook Stripe: claim-ul de idempotență nu se elibera la eșec
La `checkout.session.completed`, dacă handler-ul arunca (ex. `listLineItems` timeout), rândul de idempotență rămânea inserat. Stripe retrimite → tratat ca **duplicat** → evenimentul se pierde definitiv: plata reușită, comanda nefinalizată. **Fix**: la eșec de handler, `DELETE FROM processed_stripe_events` ca retry-ul să reintre.

### [4] Refund PARȚIAL marca toată comanda `refunded`
Un refund de bunăvoință de 20 RON dintr-o comandă de 300 cu 3 selleri marca **toată** comanda `refunded` (stare terminală): anula itemele nelivrate, bloca payout-urile tuturor sellerilor, revoca tot SWYP-ul. **Fix**: distinge parțial de total (`amount_refunded` vs `amount`); parțialul scrie starea nouă `partially_refunded` (migrare `20260825_0001`) și nu atinge iteme/payout-uri. Payout-ul o exclude corect (nu e în lista terminală).

### [14] Dublă recreditare SWYP: cursă cron ↔ webhook
Cron-ul `reclaim-abandoned-swyp` anulează intentul → declanșează webhook `payment_intent.canceled` ~1s mai târziu. Ambele apelau `refundSwypForUnpaidOrder` cu `refType` diferit; guard-ul cross-type `hasAnySwypRefundForOrder` era check-then-act (TOCTOU), deci ambele treceau înainte de scriere → dublă creditare. **Fix**: `withAdvisoryLock('swyp_refund:<orderId>')` — lock advisory Postgres la nivel de sesiune care serializează cele două căi pe același order.

---

## 🟠 REPARAT ȘI DESFĂȘURAT (pipeline video + i18n)

### [5] Watchdog fura joburile legitime >30 min
Worker-ul marca `running` la claim și nu mai atingea `updated_at`. Watchdog-ul reseta la `queued` orice `running` mai vechi de 30 min → alt worker relua **același** clip (dublă transcodare, attempt_count umflat, clip bun marcat failed). **Fix**: heartbeat pe un thread daemon care împinge `updated_at` la fiecare 2 min cât durează transcodarea (`worker.py` + `db.py`).

### [6] Selectorul de limbă nu schimba limba pe rutele localizate
Pe paginile neprefixate (default `ro`), alegerea unei limbi seta cookie + `router.refresh()` — dar refresh pe URL neprefixat rămâne `ro`. **Fix**: router **localizat** (`router.replace(pathname, { locale })`) care pune/scoate prefixul de limbă (`/explore` → `/en/explore`).

---

## ⚪ RESPINS la verificare / alarmă falsă

### [9] „Rute de admin nu așteaptă autorizarea" — FALS
Verificatorul a semnalat `return hasAdminSession()` fără `await`. La citire: acestea sunt `return` dintr-o funcție `async isAdmin()`, iar **toți** apelanții fac `if (!(await isAdmin(req)))`. Autorizarea e corectă. Nemodificat.

---

## 🟡 RĂMASE (documentate — lucrări mari sau decizii de produs)

Toate reale, niciuna nu e blocantă acut; le las cu recomandare, nu le repar orbește:

- **[10] Sesiunile de admin nu se revocă la retrogradare** — `admin_sessions` e o tabelă globală fără `user_id`, deci nu poate fi filtrată per-user din `set_password`. Cere ori adăugarea coloanei `user_id` pe `admin_sessions` + revocare în fluxul de retrogradare din `/admin/users`, ori scurtarea TTL-ului admin. Decizie de infrastructură.
- **[15] Hosted checkout: `seller_id` invizibil în metadata camelCase** — itemele sellerilor ajung în coada manuală, sellerul nu e plătit. Cere alinierea cheilor de metadata (snake vs camel) între `create-intent` și handler-ul de webhook — verificare atentă pe fluxul de comisioane.
- **[16] PATCH `action=complete` neidempotent** — dublu „Publică" creează 2 joburi → 2 workeri pe același clip. Cere un guard de idempotență pe upload session.
- **[17] Limita de 1GB și tipul fișierului neaplicate pe upload** — presigned PUT nu semnează Content-Length. Un cont creator compromis poate urca 4.9GB. Cere validare la `complete` (HEAD pe obiect) + politică de mărime.
- **[18][19] i18n la scară**: 114 fișiere folosesc `next/link` brut → click-urile pierd prefixul de limbă; unele pagini `[locale]` rezolvă limba din cookie în loc de parametrul URL (SEO greșit pentru vizitatori străini din Google). Cere un sweep mare + înlocuire cu `Link` localizat.
- **[20] `creditSwypRefund` neatomic** — subunitățile și cenții fondului comit separat; un crash între ele lasă fondul de acoperire dezechilibrat. Cere unificarea în aceeași tranzacție.
- **[21] Payout: `transfer_initiated` scris înainte de transfer** — crash în fereastră blochează itemul definitiv. Cere reordonare cu TTL de retry.
- **[22] Stringuri hardcodate în română** în onboarding/push/sidebar — userii străini văd prima experiență pe jumătate în română. Cere extragerea în `messages/`.

---

## Verificare
`tsc` curat · `vitest` 126/126 (122 + 4 regresie OTP) · ESLint 0 erori · deploy exit 0 · breșa OTP confirmată închisă în producție.

**Migrare de aplicat pe orice mediu nou**: `20260825_0001_orders_partially_refunded.sql` (deja aplicată pe WSL).
