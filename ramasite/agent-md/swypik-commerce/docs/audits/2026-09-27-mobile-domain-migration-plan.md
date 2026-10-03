# Plan Swypik — aplicații mobile și separarea domeniilor

Data: 27 septembrie 2026. Document de planificare; nu schimbă traficul public.

## Direcție și limite

Swypik iOS/Android este produsul principal. swypik.com prezintă produsul; app.swypik.com păstrează aplicația web pentru testare și continuitate. api.swypik.com devine intrarea backendului comun, fără a rupe serviciul Go care folosește deja acest domeniu. Ilaria rămâne separată și este accesată prin backendul autentificat. SwypikOS este un proiect distinct. MultiERP rămâne exclus.

Bugetul orientativ de 500 USD/lună acoperă întregul Azure: VM, discuri, rețea, loguri, backupuri și servicii AI. Este un plafon de planificare, nu o țintă de consum. Costurile externe Azure, precum R2, conturile magazinelor și eventualele builduri/antrenări externe, se evidențiază separat. Nu se creează GPU sau VM suplimentare în această etapă.

## Ce este verificat

- Aplicația existentă folosește Next.js și un serviciu Go separat. Există panouri seller, creator, courier și admin; rute pentru feed/video, catalog, coș, checkout, comenzi, mesaje, live și mai multe verticale. Prezența unei rute nu demonstrează că funcția este completă sau activă.
- mobile/capacitor.config.json folosește server.url=https://swypik.com și webDir=../public. În directoarele native inspectate există AndroidManifest.xml și Info.plist, fără proiecte complete de build demonstrate.
- Testul desktop-mobile-packaging.test.ts verifică baza locală desktop/POS, nu construirea sau comportamentul aplicațiilor iOS/Android.
- /api/ilaria/chat verifică sesiunea și rolul admin, acceptă JSON limitat, aplică 5 cereri/minut/utilizator și ascunde erorile serviciului. Existența codului nu confirmă publicarea pilotului sau disponibilitatea unui model real.
- Agentul Ilaria lucrează, cu autorizarea proprietarului, la reducerea Azure la web-1 și data. Starea finală trebuie preluată înainte de următoarea publicare; procedura actuală cu două noduri nu trebuie folosită dacă web-2 este dezalocat.

## Etape și criterii de încheiere

### 1. Inventar funcțional și situație comună

Construim o matrice: funcție, rol, ecran, API, date, integrare externă, stare reală, teste, reutilizare mobilă și prioritate. Acoperim cont/autentificare, feed/swipe/video, căutare/catalog, produse/coș/comenzi, creator/upload, comerciant/POS/facturi, mesagerie/notificări, live/apeluri, admin/moderare și fiecare verticală existentă.

Separăm ce funcționează, ce este incomplet, ce este dezactivat și ce este doar demonstrație. Păstrăm toate funcțiile în inventar; ordinea implementării nu înseamnă eliminarea lor. Confirmăm noua topologie Azure, backupul și metoda de revenire.

Livrabil: matrice completă și lista blocajelor. Fără schimbări DNS.

### 2. Alegerea arhitecturii mobile printr-un prototip

Comparăm continuarea cu Capacitor și o migrare graduală React Native/Expo. Ipoteza de evaluat este React Native/Expo pentru interacțiunile mobile centrale, reutilizând contracte, validări, logică TypeScript pură, traduceri și identitatea vizuală. Componentele DOM și codul Next.js server-side nu sunt automat reutilizabile ca interfață nativă.

Prototipul trebuie să demonstreze pe Android și iPhone: autentificare și reluarea sesiunii, feed video/swipe, pagină produs și upload/cameră. Măsurăm fluiditate, memorie, pornire, rețea slabă și efortul de adaptare. Verificăm instrumentele Android și accesul la macOS/Xcode sau un serviciu de build iOS înainte de promisiuni de publicare.

Livrabil: decizie argumentată și două builduri de test; nu doar capturi sau configurații.

### 3. Backend comun și autentificare

