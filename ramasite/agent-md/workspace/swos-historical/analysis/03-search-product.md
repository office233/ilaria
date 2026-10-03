# SWOS-000 / M0 — Search Systems + Product/Runtime Audit

**Rol:** search systems + product/runtime auditor  
**Data:** 2026-09-28  
**Checkout auditat:** E:/nexus/swypik-os  
**Repo:** E:/nexus  
**Baseline verificat:** main @ 96290fa  
**Mod de lucru:** strict read-only în E:/nexus/swypik-os. Singura scriere permisă și efectuată este acest raport.

## 0. Verdict executiv

SwypikOS are astăzi un **motor de căutare propriu real**, nu un wrapper DuckDuckGo/Google/Bing/Brave: crawler HTTP(S) propriu, protecție SSRF, robots gate, extracție HTML, index inversat persistent, BM25F lexical, indexare de fișiere locale și integrare reală în desktop, în agent și în serviciul Linux. Acesta este însă un **motor local / user-seeded de ordinul zecilor de mii de documente**, nu un crawler de Internet și nu o arhitectură distribuită.

Produsul Windows actual este mult mai mic și mai onest decât suprafața istorică a repository-ului: **Home + Chat + Agent + Search + Files + Compute + Settings** sunt tab-urile reale ale desktopului nativ. Search, Files, Chat, agentul approval-gated și setările sunt conectate. Compute este inventar GPU + consent/config, fără coordinator. Nu există în runtime-ul actual browser intern, computer-use/UI Automation, editor complet, LSP, MCP client nativ, App Store real, notificări OS, Sheets/Docs apps sau proactive automation.

Pentru valoare reală incrementală nu trebuie urmărit imediat „Google-scale”. Ordinea corectă este:

1. transformați motorul actual într-un **vertical/local search foarte bun și măsurabil**;
2. adăugați **freshness, dedupe, query language, index on-disk segmentat și evaluări de relevanță**;
3. adăugați **hybrid lexical + semantic/vector**;
4. abia apoi introduceți frontier distribuit, workers, sharding și multi-host Internet crawling;
5. păstrați o linie clară între capabilitățile reale din runtime și prototipurile istorice.

Un risc major de produs este **documentația divergentă**: unele documente descriu Electron, limite vechi ale motorului sau capabilități deja eliminate. Pentru M0 „Truth”, HEAD-ul și import graph-ul trebuie să prevaleze.

---

# 1. Surse și regula de adevăr

Au fost citite și reconciliate:

- E:/CEO/specs/mission-swypikos-ilaria.md
- E:/CEO/projects/swos/m0/A-swypikos-audit.md
- docs/OWN_SEARCH.md
- docs/AGENTIC_CAPABILITIES.md
- codul live din core/search
- ui/desktop
- ui/engine
- core/service
- core/notifications
- core/docs
- core/sheets
- core/proactive
- core/worldmodel
- mobile/bridge
- core/appstore
- cmd/swypik-os
- core/agent și wiring relevant
- documentația desktop curentă și istorică relevantă

Când documentația și HEAD-ul diferă, acest audit consideră codul curent + import graph + testele rulate drept source of truth.

---

# 2. Harta runtime-ului Search actual

Fluxul real pe Windows este:

**cmd/swypik-os**
→ deschide **search-index.jsonl**
→ creează **core/search.Engine**
→ îl injectează în **ui/desktop.Controller**
→ îl expune agentului ca tool **search.query**
→ UI permite:
- query lexical;
- indexare locală prin /index;
- crawl explicit prin /crawl URL [pagini], după confirmare.

Dovezi:
- cmd/swypik-os/main_windows.go:187-200 — index persistent + migrare legacy.
- cmd/swypik-os/main_windows.go:213-237 — SearchTool + controller wiring.
- ui/desktop/controller.go:461-528 — /index, /crawl, query.
- core/service/service.go:26-62 — agent tool search.query, fără crawl implicit.
- core/service/service.go:114-131 — API search/crawl pentru sesiunea nativă Linux.

Motorul nu face metasearch. Nicio interogare normală nu este trimisă la Google, Bing, DuckDuckGo sau Brave.

---

# 3. Audit Own Search Engine

## 3.1 Matrice current-state

