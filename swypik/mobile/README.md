# Swypik mobile pilot

## Stare curentă — 28 septembrie 2026

Navigarea are acum **Descoperă, Magazin și Cont**. Studio rămâne retras; secțiunile istorice de mai jos nu descriu integral versiunea curentă.

În această etapă au fost implementate local ecranul Cont, clientul de autentificare Bearer, verificarea profilului pe server, restaurarea și rotația sesiunii, deconectarea și adaptorul nativ Expo SecureStore. Autentificarea este **dezactivată implicit** și nu este disponibilă în previzualizarea web. Nu s-a autentificat niciun cont real și nu s-au publicat aceste modificări în Azure.

Activarea necesită explicit `EXPO_PUBLIC_MOBILE_AUTH_ENABLED=1` și `EXPO_PUBLIC_MOBILE_AUTH_ORIGIN` cu originea HTTPS a unui backend compatibil verificat. Nu presupune că api.swypik.com expune aceleași rute ca Next.js. Nu seta aceste variabile pentru producție înainte de reconcilierea release-ului live și publicarea corecțiilor backend. Parolele nu sunt persistate; tokenul și expirarea sunt salvate într-o singură înregistrare SecureStore, separată pe origine. Nu există fallback la localStorage sau AsyncStorage.

Verificări efectuate în sesiunea din 28 septembrie: **42/42 teste trecute** (38 noi pentru autentificare și 4 existente), TypeScript și lint trecute, exporturi JavaScript/Hermes Android, iOS și web reușite în `dist/auth-20260928`. Exporturile nu sunt APK/IPA semnate. Testarea în browser nu a putut fi încheiată deoarece previzualizarea locală nu a devenit accesibilă în test; nu este raportată ca trecută. Nu s-au efectuat teste pe telefoane. Instalarea dependenței compatibile `expo-secure-store@57.0.4` a păstrat raportul npm la 13 constatări moderate, încă de evaluat.

Predarea completă și pașii înainte de beta sunt în `docs/AUTH-PILOT-2026-09-28.md`.

---

## Istoric — 27 septembrie 2026

Prototip de evaluare Expo SDK 57 / React Native 0.86. Nu este aplicația completă, nu este publicat și nu înlocuiește Swypik web.

## Ce funcționează în cod

- Descoperă: citește prima pagină a feedului real `/api/explore/feed?limit=12`, cu încărcare, eroare, retry și stare goală explicită.
- Magazin: citește primele 12 produse din catalogul video `/api/products?mode=video&limit=12`; nu efectuează cumpărături.
- Studio: alegerea unui clip din galerie și previzualizare locală. Nu încarcă fișierul pe server. Playerul este oprit când aplicația pierde focusul / intră în fundal.
- Brandul violet și culorile de bază provin din tokenurile Swypik existente. Ecranele sunt un experiment nativ, nu paritate de design.
- Niciun secret, acces DB, integrare MultiERP sau apel Ilaria în client.

## Pornire

Din PowerShell, în acest director:

```powershell
npm ci
npm start -- --lan
```

Telefonul și calculatorul trebuie să fie în aceeași rețea. Deschide proiectul în Expo Go compatibil cu SDK 57. Pentru iPhone fizic, documentația actuală Expo cere autentificarea CLI și Expo Go în același cont Expo. Nu au fost create conturi și nu au fost pornite builduri cloud contra cost.

Previzualizarea de pe calculator: `npm run web -- --localhost --port 8081`, apoi http://localhost:8081.
Adaptorul `/preview` este doar pentru browser: permite două cereri GET fixe către date publice și nu transmite cookie-uri ori tokenuri. Telefonul folosește direct HTTPS către swypik.com; api.swypik.com nu deservește încă aceleași rute Next.js.

## Verificare efectuată

- TypeScript și Expo lint: trecute.
- 4 teste pentru validarea datelor și respingerea URL-urilor nesigure: trecute.
- Expo Doctor: 21/21 verificări trecute inclusiv pe configurația finală.
- Export JavaScript/Hermes Android, iOS și web: reușit. Nu reprezintă APK/IPA semnat sau test pe dispozitiv.
- Browser: Descoperă, Magazin și Studio se deschid; feedul și catalogul afișează stări goale reale. Endpointurile publice au returnat 200 la verificare.
- `adb devices`: niciun dispozitiv conectat. Galeria, sunetul, redarea și revenirea din fundal pe telefoane sunt încă de testat.
- npm audit: 13 constatări moderate în lanțurile decode-uri-component (Expo Router/query-string) și uuid (instrumentele Xcode). Detalii în dependency-audit.json. Nu s-a aplicat downgrade-ul major sugerat automat. Acestea rămân de rezolvat/evaluat înainte de distribuție.

## Ce nu este implementat

Autentificare, creare cont, OAuth/deep links, coș, checkout, upload public, chat, notificări push, panoul comerciantului, apeluri și Ilaria. Acest pilot nu certifică scalarea la milioane de utilizatori.

Nu există încă APK/IPA. Pentru distribuție pe ambele platforme fără Mac, următorul pas este configurarea buildurilor EAS și conturilor de semnare, după testarea pilotului. Proiectele Capacitor existente sunt păstrate pentru comparație.

## Test manual pe fiecare telefon

1. Deschide Descoperă și Magazin; verifică loading, retry și starea goală.
2. Oprește temporar internetul: trebuie să apară eroare după cel mult 15 secunde, apoi retry să funcționeze când revine conexiunea.
3. În Studio, alege un clip propriu; verifică sunet/pauză și închiderea previzualizării.
4. Refuză accesul la galerie pe iOS: mesaj clar, fără blocarea aplicației.
5. Schimbă tabul sau treci aplicația în fundal în timpul redării: playerul trebuie să se oprească.
6. Notează modelul telefonului, versiunea OS, viteza de pornire, blocaje și consumul observat. Rezultatele sunt încă necompletate.

Documentație: https://docs.expo.dev/get-started/start-developing/ ; https://docs.expo.dev/versions/v57.0.0/ ; https://docs.expo.dev/router/web/api-routes/


## Modificare de scop, 27 septembrie 2026

Studio a fost retras din versiunea disponibilă la cererea proprietarului. Ruta /studio și tabul au fost eliminate; codul este păstrat în src/features/studio/StudioPreview.tsx pentru o etapă viitoare. Instrucțiunile de testare Studio de mai sus sunt suspendate. Versiunea curentă are numai Descoperă și Magazin. Autentificarea și funcțiile aplicației principale au prioritate.