Inventariem rutele Next.js și Go; păstrăm inițial implementările existente în spatele unei rutări explicite pentru api.swypik.com. Extragem numai rutele care depind de randarea web ori nu oferă un contract adecvat clienților mobili. Stabilim contractul API și clientul partajat, autorizarea pe rol/resursă, erorile, paginarea, uploadul și idempotenta operațiilor comerciale.

Verificăm sesiunile bearer existente înainte de a introduce un mecanism nou. Pe mobil: stocare securizată a tokenurilor, expirare/revocare și logout. Pe web: cookie-uri, CSRF, CORS și origin-uri restrictive. Secretele și conexiunile DB rămân pe server. Reparăm emailul real pentru OTP. Plățile se validează întâi în mediul de test; verificăm separat regulile curente ale magazinelor pentru fiecare tip de produs/abonament.

Livrabil: aceleași fluxuri de cont și comerț trec testele prin web și mobil.

### 4. Pregătirea app.swypik.com

Configurăm domeniul în paralel, păstrând swypik.com funcțional. Audităm cookie-uri și sesiuni, callbackuri OAuth, URL-uri de email, resetări, checkout success/cancel, webhookuri, CSP/CORS, WebSocket/SSE, deep links, media, canonical și sitemap. Un mediu de test nu trebuie să trimită emailuri sau plăți reale din greșeală.

Cookie-urile actuale nu sunt presupuse portabile între hostname-uri. Alegem explicit o reautentificare sau un transfer de sesiune verificat, fără a lărgi automat cookie-urile către toate subdomeniile.

Livrabil: matrice de teste pe noul domeniu și revenire documentată.

### 5. Site public de prezentare

Pregătim pagina principală, prezentarea funcțiilor, capturi autentice, întrebări frecvente, suport, confidențialitate și termeni. Înscrierea pentru lansare trebuie să salveze corect datele și să evite duplicatele/abuzul. Linkurile către App Store și Google Play apar numai după ce există listări reale.

Mapăm URL-urile vechi către echivalentele din app.swypik.com; nu redirecționăm toate paginile orbește către homepage și nu stricăm metodele POST/webhookurile.

Livrabil: prezentare verificată și formular funcțional, încă fără schimbarea domeniului principal.

### 6. Ilaria și funcțiile mobile

Verificăm contractul pilot cu serviciul pregătit în Nexus: endpoint, JSON, versiune, autentificare între servicii, timeout, limite și indisponibilitate. Testăm mai întâi administratorii; accesul utilizatorilor se extinde după măsurători de calitate, latență și cost. Nu prezentăm alt model drept Ilaria când serviciul ei este indisponibil.

Completăm progresiv funcțiile mobile inventariate: notificări, media, creator, comerciant și celelalte module. Testăm permisiuni, reluarea după întrerupere, accesibilitate, ștergerea contului și comportamentul offline. Nu promitem checkout offline.

Livrabil: versiuni beta și raport clar cu funcțiile demonstrate și cele încă în lucru.

### 7. Schimbarea traficului și lansarea

Schimbăm traficul public numai după verificarea app.swypik.com, a prezentării, autentificării, redirecturilor și backupului. Site-ul de prezentare cu înscriere poate fi lansat înainte de aprobarea magazinelor, după îndeplinirea acestor criterii.

Publicarea mobilă trece prin beta iOS/Android și verificarea cerințelor curente ale magazinelor. Testele de încărcare se fac gradual pe un mediu izolat sau pe un interval controlat; dimensionăm după utilizatori activi simultan, RPS, uploaduri și debit video, nu după numărul total de conturi. Scalarea și costurile se aprobă din rezultate, fără servere nefolosite pornite permanent.

## Ordinea imediată

Inventar și topologie finală → prototip mobil + audit autentificare/API → decizie tehnică → app.swypik.com în paralel → prezentare și beta → schimbare de trafic verificată → publicare și scalare măsurată.

Nu fixăm un termen de lansare înainte de matricea de funcții și prototip. O estimare pe etape va include dependențele de conturi, dispozitive, credențiale și revizuirea magazinelor.

## Referințe tehnice consultate

- https://capacitorjs.com/docs/config
- https://docs.expo.dev/guides/dom-components/
