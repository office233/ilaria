# Audit Swypik, Ilaria/Nexus și SwypikOS — 27 septembrie 2026

> Actualizare ulterioară: Multi-ERP a fost retras la cererea proprietarului. Panoul nativ `/seller` este păstrat, iar ambele noduri rulează release-ul `28687e3971d1-native-seller-599f18682f02`. Detalii și verificări: [retragere Multi-ERP](2026-09-27-multi-erp-retirement.md). Restul constatărilor de mai jos descriu auditul inițial.

## Verdict

Swypik are cod și teste consistente, iar site-ul public este acum servit de Azure.
Produsul nu este complet funcțional pentru lansare comercială: lipsesc credențiale
reale pentru email și Stripe, configurarea apelurilor, conținutul public și unele
servicii auxiliare. Nu există o demonstrație de capacitate pentru milioane de
utilizatori. Testele automate nu certifică fluxurile externe sau performanța la scară.

Audit efectuat pe cod, istoricul Claude Code, Azure CLI autentificat, containere,
baze de date, HTTP public și browser. Nu s-au efectuat plăți, trimis emailuri,
publicat conținut sau rulat teste de încărcare asupra producției.

## Ce există și ce a făcut Claude

| Proiect | Locație și stare |
|---|---|
| Swypik | `E:\Swypik\swypik\app`; `D:\Swypik` conține doar nota de mutare |
| Ilaria/Nexus | `D:\nexus`, repo Go + forjă Python, HEAD `3d289ea`; există modificări neversionate preexistente, păstrate |
| SwypikOS | `D:\swypik-os`, proiect Go fără repository Git în acel director |
| Swypik Browser | `D:\swypik-browser`, Electron 33 în package.json, module Go; fără Git local |
| Nexus Browser | `D:\nexus-browser`, serviciu Go + interfață web; fără Git local |

Istoricul exact al coordonării migrării este în
`C:\Users\Pos5\.claude\projects\E--\6301a64c-7d3c-4b29-93b7-931505afddd6.jsonl`.
Mesajele relevante declară modelul `claude-opus-5-5`. Pe 25 septembrie, la 17:40 UTC,
Claude a început cutover-ul; la 17:43 a raportat restaurarea, la 17:44 a constatat
că migrările nu se aplicaseră, iar la 17:48 istoricul se încheie cu limita săptămânală.
Aceasta explică întreruperea, dar starea reală a bazei a fost verificată separat.

Istoricul Nexus este în `C:\Users\Pos5\.claude\projects\D--nexus\`;
predarea tehnică este `D:\nexus\docs\handoff\2026-09-25-azure-handoff.md`.
Nu reproduce istoricul brut în rapoarte publice: poate conține informații private.

Commiturile Swypik recente includ infrastructura Bicep/Compose Azure, mutarea media
pe R2, Azure AI, sesiuni/cache/cozi pentru replici, Cloudflare Realtime, arhivarea
datelor demo, indexuri SQL, cache public, preîncărcarea feedului, Web Vitals și k6.
Release-ul de pe ambele noduri Azure este `28687e3971d18e97d6fdb4e2d2c0bf7f0e4a9f23`.

## Incidentul reparat în această sesiune

La început, `https://swypik.com/api/health` răspundea 502. Aplicația web WSL era oprită,
dar conectorul WSL era activ. Cele două aplicații Azure erau sănătoase, conectate
însă la alt tunel decât cel indicat de domeniul principal.

1. Conectorul WSL `cloudflared` a fost oprit și dezactivat. Copia locală a datelor
   și containerele au fost păstrate. Dispatch și platform-api WSL au fost de asemenea
   oprite pentru a nu continua lucrul pe copia veche. DB/Redis/MinIO și alte servicii
   auxiliare locale au fost păstrate; distro-ul nu a fost șters.
2. Pe ambele noduri Azure, conectorul `cloudflared-swypik` folosește acum tunelul
   istoric indicat de DNS, prin `/etc/cloudflared/public-config.yml` și drop-in-ul
   `/etc/systemd/system/cloudflared-swypik.service.d/public-tunnel.conf`.
   Credențialele au fost transferate direct prin SSH, fără afișare sau Git.
3. Configurația tokenului Azure a fost păstrată. Un serviciu separat,
   `cloudflared-swypik-preview`, pe web-1, păstrează accesul la `next.swypik.com`.
   **next.swypik.com folosește producția; nu este staging izolat.**
4. Test de failover: primul conector public a fost oprit temporar; răspunsul public
   a venit cu HTTP 200 de la containerul `1069a2ffdcd4` de pe web-2. Web-1 a fost
   repornit și verificat. Nu este un test de pierdere a zonei sau bazei de date.
