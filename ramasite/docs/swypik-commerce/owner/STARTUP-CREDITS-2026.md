# Swypik — înscriere Microsoft / Google / AWS (credite cloud + AI)

Stare: pregătit 2026-09-21, verificat pe paginile oficiale ale celor 3 programe. Sumele de mai jos sunt cele **reale** pentru un startup fără investitor (bootstrapped); sumele mari din titluri (150K / 350K / 200K) sunt condiționate de un investitor/accelerator partener.

## 1. Verdict rapid (go / no-go)

| Program | Cale fără investitor | Cale cu investitor / accelerator partener | Blocaj posibil pentru Swypik |
|---|---|---|---|
| **Microsoft for Startups** | $1.000 (90 zile) + $4.000 (180 zile) după verificarea firmei; poate crește "up to $150K" pe bază de utilizare verificată | cod de referral din Investor Network → pornește la ~$100.000 | firmă înregistrată necesară pentru "business verification"; card de credit obligatoriu la activare |
| **Google for Startups Cloud – Start** | până la $2.000 (valabil 12 luni) + Workspace Business Plus 12 luni gratis + $200 Google Skills | **Scale**: $100K an 1 (100%) + $100K an 2 (20%); AI-first: $250K an 1 — doar cu finanțare VC/pre-seed/seed | **Start cere firmă fondată în ultimele 24 luni** — dacă Swypik Technology e mai veche, Start pică; clauza "companies distributing tokens" (SWYP) |
| **AWS Activate – Founders** | $1.000 la început, până la $5.000 în timp | **Portfolio**: până la $200.000 cu Org ID de la un Activate Provider | contul AWS trebuie pe "Paid Tier Plan" (card); cont Builder ID cu email profesional |

**Concluzie:** GO la toate trei pe calea self-serve — total realist ≈ **$8.000–12.000** credite + Workspace gratis. Banii mari (>$100K) vin **doar** printr-un accelerator/VC care e partener al programelor → asta e pasul 2, după ce ai cele trei conturi deschise (nu se exclud reciproc; poți urca de la Founders la Portfolio ulterior și primești diferența).

## 2. Ce îmi trebuie de la tine (goluri pe care nu le pot inventa)

Nu completez nimic fals în aplicații. Răspunde la acestea și înlocuiesc în drafturi:

1. **Entitatea juridică**: există SRL pentru Swypik? Denumire exactă, CUI, data înființării (ziua/luna/anul). Pe site apare doar "Swypik Technology", fără CUI.
   - Dacă NU există firmă: Microsoft îți dă $1.000 și fără, dar cei $4.000 și Google/AWS practic cer firmă (billing account pe firmă, verificare). Recomand SRL înainte de Google/AWS.
2. **Data fondării** — decide dacă intri la Google Start (≤ 24 luni).
3. **Finanțare**: presupun bootstrapped / fonduri proprii, zero investitori. Confirmă.
4. **Email pe domeniul swypik.com** (ex. `founders@swypik.com`) — Google **respinge** dacă emailul din aplicație ≠ domeniul site-ului ≠ emailul contului de billing. Îl ai? (poți lua Workspace gratis prin program, dar aplicația trebuie trimisă deja de pe un email @swypik.com — deci ai nevoie de măcar un mailbox pe domeniu înainte, ex. prin Cloudflare Email Routing pe care îl folosești deja).
5. **Fondator(i)**: nume, rol, LinkedIn (formularele cer profil LinkedIn al fondatorului și, opțional, al companiei).
6. **Conturi existente**: ai deja cont Azure / Google Cloud / AWS pe care s-au folosit credite sau free trial? (Microsoft: "Already redeemed" dacă contul MSA a mai luat credite; Google: "not yet received credits beyond free trial").
7. **Cifre de tracțiune pe care le pot scrie**: din CLAUDE.md văd catalog ~14.000 produse, ~4.750 videoclipuri, 7 limbi, app live la swypik.com. Confirmă că sunt actuale sau dă-mi cifrele reale (useri înregistrați, comenzi, creatori activi). Nu scriu comenzi/venituri dacă nu-mi confirmi.

## 2b. Email @swypik.com — IONOS mailbox + DNS la Cloudflare (verificat 2026-09-21)

