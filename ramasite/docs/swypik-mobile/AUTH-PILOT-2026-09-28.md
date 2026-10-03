# Predare: Cont și autentificare mobilă

Data: 28 septembrie 2026, Europe/Bucharest.
Locație: E:\Swypik\swypik-mobile-pilot.

## Scop și stadiu

Implementare locală pentru un pilot Expo SDK 57. Nu este publicare în Azure, APK/IPA semnat sau validare pe dispozitive. Navigarea expune Descoperă, Magazin și Cont. Studio rămâne retras. MultiERP nu este reintrodus.

Loginul este dezactivat implicit. Backendul principal conține corecții locale pentru /api/auth/me și rotația atomică a tokenurilor, dar includerea lor în release-ul Azure curent nu a fost confirmată. Release-ul observat prin /api/health este upload-audio-20260927-191040, diferit de HEAD-ul Git local 28687e39 și de release-urile descrise în auditul precedent. Nu publica un snapshot vechi peste acesta.

## Fișiere implementate sau modificate

- src/lib/auth-core.ts: contracte validate, transport injectabil, timeout, maparea erorilor, stări de sesiune, serializarea scrierilor și rotație single-flight.
- src/features/auth/AuthProvider.tsx: context React și adaptor Expo SecureStore nativ.
- src/app/account.tsx: ecran Cont în limba română, stări dezactivat/încărcare/autentificat/offline/eroare.
- src/app/_layout.tsx: provider și tabul Cont, păstrând Descoperă și Magazin.
- tests/auth.test.ts: 38 teste noi exclusiv cu fixture-uri sintetice și transport injectat.
- package.json, package-lock.json și app.json: expo-secure-store@57.0.4 și pluginul instalate prin npx expo install expo-secure-store.
- README.md și acest document: stare verificată și limite.

Nu s-au modificat endpointul public read-only preview+api.ts, configurații .env active, secrete, baze de date sau resurse cloud. Nu s-au făcut commit/push; modificările preexistente au fost păstrate.

## Contracte backend

POST /api/auth/token primește email și parolă și returnează success=true, access_token opac de 64 caractere hex și expires_at ISO.

GET /api/auth/me folosește Authorization: Bearer și returnează ok=true, user.userId, role, email și displayName. Profilul nu este acceptat pe baza unui rol stocat local.

POST /api/auth/token/refresh primește Bearer și returnează un token succesor și expirarea. Refresh-urile simultane din același client sunt reunite într-o singură operație. O eroare de rețea ambiguă nu declanșează o nouă rotație automată.

POST /api/auth/token/revoke revocă tokenul. La logout, erorile de revocare remote sau ștergere locală sunt comunicate distinct; interfața nu pretinde că revocarea a reușit atunci când răspunsul nu a fost confirmat.

## Configurație înainte de testarea nativă

Variabile publice de build, fără secrete:

- EXPO_PUBLIC_MOBILE_AUTH_ENABLED trebuie să fie exact 1.
- EXPO_PUBLIC_MOBILE_AUTH_ORIGIN trebuie să fie originea HTTPS verificată a backendului, fără cale, credențiale, query, fragment sau wildcard.

Nicio origine de producție nu este implicită. Nu presupune că api.swypik.com și swypik.com sunt echivalente: primul deservește deja serviciul Go. next.swypik.com nu este staging izolat; utilizează producția conform auditului anterior.

Pe web, autentificarea rămâne dezactivată chiar dacă flagul este 1. Pilotul nu folosește localStorage, AsyncStorage sau un proxy de autentificare pentru a ocoli acest lucru. Pentru testare pe un telefon este necesar un backend HTTPS controlat și compatibil; rețeaua și certificatul trebuie verificate înainte de introducerea credențialelor.

SecureStore păstrează doar tokenul și expirarea într-o înregistrare mică, cu cheia separată pe origine. Nu persistă parola. Disponibilitatea stocării este verificată, iar erorile nu produc o identitate autentificată fictivă. Restaurarea offline păstrează tokenul, dar nu afișează profilul până la o verificare reușită pe server.

## Verificări efectuate

| Comandă | Rezultat |
| --- | --- |
| npm test | 42 teste trecute: 38 noi auth + 4 existente |
| npm run typecheck | exit 0 |
| npm run lint | exit 0 |
| npx expo export --platform all --output-dir dist/auth-20260928 | exit 0, exporturi iOS/Android/web |
| Test browser la viewport 390x844 | Neîncheiat: serverul de previzualizare nu a devenit accesibil în rularea de test |
| Login real, SecureStore pe telefon, APK/IPA semnat | Neefectuate |

Prima rulare TypeScript a identificat inferența prea restrictivă a două flaguri booleene din fixture-ul de test. Fixture-ul a fost corectat; verificările finale de mai sus au trecut. Avertismentul Node despre tipul de modul nespecificat rămâne neblocant. Instalarea a raportat în continuare 13 vulnerabilități moderate npm; nu s-a folosit audit fix --force sau downgrade automat.

Logurile sunt în E:\Swypik\audit-20260928-mobile-auth, inclusiv mobile-tests.txt și logurile încercărilor de previzualizare. Nu există o captură browser validată sau rezultat browser-smoke trecut pentru această sesiune.

## Criterii înainte de activare și beta

1. Reconciliază modificările locale ale backendului cu release-ul Azure actual, în special upload/audio și autentificarea mobilă. Verifică configurația de deploy pentru un singur nod web activ; nu porni automat nodurile dezalocate.
2. Verifică pe un backend controlat emiterea, /me, rotația concurentă, revocarea, expirarea și conturile suspendate. Nu efectua aceste probe pe conturi reale din producție fără un plan explicit.
3. Testează pe Android și iPhone: disponibilitatea SecureStore, restart, revenirea din fundal, conexiune întreruptă, logout în timpul unei cereri și comportamentul transportului nativ la redirect/timeout. Configurarea fetch redirect=error din cod nu înlocuiește validarea comportamentului pe ambele platforme native.
4. Validează interfața prin browser și pe dispozitive, inclusiv accesibilitate și tastatură. Testele pure TypeScript nu acoperă randarea nativă.
5. Evaluează cele 13 constatări moderate și pregătește builduri beta semnate numai după trecerea fluxurilor principale.

Înregistrarea, OTP, OAuth/deep links, coșul, checkoutul, comenzile, uploadul public, chatul și push nu sunt implementate de acest milestone. Autentificarea nu implică automat paritate cu aplicația web.

## Documentație primară consultată

- https://docs.expo.dev/versions/v57.0.0/
- https://docs.expo.dev/versions/v57.0.0/sdk/securestore/
- https://docs.expo.dev/router/advanced/authentication/