| Componentă | Stare | Ce există azi | Gap principal |
|---|---|---|---|
| Own corpus / own index | **REAL** | Documentele provin din index local propriu | Nu există corpus Internet persistent larg |
| Crawler | **REAL, bounded** | HTTP(S), same-origin, user-triggered, secvențial | Nu este crawler multi-host / distribuit |
| Frontier | **PROTOTYPE local** | Queue in-memory, max 512, visited in-memory | Fără frontier durabil, host queues, leasing |
| Robots | **REAL partial** | UA selection, allow/disallow, wildcard, longest match | Nu este implementare completă RFC 9309; fără cache/sitemap/crawl-delay policy |
| SSRF / network safety | **REAL și bun pentru scope-ul actual** | DNS validation, public IP only, proxy off, validated IP dial | Trebuie extins la scheduler distribuit și DNS/IP churn |
| URL canonicalization | **PARTIAL** | Scheme/host lowercase, default ports, fragment removal | Fără rel=canonical, redirect alias graph, param policy |
| HTML parsing | **REAL** | golang.org/x/net/html tokenizer tolerant | Fără DOM extraction/rich fields/structured metadata |
| Charset | **REAL** | x/net/html/charset, header/BOM/meta | Bun baseline; trebuie observabilitate pe failures |
| noindex/nofollow | **REAL** | Meta + X-Robots-Tag, link rel=nofollow | Extindere pentru directive complete/policy |
| Exact URL upsert | **REAL** | URL este document identity | Nu este dedupe cross-URL |
| Content dedupe | **MISSING** | SHA folosit pentru no-op pe același URL | Fără duplicate cluster / near-duplicate |
| Freshness | **MISSING ca sistem** | FetchedAt este stocat | Fără recrawl scheduler, TTL, conditional GET |
| Spam/quality | **MISSING** | Nicio clasificare de spam/quality | Necesită quality signals și abuse pipeline |
| Lexical ranking | **REAL** | BM25F title/body + coordination + prefix | Fără positions, phrase, fields, graph/freshness quality |
| Query language | **MINIMAL** | term matching + prefix pe ultimul termen | Fără phrase, boolean, site:, type:, date, filters |
| Semantic/vector | **MISSING** | Niciun embedding / ANN | Necesită vector index + hybrid fusion |
| Hybrid retrieval | **MISSING** | Doar lexical | BM25F + vector + rerank ulterior |
| Persistence | **REAL, single-process** | Append-only JSONL, fsync, replay, repair, compaction | Nu este index segmentat/scalabil |
| Crash handling | **REAL partial** | Torn tail repair, corruption quarantine | Fără manifest/segment transaction model |
| Scale | **LOCAL** | cap 20.000 docs, all-in-memory postings | Nu scalează la milioane fără redesign |
| Distributed search | **MISSING** | — | Frontier service, workers, shards, replicas, router |
| Observability | **MINIMAL** | latencyMs + crawl counters/errors + logs | Fără metrics/traces/SLO/eval dashboard |
| Abuse controls | **PARTIAL** | consent, SSRF, size/time/queue bounds | Fără takedown, blocklists, crawl traps, distributed quotas |

---

# 4. Crawler: ce este real

## 4.1 Bounds și comportament

Codul actual, nu documentația veche:

- User-Agent: **SwypikBot/0.2 (+own index; respects robots.txt)**.
- MaxCrawlPages = **64**.
- Frontier in-memory max = **512** URLs.
- Pagină maximă = **2 MiB**.
- robots.txt maxim = **512 KiB**.
- Un singur crawl activ pe Engine prin crawlMu.TryLock.
- Crawl secvențial, 1 conexiune per host.
- Delay production = **1 secundă** între fetch-uri.
- HTTP client timeout = 15 secunde.
- Context de crawl = 5 minute.
- UI desktop pornește implicit /crawl la **16 pagini**, nu 8.

Dovezi: core/search/crawl.go:22-29, 144-179 și ui/desktop/controller.go:479-510.

Acesta este un crawler controlat și rezonabil pentru un index user-seeded. Nu este frontier de Internet.

## 4.2 Network/SSRF hardening

Puncte bune:

- numai HTTP/HTTPS;
- porturi web standard;
- reject credentials în URL;
- environment proxy dezactivat;
- DNS rezolvat înainte de dial;
- orice răspuns DNS non-public oprește request-ul;
- dial către IP-ul validat, reducând DNS rebinding;
- private/loopback/link-local/CGNAT/documentation/transition ranges blocate;
- redirects manuale.

Dovezi: core/search/crawl.go:39-71, 90-153.

Pentru crawling distribuit ulterior trebuie păstrată aceeași proprietate de securitate în worker, nu mutată doar în scheduler.

## 4.3 Robots

Implementarea actuală:

- citește robots înainte de pagini;
- permite redirect către preferred origin http→https / example↔www, limitat;
- doar 404/410 înseamnă „robots absent”;
- 403/429/5xx opresc crawl-ul;
- alege SwypikBot peste wildcard;
- allow/disallow;
- wildcard;
- longest-match și allow la egalitate.

Dovezi: core/search/crawl.go:221-250, 359-436.

Ce lipsește pentru producție:
- parser/policy complet RFC 9309;
- robots cache cu expiry;
- sitemap directives;
- politică explicită Retry-After / 429;
- scheduling per host;
- audit al deciziei robots;
- re-evaluare periodică;
- management al schimbării de policy între recrawl-uri.

---

# 5. Canonicalization, extraction și document identity

## 5.1 URL canonicalization existent

core/search/crawl.go:39-71 normalizează:
- scheme;
- hostname;
- porturile default;
- fragment;
- empty path.