Situația: domeniul e înregistrat la **IONOS SE** (12.08.2025), dar nameserverele sunt la **Cloudflare** (conrad/georgia.ns.cloudflare.com). **Nu există MX** → orice mail către @swypik.com se pierde acum, inclusiv `privacy@`, `support@`, `contact@`, `hello@` care apar pe site. Resend trimite de pe `send.swypik.com` (SES) — nu se bate cu IONOS.

**Pasul A — în IONOS (my.ionos.com → Email & Office):**
1. Creezi mailboxul principal: `tibor@swypik.com` (parola o setezi tu). Acesta e emailul cu care aplici la toate trei programele.
2. Creezi forward-uri (nu mailboxuri): `contact@`, `hello@`, `support@`, `privacy@` → `tibor@swypik.com`.
3. IONOS va afișa un avertisment că DNS-ul e extern — normal, îl rezolvăm în pasul B.

**Pasul B — în Cloudflare (dash.cloudflare.com → swypik.com → DNS → Records), toate cu Proxy = DNS only (nor gri):**

| Tip | Nume | Valoare | Prioritate | TTL |
|---|---|---|---|---|
| MX | `@` | `mx00.ionos.com` | 10 | Auto |
| MX | `@` | `mx01.ionos.com` | 10 | Auto |
| TXT | `@` | `v=spf1 include:_spf-eu.ionos.com include:_spf-us.ionos.com ~all` | — | Auto |
| CNAME | `s1-ionos._domainkey` | `s1.dkim.ionos.com` | — | Auto |
| CNAME | `s2-ionos._domainkey` | `s2.dkim.ionos.com` | — | Auto |
| CNAME | `s42582890._domainkey` | `s42582890.dkim.ionos.com` | — | Auto |

Note: ambele MX cu prioritate **10** (IONOS vrea round-robin, nu 10/20). SPF: IONOS.com spune `_spf-us`, contractele EU folosesc `_spf-eu` — le pun pe amândouă ca să nu ghicim contractul; se poate scoate unul după ce vedem în panoul IONOS care e. DMARC există deja (`p=none`) — rămâne. Nu atinge înregistrările existente `google-site-verification` și `resend-domain-verification`.

**Pasul C — test:** `nslookup -type=MX swypik.com 1.1.1.1` arată cele două mx; trimiți un mail de pe Gmail către `tibor@swypik.com` și îl vezi în webmail IONOS (mail.ionos.com). Apoi trimiți un mail de pe IONOS către Gmail și verifici în "Show original" că SPF=PASS și DKIM=PASS.

## 3. Pregătire comună (o dată, înainte de toate trei)

- [ ] Email profesional `@swypik.com` funcțional (primești mail pe el).
- [ ] Pagina https://swypik.com să spună clar ce e produsul pe landing (reviewerii intră pe site). Footer cu denumirea firmei + CUI (îl adăugăm în `legal/anpc` unde acum e doar "Swypik Technology").
- [ ] Profil LinkedIn fondator actualizat + pagină de companie "Swypik" pe LinkedIn (5 minute; e cerută/ajută la toate trei).
- [ ] Card de credit/debit pe firmă (toate trei cer card la activare, chiar dacă nu taxează cât ai credite).
- [ ] Un singur cont Microsoft (MSA personal, NU cont Entra/work) pentru Microsoft — creditele sunt legate permanent de contul cu care aplici.
- [ ] Hotărâm **ce workload rulăm pe fiecare cloud**, ca să nu expire creditele nefolosite (Google: 12 luni; Microsoft: activare în 90 zile, valabile 2 ani; AWS: 12–24 luni). Propunere: Azure → AI (Azure OpenAI/AI Foundry pentru moderare, chat, scor produs); Google → Gemini/Vertex pentru captions/traduceri/ranking + Workspace; AWS → Bedrock experimente + S3/transcodare video pentru Movies.

## 4. Pași pe fiecare program

