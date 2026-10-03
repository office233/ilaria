# Swypik Kids — design

**Data:** 2026-09-21 · **Stare:** decizii de produs confirmate, spec de aprobat · **Următorul pas:** plan de implementare

## 1. Decizii de produs (confirmate)

| Decizie | Valoare |
|---|---|
| Identitate | **Profil de copil sub contul părintelui** („cont de kids"), nu cont separat cu email; părintele îl creează, îl șterge, îi setează limitele |
| Zidul de conținut | **Strict: copilul vede doar conținut Kids și nimic altceva** — nici feed, nici magazin, nici SWYP, nici chat, nici căutare generală |
| Conținut | **Curatoriat manual de admin** la început (clipuri, seriale Movies, piese Music marcate `kids`) |
| Control parental | **PIN parental** pentru ieșirea din Kids și pentru setări; **limită zilnică de timp** și **oră de culcare** în MVP |
| Navigație | „Swypik Kids" în hamburger; din Kids nu există navigație către restul aplicației |

## 2. Principii (GDPR-K / COPPA)
- Profilul de copil stochează doar: nume afișat, avatar (din setul nostru), bandă de vârstă (3–5, 6–8, 9–12). Fără email, fără dată de naștere exactă, fără telefon.
- **Zero tracking:** sesiunile Kids nu emit evenimente de feed, nu alimentează `user_interests`, nu personalizează; doar progresul de vizionare per profil (ca să existe „Continuă").
- Fără comerț, fără SWYP, fără reclame, fără link-uri externe, fără comentarii/like-uri publice, fără DM.
- Ștergerea contului părintelui șterge profilurile și progresul (`ON DELETE CASCADE`).

## 3. Model de date — `db/migrations/2026MMDD_NNNN_kids.sql`

```
users.kids_pin_hash text NULL            -- PIN parental (bcrypt), setat la primul profil
kid_profiles
  id uuid PK · parent_user_id → users · display_name · avatar_key text (set intern) · age_band text 3-5|6-8|9-12
  daily_limit_min int NULL · bedtime_start time NULL · bedtime_end time NULL · created_at · updated_at
kid_content
  id uuid PK · kind video|movie_series|music_track · ref_id uuid/bigint · age_band_min · age_band_max
  category text cartoons|songs|stories|learn|games · title_override · approved_by → users · approved_at
  UNIQUE (kind, ref_id)
kid_progress
  kid_profile_id → kid_profiles · content_id → kid_content · position_ms · completed · updated_at · PK (kid_profile_id, content_id)
kid_usage
  kid_profile_id · day date · seconds int · PK (kid_profile_id, day)      -- pentru limita zilnică
```

`videos` primește `kids_safe boolean DEFAULT false` (setat doar de admin); `movie_series.audience` și `music_tracks.audience` ∈ general|kids. `kid_content` este lista curatoriată; un element intră în Kids doar dacă există în `kid_content` **și** sursa e `kids_safe`/`audience='kids'` și aprobată la moderare.

## 4. Sesiunea Kids (zidul)
- Părintele deschide `/kids`, alege profilul (sau îl creează), confirmă cu PIN → serverul emite un **cookie separat `swypik_kid`** (token semnat, `kid_profile_id`, expiră la 12 h) și **păstrează** cookie-ul părintelui.
- `lib/auth/getAuthUser` întoarce `kidProfileId` când cookie-ul Kids e valid. **Middleware-ul** (`middleware.ts`): cu `swypik_kid` prezent, orice cale în afara `/kids`, `/api/kids`, `/api/health` și resurselor statice → redirect `302 /kids` (pagini) / `403 { error: "kids_mode" }` (API). Ieșirea: `POST /api/kids/exit` cu PIN-ul părintelui → șterge cookie-ul.
- Limita de timp și ora de culcare se verifică **server-side** la fiecare `play` și la heartbeat (`POST /api/kids/usage` la 30 s): depășite ⇒ `423 Locked` + ecran „Gata pentru azi 🌙".
- Rate-limit pe PIN (5/10 min) și blocare temporară după 5 eșecuri.

## 5. API (`FEATURE_KIDS`)

| Rută | Rol |
|---|---|
| `GET/POST /api/kids/profiles`, `PATCH/DELETE …/[id]` | părinte (cu sesiune normală): profiluri + limite |
| `POST /api/kids/pin` (set/change), `POST /api/kids/enter` `{ profileId, pin }`, `POST /api/kids/exit` `{ pin }` | intrare/ieșire în mod Kids |
| `GET /api/kids/home` | categorii + rânduri (Continuă, Desene, Cântece, Povești, Învață), filtrate pe banda de vârstă |
| `GET /api/kids/content/[id]/play` | URL de redare (clipuri: public; episoade Movies kids: proxy cu token de tip kid; piese: public) — fără paywall, niciodată |
| `POST /api/kids/progress`, `POST /api/kids/usage` | progres per profil, contor de timp |
| `GET/POST/DELETE /api/admin/kids/content` | curatoriere (caută clip/serial/piesă, setează categorie + bandă de vârstă) |

## 6. UI (`app/[locale]/kids/…`, namespace `kids`)
- **`/kids`** — selector de profiluri (avataruri mari), „Adaugă copil" (părinte), PIN.
- **Acasă Kids** — fundal deschis, tile-uri mari, categorii ca butoane colorate, fără text mărunt, navigare cu icoane; rânduri: Continuă, Desene, Cântece, Povești, Învață.
- **Player Kids** — vertical/orizontal după conținut, fără like/comment/share/shop, auto-next doar în aceeași categorie, buton mare „Înapoi"; ceas de timp rămas; ecran de culcare.
- **Setări părinte** (în `/account/kids`, cu PIN) — profiluri, limită, culcare, istoric de vizionare pe profil, ștergere.
- **Admin** (`/admin/kids`) — coadă de curatoriere.
- Bara de jos ascunsă în Kids; hamburger cu intrare „Swypik Kids" (`NEXT_PUBLIC_FEATURE_KIDS`).

## 7. Faze
1. **MVP:** migrare, cookie Kids + middleware (zid), profiluri + PIN + limite, curatoriere admin, acasă + player pentru clipuri și seriale Movies kids, progres, i18n, flag.
2. Music kids, jocuri (HTML5 curatoriate), rapoarte săptămânale pentru părinți, mod offline.

## 8. Testare
- Unit: `isWithinBedtime`, `remainingSecondsToday`, `kidsWallDecision(path, cookiePresent)` (redirect/403/allow), `canPlayKids(content)`.
- API: orice `/api/*` din afara Kids cu cookie Kids ⇒ 403; `play` după limită ⇒ 423; PIN greșit ×5 ⇒ blocat.
- E2E: părinte creează profil → intră în Kids → nu poate deschide `/explore` (redirect) → ieșire cu PIN.