Nu implementează:
- HTML link rel=canonical;
- alias-uri rezultate din redirect permanent;
- tracking parameter policy;
- duplicate query ordering/normalization semantică;
- session IDs / crawl-trap parameters;
- canonical clusters.

Concluzie: **normalizare URL există; canonical document identity completă nu există**.

## 5.2 HTML parsing

OWN_SEARCH.md este în urmă față de HEAD.

Codul actual folosește:
- golang.org/x/net/html;
- tokenizer tolerant pentru HTML real;
- charset.NewReader pentru header/BOM/meta;
- title;
- visible text;
- base href;
- robots meta;
- links;
- rel=nofollow;
- excludere script/style/noscript/template/svg/iframe/object/head/select.

Dovezi: core/search/extract.go:8-9, 21-131; core/search/crawl.go:299-319.

Lipsesc pentru un search engine mai serios:
- canonical link;
- language detection;
- headings ca fields separate;
- anchor text ca signal;
- structured data/schema.org;
- publication/update timestamps;
- author/site identity;
- boilerplate/main-content extraction;
- richer MIME pipeline;
- PDF/DOCX/Office;
- JS-rendered content, dacă va fi vreodată justificat.

Nu recomand browser rendering ca P0. Pentru un vertical search, static HTML bine extras + sitemaps produce mai multă valoare per cost.

---

# 6. Dedupe și freshness

## 6.1 Ce există

UpsertMany evită rescrierea dacă **același URL** are:
- același SHA256;
- același title.

Dovezi: core/search/search.go:402-443.

Crawler-ul șterge documente întâlnite ca:
- 404/410;
- noindex.

Indexarea locală șterge fișiere dispărute după un walk complet.

## 6.2 Ce lipsește

Nu există:
- global content hash → canonical doc cluster;
- exact duplicate dedupe între URL-uri;
- near-duplicate SimHash/MinHash;
- redirect aliases;
- version history;
- ETag;
- If-None-Match;
- Last-Modified / If-Modified-Since;
- recrawl priority;
- decay/freshness ranking;
- sitemap lastmod;
- deletion sweep pentru URLs care nu mai sunt redescoperite;
- „seen but blocked” lifecycle robust.

Pentru un vertical useful search, acestea sunt mai importante decât AI summaries.

---

# 7. Ranking și query language

## 7.1 Ranking real

Search folosește o variantă BM25F:
- titleWeight = 3.0;
- titleB = 0.5;
- bodyB = 0.75;
- k1 = 1.2;
- IDF;
- normalizare field length;
- multiplicator de coordination pentru numărul de query groups potrivite;
- prefix expansion pe ultimul termen cu weight 0.5;
- top 20 rezultate.

Dovezi: core/search/search.go:24-30, 505-587.

Tokenizer:
- NFKD;
- lower-case;
- eliminare combining marks;
- folding suplimentar;
- Unicode letters/numbers;
- max term 64 bytes.

Dovezi: core/search/analyze.go:10-46.

Este un baseline lexical legitim.

## 7.2 Limitări structurale

Postings păstrează doar frecvență title/body, nu poziții. Prin urmare nu există:
- phrase search;
- proximity;
- exact field position;
- proper snippet passage scoring bazat pe positions.

Nu există:
- AND/OR/NOT explicit;
- quoted phrases;
- site:;
- host:;
- path:;
- filetype/type:;
- before:/after:;
- language:;
- local/web scope ca operator;
- typo correction;
- stemming;
- synonyms;
- query rewriting;
- entity-aware retrieval.

Acestea ar trebui adăugate înainte de a pretinde „search competitor”.

---

# 8. Semantic / vector / hybrid

În core/search nu există în HEAD:
- embeddings;
- vector store;
- ANN/HNSW;
- semantic similarity;
- reranker;
- hybrid fusion.

Prin urmare „semantic search” nu trebuie atribuit motorului actual.

## 8.1 Arhitectură recomandată

Nu înlocui BM25F cu embeddings. Construiți:

1. **Lexical retriever** — postings + positions + BM25F.
2. **Vector retriever** — embedding per chunk/document și ANN.
3. **Fusion** — RRF sau weighted fusion calibrat pe eval set.
4. **Rerank** — opțional, numai top-K, după ce există benchmark.
5. **Answer synthesis** — separat de retrieval, cu provenance obligatoriu.

Engine-ul rămâne „own search engine” deoarece corpusul, crawl-ul, indexul, retrieval-ul, ranking-ul și serving-ul sunt proprii. Nu este necesar să interogați un motor extern.

Pentru local/private vertical search, embeddings pot rula local prin Ilaria sau un model dedicat, dar indexul vectorial trebuie să aibă contract separat de model pentru a putea schimba encoderul și versiona embeddings.

---

# 9. Persistence și scale

## 9.1 Ce este real

Current Engine:
- append-only JSONL versionat;
- replay la startup;
- torn-final-line repair;
- quarantine la corupție;
- compaction;
- fsync la batch writes/deletes;
- document map + postings în memorie.