### 4.1 Microsoft for Startups — https://startups.microsoft.com → "Get started"
Criterii oficiale (learn.microsoft.com): produs software deținut de firmă; privat, for-profit; sediu într-o țară cu Azure (România OK); sub $350K credite Azure gratuite pe viață; fără Series C+; nu instituție/agenție/consultanță; **nu minerit crypto**.
Pași: 1) login cu MSA personal → 2) "I don't have a referral code" → 3) completezi profilul companiei (draft mai jos) → 4) creezi subscripția Azure cu cardul → 5) review ~3 zile lucrătoare → 6) activezi creditele în max 90 zile.
Beneficii în plus de cerut din portal: GitHub Enterprise, Microsoft 365, LinkedIn Premium Business (dacă ești eligibil).

### 4.2 Google for Startups Cloud Program — https://cloud.google.com/startup/apply
Înainte: cont Google Cloud creat cu emailul @swypik.com → Billing → notezi **Billing Account ID (18 caractere)**. Aplici cu același email; site-ul, emailul și billingul trebuie să fie pe același domeniu.
Tier Start: fondată ≤ 24 luni, fără credite anterioare, "planning to seek venture funding" — spune explicit că plănuiești runda pre-seed în 2027.
Decizie: câteva zile; review manual până la 10+ zile. Dacă e respins: `cloudstartupsupport@google.com`.
Atenție: în descriere prezinți Swypik ca **social commerce**; SWYP e "internal rewards currency, not tradable, not sold" (exact cum scrie pe swypik.com/swyp). Nu-l ascunzi, dar nu e produsul.

### 4.3 AWS Activate Founders — https://aws.amazon.com/startups/credits/ → "Apply now"
Pași: 1) AWS Builder ID cu emailul @swypik.com → 2) tier **Activate Founders** (self-funded) → 3) detalii startup → 4) creezi/legi contul AWS (**alege Paid Tier Plan** la creare, nu free plan) → 5) răspuns în 5–10 zile lucrătoare.
Alternativ/în plus: "Kiro Startup Credits" (pentru startup-uri fără credite Activate curente) — merită bifat dacă apare în flux.

## 5. Drafturi de răspunsuri (EN — formularele sunt în engleză)

> Marcajele `[[ ]]` sunt goluri de completat din secțiunea 2. Nu trimite cu ele necompletate.

**Company name:** [[Swypik Technology SRL]]
**Website:** https://swypik.com
**Country / HQ:** Romania, [[oraș]]
**Founded:** [[LL/AAAA]]
**Stage:** MVP live in production (public web app + PWA), pre-seed, bootstrapped
**Funding:** Self-funded / bootstrapped, no external investors [[confirmă]]
**Industry:** E-commerce / Social commerce / Consumer marketplace
**Team size:** [[n]]
**Founder LinkedIn:** [[url]]

**One-liner (≤ 150 chars):**
Swypik is a mobile-first social commerce super-app where people discover and buy products through short creator videos.

**What does your company do? (≈ 100 words):**
Swypik is a social video commerce platform built for Romania and expanding across the EU. Shoppers discover products in a vertical short-video feed from real creators, check an AI-generated Swypik Score (quality, price, shipping, community votes), and buy in-app with Stripe. Creators earn commissions on every sale, and sellers manage their catalog and orders from a built-in seller portal. Around the core marketplace we are adding food ordering, stays, and a vertical micro-series channel ("Swypik Movies"), unified by an in-app rewards currency. The product is live at swypik.com in 7 languages, with a catalog of [[14,000+]] products and [[4,700+]] videos.

**What problem are you solving?**
Product discovery on classic marketplaces is search-driven and trust-poor: shoppers can't see products in use and can't tell honest sellers from bad ones. Video-native commerce (TikTok Shop, Douyin) solved this in Asia and the US, but there is no local, EU-compliant equivalent for Romanian and CEE consumers, creators and small sellers. Swypik gives small sellers and local creators a TikTok-Shop-style channel with transparent commissions, consumer-protection-compliant checkout (14-day returns, final price shown), and AI quality signals that reduce bad purchases.

