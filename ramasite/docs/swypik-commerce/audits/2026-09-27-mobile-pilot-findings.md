# Constatări inițiale pentru mobil și domenii — 27 septembrie 2026

Acest document completează planul de migrare și inventarul static. Nu confirmă că toate funcțiile sunt operaționale. În această etapă nu s-a schimbat traficul public sau configurația Azure.

## Inventar și reutilizare

Inventarul reproductibil `node tools/audit-mobile-readiness.mjs` identifică 173 pagini Next.js și 426 fișiere API, în 76 familii. Listele sunt în `mobile-inventory/routes.json`.

Se pot reutiliza contractele de date și logica pură fără DOM/Next/server. `lib/feed/types.ts` și `lib/feed/client/feed-source.ts` oferă contractul feedului, dar trebuie urmărite și importurile tranzitive înainte de extragerea într-un pachet comun. Tokenurile vizuale existente sunt punctul de plecare al prototipului. Componentele DOM/CSS, route handlers, middleware, cookie APIs și accesul DB nu se copiază în React Native.

Pilot separat: E:\Swypik\swypik-mobile-pilot. Trei ecrane, cereri publice reale, galerie/video local. Expo rămâne candidat până la teste pe Android și iPhone; nu s-a decis eliminarea Capacitor.

## Blocaje concrete pentru autentificarea mobilă

1. `/api/auth/token` emite bearer, dar `/api/auth/me` folosește `getAuthUser()` care citește cookie-uri. Loginul mobil nu produce automat profil autenticat pe această rută. Corecția trebuie să păstreze separat rolurile și sesiunile seller/admin, fără promovări implicite.
2. `/api/auth/token/refresh` execută SELECT, INSERT și UPDATE separat. Două cereri simultane pot emite doi succesori, iar un eșec între inserare și revocare poate păstra ambii tokenuri valizi. Necesită rotație atomică și teste concurente pe PostgreSQL, plus invalidarea la suspendare.
3. Ruta de emitere verifică suspended/deleted; resolverul comun verifică și banned/suspended_until. Politica trebuie aliniată înainte de beta.
4. `lib/auth/session.ts` acceptă Bearer, însă nu toate rutele utilizează acest resolver. Este necesară o matrice per endpoint, inclusiv verificarea rolului și a apartenenței comenzilor/produselor.

Nu s-au conectat conturi reale în pilot și nu s-au modificat aceste mecanisme în această etapă.

## Domenii — condiții înainte de schimbare

- Astăzi pilotul folosește rutele Next.js de pe https://swypik.com; nu presupune echivalență cu serviciul Go de la api.swypik.com.
- APP_URL și URL-ul site-ului public trebuie separate explicit. Cookie-ul principal derivă Domain din APP_URL; OAuth folosește și cookie-uri host-only. Teste obligatorii pentru sesiuni vechi, logout și callbackuri.
- CSP și lista originilor trebuie verificate pentru app.swypik.com. Nu extinde automat permisiunile la toate subdomeniile.
- Contract de rutare la api.swypik.com pentru API Next.js și Go, fără secrete interne expuse în client.
- Verifică OAuth redirect URI, resetări parole, linkuri email, checkout, întoarcerea din plăți, webhookuri și deep links înainte de DNS.
- Site public separat cu waitlist reală; fără butoane App Store/Google Play fictive.

## Ordinea următoarelor livrări

1. Corecții și teste pentru identitatea mobilă, token refresh/revoke și autorizare.
2. Testarea pilotului pe cele două telefoane; comparație documentată cu Capacitor pentru video, galerie, deep links și performanță.
3. Migrarea API și configurarea app.swypik.com în paralel, cu verificări end-to-end și rollback.
4. Marketing/waitlist, apoi integrarea Ilaria prin backendul Swypik după disponibilitatea serviciului.
5. Plăți și email reale, builduri semnate, distribuție beta, monitorizare și teste de încărcare graduală înainte de lansare.

Bugetul de aproximativ 500 USD/lună este pentru întregul Azure; nu este un angajament de capacitate pentru milioane de utilizatori. Actualizează inventarul/costul după verificarea reducerii de VM-uri gestionate în chatul Ilaria. Nu modifica infrastructura concurent cu acel chat.

WSL și copiile locale se păstrează până la inventar complet, backup verificat și probă de restaurare independentă. MultiERP rămâne exclus; SwypikOS și Ilaria sunt proiecte separate.