5. `api.swypik.com/healthz` răspunde 200; `next.swypik.com/api/health` răspunde 200.
   `erp.swypik.com/api/health` rămâne 502. Ruta veche CDN/MinIO nu a fost reactivată;
   răspunde 404 la rădăcină, iar media nouă trebuie să folosească R2/CDN configurat.

Scripturile operaționale și rezultatele testelor sunt în
`E:\Swypik\audit-20260927`. Nu conțin valorile secretelor. Scripturile au fost
scrise pentru inventarul verificat în această sesiune; nu sunt un installer generic.

## Infrastructura și datele verificate

| Rol | VM | Dimensiune | Stare |
|---|---|---|---|
| Web 1 | swypik-prod-web-1 | Standard_D2as_v7 | Next.js + Go sănătoase |
| Web 2 | swypik-prod-web-2 | Standard_D2as_v7 | Același release, sănătos |
| Date | swypik-prod-data | Standard_E2as_v7 | PostgreSQL Swypik, Redis și PostgreSQL ERP sănătoase |
| Video | swypik-prod-worker-1 | Standard_D2as_v7 | Worker sănătos, procesarea completă a unui upload nou neverificată |

Toate cele patru VM-uri sunt în **Sweden Central, zona 1**. PostgreSQL este în Docker,
nu Azure Database for PostgreSQL Flexible Server. Redis este tot în Docker. Documentul
`D:\nexus\DE_CITIT_URGENT_CLAUDE_OPUS.md` afirmă existența Flexible Server; inventarul
Azure actual și containerele nu confirmă această afirmație pentru Swypik.

Baza Azure: 56 utilizatori, 254 tabele publice, 259 intrări în schema_migrations,
ultimul nume `20260927_0030_perf_indexes`. Toate cele 249 de fișiere SQL prezente în
repo sunt înregistrate; încă 10 identificatori istorici nu au fișier cu numele exact.
Registrul nu este o dovadă suficientă că fiecare efect SQL este corect: scriptul
istoric `ops/cutover-db.sh` maschează erori înainte de inserarea în registru.

Baza WSL are 200 intrări de migrare și nu trebuie repusă online ca sursă de scriere.
Nu au fost restaurate date peste producție în această sesiune.

## Backup și restaurare verificate

Pe nodul data au fost instalate:

- `/etc/swypik-backup.env`, acces root, cu credențialele bucketului privat deja existent;
- AWS CLI într-un mediu Python separat, `/opt/swypik/backup-venv`;
- `/usr/local/sbin/swypik-backup-r2.sh` și `swypik-backup-all.sh`;
- `swypik-db-backup.service` și timerul zilnic `swypik-db-backup.timer`, ora 03:15
  Europe/Bucharest plus maximum cinci minute întârziere aleatoare, Persistent=true.

Primul backup al ambelor baze a trecut: Result=success, ExecMainStatus=0.
Backupul Swypik a fost descărcat din R2, verificat gzip și restaurat cu
ON_ERROR_STOP într-o bază temporară separată. Comparație sursă/restaurare:
`users|migrations|orders|videos = 56|259|13|12`. Baza temporară a fost eliminată
după verificare; baza de producție nu a fost modificată.

SHA-256 al obiectului restaurat:
`82eb5a221b4f6826f791949650e980794fcb64e4a27a52ff6bcc0aa737520c77`.
Restaurarea Multi-ERP nu a fost testată. Ștergerea automată a backupurilor vechi
este dezactivată în wrapper (retenție 0); trebuie stabilită politica lifecycle.
Backupul zilnic nu oferă PITR și poate pierde modificările dintre două backupuri.

## Rezultatele verificărilor

| Verificare | Rezultat |
|---|---|
| TypeScript Swypik | Trecut |
| Vitest Swypik | 1.911/1.911, 201 fișiere; raport JSON salvat |
| Prima rulare Vitest | 1 timeout la scanarea fișierelor; testul izolat și apoi suita completă cu maxWorkers=2 au trecut |
| ESLint / i18n | Trecut cu avertismente lint existente; 7 locale, 6.326 chei |
| Next.js production build | Trecut, Next.js instalat 15.5.22 |
| Buget bundle | Trecut, 174 rute; maxim ~268,8 KB gzip în raportul bugetului |
| Worker video / AI Python | 157 + 7 teste trecute |
| API Go Swypik | go test trecut; mai multe pachete nu au teste |
| Ilaria/Nexus | go vet și go test -count=1 -timeout 180s ./... trecute |
| Forjă multimodală Nexus | 29 teste Python trecute, avertismente de depreciere |
| SwypikOS | go test ./... trecut; acest lucru nu validează un OS bootabil sau performanțele promise |
| Cele două browsere Go | Compilare prin go test reușită, pachetele raportate nu au teste |
| HTTP public | 12 rute verificate: health, ro/en, explore, shop, movies, music, news, gaming, categories/products/feed — toate 200 |
| Browser | Navigare acasă → descoperă → magazin funcțională; stări explicite fără clipuri și fără produse |
| Corecții gate deploy | 9 teste de regresie Linux/WSL trecute și bash -n trecut |