Dovezi: core/search/search.go:93-130, 133-226, 236-301, 396-463.

Este bun pentru un index local mic și inspectabil.

## 9.2 De ce nu scalează

Limita explicită este **20.000 documente**: core/search/search.go:24-30.

Mai important decât limita hard-coded:
- fiecare URL este string-key în mai multe map-uri;
- postings sunt nested Go maps;
- întregul index lexical este reconstruit în RAM la replay;
- startup cost crește cu tot corpusul;
- query-ul ia **exclusive Engine mutex**, nu RLock, pentru prefix vocabulary rebuild;
- query-urile se serializează și blochează ingest;
- nu există immutable segments;
- nu există compressed postings;
- nu există numeric doc IDs;
- nu există memory mapping;
- nu există background merge;
- nu există query/ingest isolation;
- nu există shard boundaries.

Pentru 100k–1M documente trebuie schimbat storage model înainte de a crește MaxDocuments.

## 9.3 Ținta storage v2

Recomand un index propriu pe **immutable segments**:

- manifest versionat;
- document table cu numeric docID;
- term dictionary;
- compressed postings;
- positions;
- field stats;
- forward metadata;
- tombstones;
- segment merge;
- atomic manifest swap;
- recovery prin manifest + checksum;
- query peste N segmente;
- background compaction;
- independent vector segments.

Aceasta păstrează controlul asupra engine-ului și elimină dependența de all-in-memory maps.

---

# 10. Distributed architecture — ce lipsește

Nu există astăzi:
- persistent crawl frontier;
- URL leases;
- host buckets;
- crawl workers;
- fetch result queue;
- content/blob store;
- indexer workers;
- segment builders;
- shard assignment;
- replica management;
- query router;
- distributed merge;
- query/result cache;
- service discovery;
- capacity planner;
- backpressure;
- cluster control plane.

Pentru Internet-scale, arhitectura minimă devine:

**Seeds / sitemaps / discovery**
→ **Durable Frontier**
→ **Host-aware Scheduler**
→ **Fetcher Workers**
→ **Parser / Canonicalizer / Dedupe**
→ **Content Store**
→ **Indexer**
→ **Lexical Segments + Vector Segments**
→ **Shard Replicas**
→ **Query Router**
→ **Hybrid Retrieval**
→ **Rerank**
→ **Results + provenance**

SwypikOS M1 task kernel poate deveni ulterior schedulerul de jobs, dar crawl semantics nu trebuie amestecată cu agent planning. Crawlerul are nevoie de scheduling deterministic și leases, nu de LLM pentru fiecare URL.

---

# 11. Observability și relevancy evaluation

## 11.1 Ce există

- Search Result include latencyMs.
- CrawlReport include fetched/indexed/skipped/errors.
- desktop loghează startup/index warnings.
- teste deterministe validează multe invariants.

Acestea sunt utile, dar nu reprezintă observability de search production.

## 11.2 Ce trebuie măsurat

### Crawl
- fetch/sec;
- bytes/sec;
- queue depth;
- queue age;
- per-host next eligible time;
- DNS failures;
- robots decisions;
- 2xx/3xx/4xx/429/5xx;
- Retry-After;
- parse failures;
- content type;
- duplicates;
- canonical clusters;
- noindex/deletes;
- recrawl lag.

### Index
- documents;
- unique terms;
- segment count/size;
- postings bytes;
- merge time;
- ingest latency;
- RAM/CPU/IO;
- corruption/recovery events.

### Query
- QPS;
- p50/p95/p99;
- candidate counts;
- lexical/vector contribution;
- zero-results rate;
- timeout/error rate;
- cache hit rate.

### Quality
- Recall@K;
- MRR;
- nDCG@K;
- Precision@K;
- zero-result success/failure taxonomy;
- freshness errors;
- duplicate-result rate;
- judged spam rate.

Primul benchmark trebuie să fie un **golden corpus + relevance judgments**, nu un demo vizual.

---

# 12. Abuse, safety și crawler governance

Punctele bune actuale:
- explicit user consent;
- fixed bounds;
- no cookies/credentials/forms/scripts;
- no proxies;
- SSRF defenses;
- same-origin crawl;
- robots-first.

Pentru un crawler larg lipsesc:
- per-host global rate limits;
- Retry-After;
- crawl trap detection;
- max URL depth/pattern budgets;
- domain/IP blocklists;
- malware/content safety handling;
- decompression bomb policy dacă se adaugă compression;
- abuse/takedown process;
- owner opt-out/removal;
- legal/policy audit trail;
- crawl identity/contact endpoint;
- deletion propagation către replicas/cache/vector index;
- distributed SSRF policy enforced la worker.

---

# 13. Drift de documentație detectat

## 13.1 OWN_SEARCH.md este parțial stale

Documentația declară valori și implementări mai vechi.