**How will you use [Azure / Google Cloud / AWS] and AI? (adapt per program):**
Our roadmap is AI-heavy and video-heavy, which is exactly what we need credits for:
- Content moderation and safety classification of every uploaded video and product (currently a text classifier; moving to multimodal models).
- Feed ranking and personalization (event pipeline with 30+ event types, seen-video state, topic taxonomy) — we want to train/serve recommendation models instead of heuristic ranking.
- Swypik Score: LLM-based product quality scoring from listing data, reviews and community votes.
- Automatic captions, translations (7 locales) and dubbing for creator videos and the Movies micro-series.
- AI shopping assistant chat over the catalog.
- Video pipeline: transcoding to HLS, thumbnails, storage and CDN egress for thousands of clips.
Per program, name the services: *Azure* → Azure OpenAI / AI Foundry, Azure Database for PostgreSQL, Blob Storage, Container Apps. *Google* → Vertex AI + Gemini, Cloud Run, Cloud SQL, Cloud Storage, Video Intelligence / Speech-to-Text. *AWS* → Amazon Bedrock, ECS/Fargate, RDS Postgres, S3 + MediaConvert, Transcribe/Translate.

**Current tech stack (if asked):**
Next.js 15 / TypeScript front-end and API, Go platform service for video upload, Python FFmpeg video worker, PostgreSQL 16, Redis 7, Cloudflare R2 storage, Stripe payments, Docker on a Hetzner VPS. We are a small team that ships fast; cloud credits let us move the AI and video workloads off a single VPS.

**Traction / milestones (only what you confirm):**
Live product at swypik.com since [[LL/AAAA]]; [[N]] registered users; [[N]] creators onboarded; [[N]] sellers; 7 languages; native mobile wrapper (Capacitor) in progress.

**Why you / why now:**
[[2–3 propoziții despre tine: experiență anterioară în comerț/tech, de ce România/CEE, ce ai construit deja singur]]

**Plans for funding (Google Start cere asta):**
We plan to raise a pre-seed round in [[2027]] from CEE angel networks and accelerators once we reach [[țintă: X comenzi/lună sau Y creatori activi]].

## 6. Riscuri / atenție

- **Nu aplica înainte să ai unde consuma creditele.** Expiră (Google 12 luni) și nu se prelungesc. Întâi planul de workload (secțiunea 3), apoi aplicația.
- **SWYP / blockchain**: Google exclude explicit "companies distributing tokens contrary to regulatory guidance", Microsoft exclude "cryptocurrency mining". Swypik nu e nici una, dar reviewerul poate vedea pagina /swyp și explorerul scan.swypik.com. Ține descrierea din aplicație pe social commerce; dacă întreabă, răspunsul e cel de pe site: "internal rewards currency, fixed supply, not tradable, not sold, redemption limited to the backing fund".
- **Un singur cont per program**, cu emailul @swypik.com; nu amesteca conturi personale cu care ai mai luat free trial/credite.
- **Aplicațiile nu se pot edita după trimitere** (Microsoft: ștergi și retrimiți cât e pending; refuz → poți reaplica după 14 zile).
- **Referral code / Org ID**: dacă intri într-un accelerator, cere-le codul Microsoft Investor Network, Org ID-ul AWS Activate și dacă sunt partener Google — poți urca de tier și primești diferența.

## 7. Pasul 2 (după ce ai cele trei conturi): banii mari

Sumele de $100K+ nu sunt self-serve. Calea: un accelerator/VC care e **Activate Provider (AWS) / Investor Network (Microsoft) / partener Google**. Candidați de verificat pentru România/CEE (nu am confirmat statutul lor de partener — trebuie întrebați direct): Google for Startups Accelerator CEE, Techcelerator, Founder Institute România, InnovX-BCR, Rubik Garage, MVP Academy, Startup Wise Guys, Seedblink (angel network). Întrebarea de pus: "Sunteți AWS Activate Provider / aveți cod Microsoft for Startups Investor Network?"

Alte programe gratuite, fără investitor, relevante pentru Swypik (de verificat separat): NVIDIA Inception (fără cost, credite prin parteneri + training), Cloudflare for Startups (deja folosiți R2/Workers), GitHub for Startups (vine prin Microsoft), Stripe startup perks.

## Surse oficiale
- Microsoft: https://learn.microsoft.com/en-us/startups/microsoft-for-startups/overview și https://learn.microsoft.com/en-us/startups/microsoft-for-startups/mfs-faqs
- Google: https://cloud.google.com/startup/benefits și https://cloud.google.com/startup/faq
- AWS: https://aws.amazon.com/startups/credits/