Corecțiile locale de pe branch-ul `agent/audit-azure-20260927` resping placeholder-ele
din preflight și verifică HTTP 2xx, commit exact, DB/Redis/storage și Go health înainte
ca deploy-ul să considere un nod disponibil. Testele infra sunt incluse și în
`npm run test:workers`. Aceste schimbări de cod/documentație nu au fost publicate
în GitHub sau distribuite nodurilor; release-ul live rămâne `28687e39`.

## Blocaje și constatări prioritare

1. **Email și plăți:** RESEND_API_KEY, STRIPE_SECRET_KEY și STRIPE_WEBHOOK_SECRET sunt
   placeholder. SMTP lipsește. OTP prin email și checkoutul Stripe nu sunt validate
   end-to-end. În baza verificată sunt 13 comenzi, toate `failed`; nu atribuim toate
   cauzele acestora exclusiv configurației fără analiza fiecărei erori.
2. **Health incomplet:** `/api/health` poate declara healthy când emailul e degradat,
   deoarece statusul global urmărește doar DB. `lib/email/transport.ts` returnează
   true când nu există provider. Aceste comportamente nu certifică trimiterea emailului.
3. **Cron și ERP:** nu există cron-worker Azure pornit și nici backend ERP/imagine/clonă
   în inventarul web-1 verificat. Baza ERP există, dar migrarea aplicației și a fișierelor
   nu este completă. Nu am pornit automat joburi de email, plăți sau publicare de știri.
4. **Apeluri:** RealtimeKit APP_ID/API_TOKEN și activarea clientului lipsesc. Messenger
   pornit ca modul nu demonstrează apeluri funcționale.
5. **Conținut:** 12 clipuri, toate ascunse; marcajul migrării de arhivare demo există.
   Magazinul afișează zero produse. Nu am reactivat date demo sau inventat conținut.
6. **Disponibilitate:** un singur nod DB/cache și o singură zonă pentru toate VM-urile.
   Două noduri web nu elimină acest punct comun de defectare.
7. **Documentație exagerată:** SwypikOS declară bare-metal/zero web/50 ms/25 MB, însă
   entrypoint-ul spune Windows Desktop Shell + Embedded Web UI. `core/ilaria/ilaria.go`
   clasifică prin cuvinte-cheie și returnează texte fixe; nu este motorul Nexus încărcat.
   Browserul Swypik folosește Electron. Aceste componente sunt prototipuri distincte.
8. **AI Linux:** driverele dinamice GPU Nexus au build tag `gpu && windows`. Mutarea pe
   Linux nu oferă automat inferență Go pe GPU. Forja Python are teste trecute, dar
   antrenările, artefactele și benchmarkurile istorice nu au fost rerulate pe GPU.
9. **Versiuni și recuperare:** proiectele OS/browser nu au istoric Git local; fișierele
   experimentale Nexus erau deja neversionate. Trebuie repository și release-uri
   reproductibile înainte de distribuirea către utilizatori.

## Cost și dimensionare

Tarife publice USD pay-as-you-go, citite la 27.09.2026 prin Azure Retail Prices API,
Sweden Central, Linux, 730 ore/lună. Nu reprezintă factura, creditele rămase sau un
discount contractual. Nu au fost create VM-uri ori mărite dimensiuni în acest audit.

| Componentă | Calcul lunar |
|---|---:|
| 3 × D2as v7 (web×2, worker) | 3 × 0,097 × 730 = 212,43 USD |
| 1 × E2as v7 (date) | 0,128 × 730 = 93,44 USD |
| 3 × E6 Standard SSD 64 GiB | ~14,40 USD, fără operații/mount suplimentare |
| P4 Premium OS 32 GiB | ~5,81 USD |
| Premium SSD v2 256 GiB | ~20,56 USD capacitate; inventar 3.000 IOPS/125 MB/s |
| 2 IP-uri Standard | ~7,30 USD |
| Subtotal verificat, fără NAT | ~353,93 USD |

NAT Gateway, procesarea traficului, egress, operațiile discurilor, AI și serviciile
Cloudflare se adaugă. Rezervă de planificare: **~390–450 USD/lună pentru infrastructura
de bază la trafic mic**, de recalculat cu contorizarea reală; AI/media/live pot depăși
această valoare. Tariful regional NAT nu a fost confirmat în răspunsurile API folosite,
de aceea intervalul nu este prezentat ca total exact. Alerta existentă în resource
group este **450 USD/lună**; nu este o oprire automată și nu a fost schimbată.