| Subiect | OWN_SEARCH.md | HEAD real |
|---|---|---|
| Max documents | 1.000 | **20.000** |
| Max extracted text | 32 KiB | **16 KiB** |
| Max crawl pages | până la 32 | **64** |
| UI crawl default | 8 | **16** |
| Page limit | 1 MiB | **2 MiB** |
| HTML parser | descris ca parser static/limitat | **x/net/html tokenizer** |
| Charset | declarat work remaining | **charset.NewReader implementat** |
| Persistence | snapshot JSON | **append-only JSONL + compaction** |

Acest document trebuie actualizat, nu folosit ca manifest current-state.

## 13.2 WINDOWS_DESKTOP.md are și el drift

Documentul afirmă încă:
- search-index.json;
- crawl/approval interaction „remains to implement”.

HEAD folosește:
- search-index.jsonl;
- /crawl cu confirmation prompt în ui/desktop.

## 13.3 DESKTOP_ECOSYSTEM.md este istoric

Acesta descrie:
- Electron;
- WebContentsView;
- apps web;
- MCP connectors.

NATIVE_AUDIT.md și HEAD confirmă că Electron a fost eliminat și echivalentele native nu au fost portate.

**P0 documentation rule:** documentele istorice trebuie marcate explicit HISTORICAL / SUPERSEDED, altfel induc roadmap-ul și agenții în eroare.

---

# 14. Product/Desktop audit

## 14.1 Tab-uri reale din desktopul actual

Source of truth: ui/desktop/controller.go:27-44.

| Tab | Clasificare | Ce funcționează |
|---|---|---|
| Home | **REAL** | launcher pentru capabilitățile runtime actuale |
| Chat | **REAL** | Ilaria conversation via configured backend |
| Agent | **REAL, partial autonomy** | linear planner, tools, approvals, persistent current run |
| Search | **REAL** | own lexical index, local indexing, explicit crawl |
| Files | **REAL viewer** | navigation + text preview în workspace |
| Compute | **REAL inventory / PROTOTYPE execution** | NVIDIA inspection + consent/config; coordinator absent |
| Settings | **REAL minimal** | Ilaria URL, health, workspace, token indicator, index count |

Nu există tab-uri runtime curente pentru App Store, Notifications, Docs, Sheets, Proactive sau World Model.

---

# 15. Agent product: real versus lipsă

## 15.1 Real

cmd/swypik-os construiește:
- workspace.read;
- workspace.write;
- workspace.edit;
- workspace.list;
- network.interfaces;
- process.run;
- search.query.

Dovezi:
- core/agent/workspace_tools.go:166-373.
- core/agent/tools.go:40-102.
- cmd/swypik-os/main_windows.go:213-218.

Agentul:
- citește înainte de edit;
- folosește SHA256 pentru stale-write detection;
- cere aprobare;
- execută un pas la un moment dat;
- poate rula comenzi;
- persistă current run.

## 15.2 Lipsă pentru agentic computer use real

Nu există în runtime:
- desktop.windows;
- desktop.snapshot;
- desktop.invoke;
- desktop.fill;
- desktop.focus;
- Windows UI Automation adapter;
- semantic browser adapter;
- browser tabs/navigation/actions;
- native MCP client;
- editor.open;
- diagnostics.collect;
- LSP definition/references/symbols;
- git.status/diff ca tools typed;
- tests.run ca tool typed;
- browser postcondition verification;
- independent verifier;
- durable DAG multi-task;
- sandbox real.

process.run rulează cu drepturile userului; Job Object nu este sandbox. Aceasta rămâne problemă P0 de securitate din auditul A.

---

# 16. Files/editor

## 16.1 Real

Files:
- navighează doar prin controller/safepath;
- sortează directoare înaintea fișierelor;
- max 500 entries afișate;
- preview text <=256 KiB;
- binarele nu sunt randate ca text.

Dovezi: ui/desktop/controller.go:537-632.

## 16.2 Gap față de un workspace product

Lipsesc:
- editor edit/save în UI;
- tabs de fișiere;
- line numbers;
- syntax highlighting;
- search in file;
- workspace search UI;
- diff view;
- preimage hash în editor flow;
- conflict UI;
- create/rename/delete UI;
- Git status/diff;
- diagnostics inline;
- symbol outline;
- references/definition;
- binary/document previewers.

Search result pe file:// nu deschide editorul intern; native_commands_windows.go îl revelează în Explorer.

P0 ar trebui să transforme Files într-un **verified workspace/editor surface**, nu să construiască încă un IDE complet.

---

# 17. Browser

În native runtime actual nu există browser embedded și nici computer-use browser.

Search result HTTP(S):
- este deschis prin ShellExecute în browserul implicit al utilizatorului.

Dovadă: ui/engine/native_commands_windows.go:141-154.

Asta este o decizie bună pentru runtime-ul nativ actual, dar nu satisface agentic browser use.

Pentru P1:
- browserul trebuie tratat ca tool adapter extern sau browser automation service;
- semantic DOM/AOM înainte de click-by-coordinate;
- session scope;
- stale reference detection;
- postcondition verification;
- per-action capability/approval;
- nicio reutilizare implicită a authority-ului browserului pentru agent.

