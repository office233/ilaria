# Ștergerea contului (in-app)

Cerință App Store (Guideline 5.1.1(v)), Google Play („Account deletion") și GDPR art. 17.

## Flux
1. Setări → „Șterge contul" → `/[locale]/account/delete` (sesiune obligatorie).
2. Utilizatorul scrie username-ul și, dacă are parolă, parola. Poate descărca întâi datele (`/api/account/export`).
3. `POST /api/account/delete` (rate limit 5/15 min, zod, id doar din sesiune) → `lib/account/delete-account.ts`.
4. Email de confirmare în limba utilizatorului (dacă emailul e configurat); cookie-urile de sesiune sunt șterse.

## Ce se întâmplă cu datele
| Date | Tratament |
|---|---|
| `users` (email, nume, telefon, avatar, bio, data nașterii, parolă, 2FA, metadata, provideri) | anonimizate; `username = deleted_<id>`, `status = 'deleted'`, `deleted_at` |
| username-ul vechi | rămâne alias rezervat (nimeni nu preia `/u/<nume>`) |
| sesiuni (user/admin) | revocate / șterse |
| adrese, push, OAuth, preferințe, notificări, interese, feed, like-uri, salvări, colecții, follow-uri, blocări, recenzii, verificări de vârstă, tokenuri, coșuri nefinalizate | șterse |
| comentarii, mesaje | șterse logic (`status = 'deleted'`, corp înlocuit) |
| clipuri | ascunse, `status = 'deleted'` |
| comenzi, facturi, plăți, comisioane, payout-uri | **păstrate** (obligație legală: Legea contabilității 82/1991, Codul fiscal — 10 ani), legate doar de id-ul anonimizat |

Fiecare pas de curățare rulează separat: un tabel lipsă se loghează (`[account-delete] cleanup step failed`) și nu blochează ștergerea; nucleul (anonimizarea `users` + revocarea sesiunilor) e într-o tranzacție.

## Excepții
- Conturi de admin și vânzători activi nu se pot șterge din aplicație (obligații de business) — mesajul îi trimite la `SUPPORT_EMAIL`.
- Migrarea necesară: `db/migrations/20260928_0012_users_deleted_at.sql`.