Surse: [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices),
[prețuri NAT](https://azure.microsoft.com/en-us/pricing/details/azure-nat-gateway/).
Soldul și expirarea creditelor nu au fost verificate în evidența de sponsorship.

## Plan pentru creștere și mobile

Păstrează trei produse cu responsabilități separate: backendul Swypik servește web,
iOS și Android; Ilaria rămâne serviciu AI cu limite și evaluări proprii; SwypikOS este
un proiect ulterior. Swypik nu trebuie să depindă de disponibilitatea PC-ului sau de
un antrenament AI pentru login, catalog și comenzi.

„Un milion de utilizatori” trebuie definit: conturi, MAU, DAU sau simultani.
Exemplu pur de dimensionare: 1.000.000 MAU × 20% DAU × 100 cereri API/zi =
20.000.000 cereri/zi, ~231 cereri/s medie; un vârf de 10× înseamnă ~2.315 cereri/s.
La 30 minute video/DAU/zi și 1 Mbit/s rezultă ~45 TB/zi livrate prin CDN, înainte
de overhead. Nu sunt măsurători ale aplicației și nu reprezintă un buget aprobat.

Ordinea recomandată:

1. Închide blocajele de email, plăți, apeluri și conținut. Verifică în staging OTP,
   sesiuni pe ambele replici, upload → transcodare → HLS, checkout/webhook/refund în
   sandbox, roluri, ștergerea contului și raportarea/blocarea utilizatorilor.
2. Creează staging cu DB, bucket, cozi, chei Stripe și furnizori de test separați.
   `next.swypik.com` nu îndeplinește aceste condiții. Scenariile existente sunt în
   `tests/load/k6`; faptul că există fișiere nu înseamnă că testele de încărcare au trecut.
3. Măsoară 50/200/1.000+ cereri/s gradual, pe date reprezentative, cache rece/cald,
   navigare autentificată, feed, scrieri, upload și backlog. Acceptarea se bazează pe
   p95/p99, erori, conexiuni DB, CPU/RAM, lock-uri și cost per utilizator activ.
4. Pentru disponibilitate mai mare: noduri în zone diferite, PostgreSQL cu HA/PITR
   și restaurare periodică, PgBouncer, replici de citire doar unde consistența permite,
   cache/cozi dimensionate separat, alerte externe și monitorizare de buget.
   [Azure PostgreSQL reliability](https://learn.microsoft.com/en-us/azure/reliability/reliability-database-postgresql)
   descrie opțiunile de redundanță; alegerea se face după trafic și buget.
5. Pentru distribuție controlată a traficului, folosește load balancing cu health
   checks ale aplicației. Replicile aceluiași Cloudflare Tunnel oferă redundanță de
   conector, fără garanția unei distribuții uniforme sau a sănătății aplicației.
   [Documentație Cloudflare](https://developers.cloudflare.com/tunnel/configuration/).
6. Mobile: contract API versionat, sesiuni/tokenuri potrivite dispozitivelor,
   Keychain/Keystore, notificări APNs/FCM, deep links, upload reluabil, player nativ,
   moderare, accesibilitate și crash reporting. Construiește o secțiune verticală
   login → feed → produs → checkout înainte de toate modulele.
7. Vânzarea bunurilor fizice și deblocarea filmelor/muzicii sunt fluxuri diferite.
   Pentru conținut digital trebuie proiectat billing-ul și drepturile de acces după
   regulile magazinelor și programele regionale aplicabile, nu copiat automat Stripe
   din web: [Apple](https://developer.apple.com/app-store/review/guidelines/),
   [Google Play](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en).
8. SwypikOS: stabilește dacă produsul este shell desktop, distribuție Linux sau OS
   independent; apoi integrare reală Ilaria, sandbox pentru execuție, actualizări
   semnate, rollback, teste hardware și măsurători. Folderul mobile/bridge actual nu
   este o aplicație iOS/Android completă.

## Ce rămâne necesar de la owner și ce nu este certificat

Cheile reale Stripe/Resend (sau SMTP), configurarea RealtimeKit și decizia de produs
pentru modulele lansate sunt necesare înainte de testele complete. Se configurează
în canalul de secrete al infrastructurii, nu în chat sau Git. Bugetul se decide după
acest audit; răspunsul ownerului a fost „Stabilim după audit și estimarea actualizată”.

Nu sunt certificate: toate fluxurile UI, aplicațiile mobile, procesarea plăților,
livrarea emailurilor, apelurile/live, integrarea ERP, toate efectele migrărilor SQL,
capacitatea la scară, securitatea completă, benchmarkurile AI sau bootarea unui OS.
Raportul distinge explicit aceste limite de testele și reparațiile efectuate.