Nu este necesar să reintroduceți Electron pentru a obține browser control.

---

# 18. Settings

Settings actual:
- Ilaria endpoint;
- connection test;
- workspace;
- token-configured indicator;
- search index count;
- settings path.

Dovezi: ui/desktop/controller.go:717-779.

Lipsesc ca product surface:
- autonomy mode;
- tool permissions;
- sandbox status;
- model/provider selection;
- local/cloud mode;
- crawl policies;
- indexed sources management;
- delete/rebuild index;
- search storage usage;
- plugins/MCP;
- browser integration;
- notification policy;
- update channel;
- privacy/data retention;
- logs/evidence;
- resource budgets;
- accessibility/system integration.

---

# 19. Apps, notifications, docs, sheets, proactive, worldmodel, mobile

## 19.1 core/appstore — DEAD pentru desktop

- catalog hard-coded;
- InstallApp doar setează Installed=true;
- GenerateOnDemand creează metadata în memorie;
- fără package artifact;
- fără signatures;
- fără installer;
- fără permissions/capabilities;
- fără sandbox;
- fără update;
- fără importer current desktop.

Mai conține și SWP coin reward copy, incompatibil cu zero-crypto invariant.

**Verdict:** nu este App Store product.

## 19.2 core/notifications — PROTOTYPE

- in-memory queues;
- keyword spam classifier;
- VIP sender heuristic;
- digest string;
- fără Windows notification listener;
- fără persistence;
- fără UI desktop;
- folosit doar de mobile bridge prototype.

**Verdict:** library demo, nu notification system.

## 19.3 core/docs — PROTOTYPE

- in-memory document map;
- seeded hardcoded document;
- AppendText;
- fără editor;
- fără persistence;
- fără export;
- fără agent/model workflow real;
- folosit doar de mobile bridge.

**Verdict:** prototype.

## 19.4 core/sheets — PROTOTYPE

- in-memory grid;
- hard-coded budget;
- SUM range;
- simplu parser „add ... amount”;
- fără persistence;
- fără spreadsheet UI;
- fără general formula engine;
- fără Ilaria integration real;
- folosit doar mobile bridge.

**Verdict:** prototype.

## 19.5 core/proactive — PROTOTYPE / misleading mock

Codul seed-uiește o acțiune ca și cum ar fi:
- detectat trafic;
- rezervat transport;
- sumarizat email.

EvaluateContext afirmă „all preparations completed automatically” fără transport/integration.

**Verdict:** nu trebuie expus ca product capability până când există trigger sources, action adapters, permissions și evidence.

## 19.6 core/worldmodel — PROTOTYPE library

- formule locale pentru vehicle friction / robot torque;
- counterfactual numeric;
- fără sensor ingestion real;
- fără hardware transport;
- fără importer product.

**Verdict:** experimental library.

## 19.7 mobile/bridge — PROTOTYPE

Go struct construiește:
- Ilaria;
- Swarm;
- Search;
- Notifications;
- Sheets;
- Docs.

Nu există în repo binding JNI/c-shared/gomobile demonstrat pentru această cale. OS_PARITY.md spune explicit că MobileBridge este un Go struct, nu un OS/mobile runtime.

În plus importă Swarm, deci aduce din nou zero-crypto residue în această pistă.

**Verdict:** prototype integration facade, nu mobile product.

## 19.8 ui/views — DEAD legacy UI

Registry-ul vechi declară:
- Search;
- Studio;
- Wallet & Swarm;
- Tasks;
- Connect;
- Settings;
- AI App Store;
- Machines & Brain.

Nu este importat de actualul desktop și conține capabilități/copy care nu reprezintă HEAD-ul live.

**Verdict:** dead historical surface; nu trebuie folosit ca manifest.

---

# 20. Search UX audit

## 20.1 Ce este bun

- motorul este prezentat explicit ca own index;
- index gol nu fabrică rezultate;
- /index și /crawl sunt discoverable;
- crawl cere confirmare;
- rezultatele au title/url/snippet;
- local și web apar în același engine;
- index count și latency sunt vizibile.

## 20.2 Ce lipsește

P0 UX:
- scope toggle: **All / Workspace / Web**;
- indexed-source manager;
- crawl status/progress;
- last fetched;
- source type;
- remove source / recrawl;
- index storage size;
- clear/rebuild;
- errors grouped per source;
- privacy explanation;
- explicit „search existing index” vs „crawl this site”.

P1 UX:
- filters site/type/date/lang;
- quoted phrases/operators;
- result dedupe clusters;
- freshness indicator;
- why-this-result;
- keyboard result navigation;
- internal open pentru local files;
- hybrid semantic mode cu transparent provenance;
- search history optional/local.

Nu afișa BM25 score userului ca „truth score”. Score este doar ranking signal.

---

# 21. P0 — valoare și adevăr înainte de scale

## P0.1 Search evaluation harness

Construiți înainte de ranking major:
- corpus versionat;
- 100–500 queries pentru verticalele țintă;
- relevance judgments;
- adversarial duplicates;
- Romanian + English;
- typo/diacritics;
- freshness cases;
- crawl/robots cases;
- Recall@K/MRR/nDCG/P@K;
- p50/p95 query latency;
- RAM/index bytes;
- ingest throughput.

Fără aceasta, „mai bun” nu este măsurabil.

## P0.2 Reconcile current-state docs

- actualizați OWN_SEARCH.md;
- actualizați WINDOWS_DESKTOP.md;
- marcați DESKTOP_ECOSYSTEM.md historical/superseded;
- eliminați sau etichetați copy-ul mort din ui/views/appstore/proactive.

## P0.3 Durable crawl state + freshness

Introduceți:
- persistent URL frontier;
- per-URL status;
- next_fetch_at;
- attempts/backoff;
- ETag/Last-Modified;
- last_seen/last_changed;
- deletion lifecycle;
- per-host scheduling.

La început poate rula single-node. Nu este necesar cluster.

## P0.4 Canonical + dedupe

- parse rel=canonical;
- redirect alias;
- exact content hash across URLs;
- tracking/query-param policy per host;
- duplicate clusters;
- near-duplicate fingerprint;
- sitemap ingestion.

## P0.5 Query/index v2 design

Înainte de a ridica MaxDocuments:
- numeric doc IDs;
- immutable segments;
- positions;
- tombstones;
- manifest;
- checksums;
- background merge;
- query concurrency fără global exclusive lock.

## P0.6 Useful query language

Implementați minimal:
- "phrase";
- AND/OR/NOT;
- site:;
- type:;
- before:/after:;
- scope local/web.

## P0.7 Agentic coding vertical

Pentru produs, cea mai mare valoare imediată este un workflow demonstrabil:
prompt
→ workspace search/read
→ minimal patch
→ diagnostics/tests
→ diff
→ independent verify
→ user evidence.

Adăugați tools typed pentru:
- workspace.search;
- git.status;
- git.diff;
- diagnostics;
- symbols;
- tests.

Păstrați sandbox/capability broker ca P0 M1; nu extindeți computer-use înainte de authority boundary.

## P0.8 Files → verified editor

Minim:
- internal open;
- line numbers;
- edit;
- diff preview;
- expected SHA;
- save approval;
- stale conflict;
- diagnostics panel.

Nu construiți încă IDE complet.

---

# 22. P1 — vertical search puternic + tool adapters

## P1.1 Hybrid retrieval

- lexical BM25F + positions;
- document/chunk embeddings;
- ANN index versionat;
- RRF/weighted fusion;
- rerank top-K numai dacă benchmark justifică.

## P1.2 Vertical quality ranking

Adăugați signals:
- freshness;
- exact/near duplicate suppression;
- content quality;
- language match;
- title/body/heading/anchor fields;
- site reputation pentru corpusul vertical;
- structured metadata;
- bounded link graph pentru domeniile indexate.

Nu introduceți LTR înainte de judgments suficiente.

## P1.3 Document extraction

Pentru valoare locală:
- PDF text;
- DOCX;
- PPTX;
- XLSX metadata/text;
- Markdown/code-aware fields.

OCR doar acolo unde text extraction lipsește și este justificat.

## P1.4 Native computer/browser tool adapters

- Windows UI Automation;
- semantic browser adapter;
- optional authenticated MCP client;
- tool health state;
- refreshed observations;
- postcondition checks;
- scope/capability enforcement;
- evidence capture.

## P1.5 Notifications real

Doar după surse reale:
- Windows notification integration;
- app/source identity;
- durable inbox/digest;
- user policy;
- permission model;
- no fabricated auto-actions.

## P1.6 App package model

Dacă App Store rămâne obiectiv:
- signed/versioned manifest;
- package artifact;
- capabilities;
- install transaction;
- sandbox;
- update/rollback;
- trust root;
- compatibility contract.

Abia după aceea există „InstallApp”.

---

# 23. P2 — distributed Internet search

P2 începe numai când vertical search are quality + capacity evidence.

## P2.1 Distributed crawl

- partitioned persistent frontier;
- host ownership / leases;
- politeness shared state;
- workers;
- retry/backoff;
- robots cache;
- sitemap queues;
- trap detection;
- crawl budgets;
- content store.

## P2.2 Distributed indexing

- segment build workers;
- shard assignment;
- replicated shards;
- immutable generations;
- manifest publishing;
- background merge;
- vector shard equivalents.

## P2.3 Query serving

- query router;
- fanout;
- per-shard top-K;
- merge;
- caches;
- timeout budgets;
- partial-result semantics;
- health-aware routing.

## P2.4 Ranking research

După ce există date:
- learned sparse retrieval;
- embedding upgrades;
- cross-encoder reranking;
- graph signals;
- entity search;
- query intent;
- click feedback numai cu privacy policy explicită.

## P2.5 Open-web governance

- removal/takedown;
- crawl policy;
- legal/compliance review;
- abuse response;
- publisher controls;
- incident handling;
- audit trail.

---

# 24. Roadmap incremental recomandat

## Milestone S0 — Truth + Bench

Output:
- docs reconciliate;
- search benchmark harness;
- current engine baseline;
- dashboard local de metrics;
- search UX source manager minimal.

Valoare: știm exact ce funcționează și putem măsura orice schimbare.

## Milestone S1 — Vertical Search v1

Țintă conceptuală: **10k–100k documents useful corpus**, nu Internet.

Output:
- durable recrawl;
- sitemap;
- canonical/duplicate clusters;
- query operators;
- result scopes;
- freshness;
- richer extraction;
- relevance eval green.

Valoare: căutare real utilă pe workspace + site-uri alese.

## Milestone S2 — Index v2

Țintă conceptuală: **100k–1M documents pe un nod**, validată prin benchmark.

Output:
- segment storage;
- positions;
- compressed postings;
- concurrent query/ingest;
- background merge;
- robust recovery;
- capacity tests.

Valoare: engine-ul devine o infrastructură de search, nu un map în RAM.

## Milestone S3 — Hybrid Search

Output:
- embeddings versionate;
- vector ANN;
- lexical/vector fusion;
- rerank optional;
- comparative relevance suite.

Valoare: query semantic fără a sacrifica lexical exactness sau provenance.

## Milestone S4 — Multi-host Crawl Fabric

Țintă: creștere graduală către milioane/zecimi de milioane de documente, numai cu SLO.

Output:
- persistent distributed frontier;
- workers;
- host scheduling;
- sharded index;
- query router;
- replicas;
- ops/abuse controls.

Valoare: propriul crawler/index începe să funcționeze ca serviciu Internet-scale real.

## Milestone S5 — Open Web Research

Numai după dovezi la S4:
- wider discovery;
- graph ranking;
- larger corpus;
- storage/network cost model;
- incremental shard growth;
- quality and spam teams/pipelines.

„Google-scale” nu trebuie să fie milestone-ul inițial; trebuie să fie o consecință posibilă a unei arhitecturi validate și a economics demonstrate.

---

# 25. Acceptance gates

Nu considerați etapa completă fără:

1. **functional evidence** — teste reale;
2. **relevance evidence** — judged queries;
3. **latency evidence** — p50/p95;
4. **resource evidence** — RAM/CPU/IO/index bytes;
5. **crawl correctness** — robots/canonical/freshness/dedupe;
6. **security evidence** — SSRF/capability/sandbox;
7. **failure evidence** — crash, corrupt state, 429, timeout, disk-full;
8. **product evidence** — UI nu declară capabilități inexistente;
9. **provenance** — fiecare rezultat/answer poate indica documentele reale;
10. **no metasearch dependency** — search result corpus rămâne index propriu.

---

# 26. Verificare efectuată în acest audit

Comanda executată read-only în E:/nexus/swypik-os:

**go test -count=1 -timeout 180s ./core/search ./ui/desktop ./ui/engine ./core/service ./core/notifications ./core/sheets ./core/proactive ./core/worldmodel ./core/appstore ./core/docs ./mobile/bridge**

Rezultat:
- exit code 0;
- toate pachetele listate au trecut;
- stderr gol.

Aceasta dovedește consistența testelor acestor module la HEAD-ul auditat. Nu schimbă clasificarea de wiring: un package cu teste verzi poate rămâne prototype/dead dacă nu este în runtime-ul produsului.

---

# 27. Concluzie

### Ce este deja real

- motor propriu de search lexical;
- crawler user-seeded;
- robots/noindex/nofollow;
- SSRF hardening;
- tolerant HTML + charset decoding;
- persistent local index;
- BM25F;
- local workspace index;
- search UI;
- agent search.query;
- native Win32 product shell;
- approval-gated workspace agent;
- Files viewer;
- settings minimale.

### Ce nu este încă real

- Internet crawler;
- distributed frontier;
- freshness scheduler;
- canonical clustering;
- cross-URL dedupe;
- spam/quality ranking;
- semantic/vector/hybrid retrieval;
- sharded index;
- distributed query serving;
- full computer use;
- native browser agent;
- native MCP product;
- full editor/LSP;
- real App Store;
- OS notifications;
- Docs/Sheets product;
- proactive automation;
- mobile runtime.

### Direcția cu cel mai bun raport valoare/risc

**Own vertical search + verified agentic workspace** este următorul produs coerent.

Motorul actual este suficient de real ca fundație și suficient de mic încât să poată fi înlocuit treptat fără a arunca totul. Nu trebuie rescris ca „Google” dintr-un pas. Trebuie evoluat prin:
**measurement → durable crawl → canonical/dedupe/freshness → segment index → hybrid retrieval → distributed fabric**.

Această ordine produce valoare reală la fiecare milestone și păstrează North Star-ul ownerului: **motor propriu, fără DDG/metasearch, cu capabilități demonstrate prin benchmark și evidence.**
