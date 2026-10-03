# Ilaria — plan de achiziție și calificare a datelor

Data cercetării: 2026-10-01. Acest document selectează surse candidate; nu declară niciuna aprobată pentru antrenare și nu autorizează o rulare H200. Actualizare la 19:15 UTC: Common Corpus a fost reevaluat după metadatele publice fixate și paper-ul v3.

## Ce arată auditul actual

Inventarul de candidați înregistrează 3.042.602 documente și estimează 1,34–1,67 miliarde de tokenuri; `tokenizer_sha256` este null, deci cifra nu este un număr de tokenuri IlariaLex. Streamul din `data/production/training-gates-v1/dataset.manifest.json` este separat și verificabil: 1 miliard de tokenuri train, 2.097.152 validation și tokenizer SHA `54f5f3b8…`, dar lane-ul `romanian_multilingual` are alocare și disponibilitate zero.

Corecție față de auditul anterior: pachetul `reviewed-approved-20260930-v2` confirmă opt decizii externe aprobate și două atestări first-party acceptate; fișierele rights/evidence/attestation din bundle corespund SHA-urilor declarate, iar manifestul curent al streamului leagă rights registry-ul `5587a64d…`. `REVIEW_PACKET.json` păstrează snapshotul anterior cu stări `REVIEW_REQUIRED`; este istoric, nu decizia finală. Totuși `candidate-inventory.json` încă pin-uiește vechiul rights hash `8f350ec8…`, astfel încât inventarul nu este aliniat cu pachetul revizuit. Aprobarea bundle-ului nu înlătură filtrele pe fișier/rând, atribuirea și obligațiile de proveniență înscrise pentru surse. În plus, atestările first-party includ hashuri de cod vechi: `runtime/pce/replay_artifact.go` și `forge/data_contract.py` nu corespund fișierelor locale actuale; atestarea first-party math este explicit neasumată. Acestea cer reconciliere înainte de o nouă promovare.

Manifestul există la `data/production/training-gates-v1/dataset.manifest.json`; calea generică `data/production/dataset.manifest.json` menționată în auditul agentului lipsește. Existența streamului exact ajută reproducibilitatea, dar nu demonstrează calitatea semantică a întregului corpus. Pilotul IMC-125M rămâne `NOT_PROMOTED`; nu folosim planificarea 8×H200 sau ținta de 120B tokenuri ca dovadă că un asemenea run este necesar ori pregătit.

## Surse candidate, separate pe rol

| Prioritate | Sursă | Valoare | Drepturi și condiții | Decizie |
|---|---|---|---|---|
| 1 | PleIAs Common Corpus — subset îngust per document | Cel mai puternic candidat investigat pentru baza generală: cardul curent declară 2,27T tokenuri; paper-ul v3 publică aproximativ 2T tokenuri, peste 517M documente, multe domenii și provenance/licență la nivel de item. Tabelul lingvistic al paper-ului raportează **2.909B tokenuri românești** în 725.766 documente/1.398B cuvinte. Modelele mici antrenate de autori au avut rezultate comparabile cu modele multilingve de dimensiuni apropiate; asta nu dovedește câștig pe IMC. | Snapshotul HF metadata la revision `307910e4c5d040d6f318e6edf2a2b97849155771` nu are câmp license machine-readable și lista `language` are 13 coduri, fără română — cardul și paper-ul nu sunt perfect sincronizate. Paper-ul raportează 1.138T tokenuri Public Domain, 287.7B CC-BY, dar și CC-BY-SA și alte licențe; trebuie filtrat item-by-item numai către categoriile aprobate, păstrând sursa/licența/URL/hash, excluzând ShareAlike, NC/ND, licență absentă, PII și benchmark contamination. | Prima alegere pentru calificare și ablation controlat, după verificarea posibilității de a reproduce filtrul de drepturi. Volumul românesc este semnificativ, dar nu aprobăm corpusul doar pe baza declarației autorilor sau a cardului. |
| 2 | CoRoLa — posibilă licențiere/parteneriat pentru română contemporană | Resursă națională de referință: 1B+ cuvinte, 300h audio, 70 subdomenii științifice; text curățat, diacritice verificate, metadate și adnotări morfosintactice. Este un complement excelent pentru română contemporană și, dacă licențiat, audio. | Site-ul arată că textele au fost primite prin protocoale de la titulari; KorAP precizează explicit că corpusul nu este disponibil pentru download integral sau parțial. „IPR-cleared” înseamnă drept de folosire pentru scopuri specifice, nu grant universal de pretraining/comercializare. | Cea mai bună pistă de calitate pentru un parteneriat/permisiune de training. Nu scraping, export de rezultate ca proxy sau training până la acord scris ce include scop, produs comercial, retenție și model weights. |
| 3 | FineWeb2-Edu-Ro — metodă de curation românească, datele în carantină | Articol LoResLM 2026 prezintă filtru multi-signal (valoare educațională, topic, format, nivel de studiu) și compară la același compute aproximativ 6.43B tokeni/3.9M samples cu JQL; autorii raportează câștiguri pe Ro-MMLU, Ro-ARC și Ro-HellaSwag față de date nefiltrate și JQL. Acesta este un reper direct pentru metodologia noastră. | Corpusul de bază este FineWeb2/Common Crawl; ODC-By nu autorizează automat conținutul fiecărei pagini. Nici rezultatul pe Llama-2-7B cu pretraining continuat nu se transferă automat la IMC de la zero. | Refolosim ideea de evaluare + multi-signal curation pe surse drepturi-verificate; datele rămân carantină până la rights-at-source. |
| 4 | Common Pile v0.1 — subsetul filtered, selectat per sursă | Candidat de comparație generală: 8 TB, 30 surse, inclusiv cercetare, cod, cărți, enciclopedii, materiale educaționale și documente publice. Lucrarea a verificat mixul pe modele 7B la 1T/2T tokeni și a raportat rezultate competitive cu modele antrenate pe corpusuri fără licențe clare, la bugete similare. | Proiectul a definit deschisitatea prin Open Knowledge Definition și a făcut analiză juridică a surselor; mixul include licențe share-alike. Nu importăm orb întregul mix: alegem numai source packs cu licență compatibilă, păstrăm atribuirea și excludem benchmark-uri/PII conform manifestului. | Comparator pentru un test de calitate generală; selectăm doar pachete cu rights/provenance verificabile. |
| 5 | EUR-Lex, texte și rezumate românești deținute de UE | Limbaj formal de calitate, multilingv; bun pentru un lane românesc juridic și instituțional, nu pentru cunoaștere generală | Politica oficială permite reutilizarea documentelor UE dacă documentul nu indică altfel; conținutul editorial UE este CC BY 4.0. Excludem documentele cu drepturi terțe, date personale nejustificate și excepții explicite. Păstrăm identificatorul, URL-ul, limba, data, licența și atribuirea. | Pilot recomandat pentru română cu proveniență verificabilă; fiecare document trece verificarea notice-ului. |
| 6 | FineWeb-2, configurația română `ron_Latn` | Candidat de volum: lucrarea raportează aproximativ 35,0 miliarde de cuvinte și 58,3 milioane de documente românești; pipeline-ul public descrie deduplicare pe limbă, filtre și anonimizare PII. | Setul este marcat ODC-By 1.0, dar conținutul provine din Common Crawl. Licența setului și procesarea nu dovedesc singure drepturile fiecărei pagini-sursă. Înregistrările păstrează URL și dump; pentru producție cerem verificare de drepturi la nivel de sursă și respectarea opt-out-urilor. | Carantină pentru analiză de eșantion și proveniență; nu îl adăugăm încă în streamul de train. |
| 7 | FinePDFs-Edu, configurația română `ron_Latn` | 350B+ tokenuri educaționale declarate în 69 limbi, cu scoring educațional și config română; poate îmbunătăți manuale/documente, nu este automat text juridic sigur. | Cardul declară ODC-BY 1.0, dar precizează că termenii Common Crawl se aplică; PDF-urile au drepturi de autor la nivel de document. Calificare numai după rights-at-source, licența documentului, hash, autor și PII; excludere altfel. | Carantină pentru rights review; nu antrenăm pe el doar pe baza licenței cardului. |
| 8 | Mathlib4 și Lean 4, la commit-uri fixate | Demonstrații și cod matematic executabil/verificabil; oferă semnal de corectitudine formală, nu înlocuiește proza matematică | Repozitoriile declară Apache-2.0. Păstrăm commit-ul, licența, NOTICE și dependențele; acceptăm numai unități care compilează într-un mediu Lean fixat. | Pilot recomandat pentru matematică verificată; lane distinct față de textul natural și benchmark-uri. |
| 9 | Wikipedia în română, dump oficial | Enciclopedic, adaugă acoperire română | Wikimedia indică în general CC BY-SA 4.0; trebuie verificată nota ediției românești, atribuite sursele și tratate obligațiile ShareAlike/GFDL. Licența modelului rezultat cere evaluare juridică separată. | Candidat după decizie explicită asupra compatibilității licenței și păstrării atribuirilor. |
| 10 | The Stack v2/v3 ori codul public deja descărcat cu SPDX | Cod multi-limbă și exemple reale, mai potrivite decât concursurile pentru cod de aplicație | The Stack v3 are provenance per repo/fișier și metadata de licență, dar detectorii pot greși; includem exclusiv SPDX-uri explicit aprobate, fără intrări „no license”, păstrăm proveniența și filtrăm secrete/PII. Nu descărcăm întregul Stack de mai mulți TB. | Curățăm mai întâi ce există; selectăm pachete mici și licențiate per fișier. |

## Blocaje de integrare verificate înainte de orice download

- HF snapshot pin-uiește card/API metadata, dar README-ul cu `default` config indică un singur parquet `common_corpus_1/subset_100_1.parquet`; nu presupunem că acel config servește toate cele ~2T tokenuri din paper. Reconciliem release, shards și frecvența limbii/licenței înainte de a estima disponibilitatea.
- `ilaria/forge/curate_corpus.py` existent în worktree-ul curent citește în timpul curării doar `text` și emite `text`, `source`, `document_sha256`; toate câmpurile per item (license, identifier/URL, creator, date, language) s-ar pierde din streamul curat dacă adapterul nu le atașează într-un sidecar content-addressed legat de document hash. Acest lucru este necesar pentru audit/atribuire și revocare ulterioară. Integrarea trebuie să adauge sursa, drepturile și schema sidecar fără să duplicăm writerul canonic.
- Sursa Common Corpus lipsește încă din `corpus_sources.lock.json`, registry-ul `data_rights.json`/`data_rights_evidence.json`, `prepare_corpus.SOURCES`, candidate inventory și planul de surse. Statusul actual al pipeline-ului este `NO-GO` pentru această sursă; nu adăugați-o ca `APPROVED` doar din publicarea datasetului.
- Pentru CoRoLa, KorAP spune că datasetul nu se poate descărca; orice candidatură cere acord scris/hosted-training clar cu deținătorii.

Prioritatea se împarte în două: Common Corpus este cel mai mare candidat pretraining multilingual investigat, iar CoRoLa este calea de calitate și licențiere pentru româna contemporană; nu confundăm `IPR-cleared` cu acord liber de pretraining, deoarece sursa spune că corpusul nu se poate descărca și fiecare furnizor are propriul protocol. FineWeb2-Edu-Ro oferă o metodă validată pentru a crește calitatea: clasificare multi-signal și matched-compute eval; aplicăm metoda la surse autorizate. CommonCorpus paper-ul raportează că modelele mici proprii au performat comparabil cu modele de dimensiune apropiată; studiul FineWeb2-Edu-Ro arată câștiguri la Llama-2-7B cu pretraining continuat. Niciunul nu testează IMC-125M. DCLM/FineWeb/ FinePDFs pornesc din web/Common Crawl, deci folosim rezultatele lor metodologice și ținem documentele în carantină până la rights-at-source. OpenStax are licențe per titlu, inclusiv NC; verificăm fiecare carte.

## Pachetul următor recomandat

1. Qualify a Common Corpus shard at its pinned data revision. Use author paper’s table to target 2.909B Romanian source-token count, but do not assume all of it is eligible. Sample item metadata only first, reconcile paper vs HF version, calculate counts by `language × license × source`, and write an exact hash-bound manifest for Public Domain first; test CC-BY in a separate attribution-aware lane. A separate read-only feasibility note proposes a tiny 1M RO + 4M EN train / 250k validation pilot after these gates; these are requested target sizes, not proven available counts. Exclude unknown/SA/NC/ND, opt-outs/retractions, PII and eval contamination. Require rights review on publishers/source policies and reproduce the filter. Do not load text until this passes.
2. Pursue CoRoLa as a consent/licensing partnership route for high-quality contemporary Romanian text and speech. The provider must confirm in writing model pretraining/continued training, commercial product use, derivative checkpoint rights, retention, removal obligations and any secure-compute conditions. Its official KorAP service says corpus data are not available for download; don't scrape queries or reconstruct a corpus from result snippets. Until a grant exists, use only the public linguistic metadata/statistics within published terms.
3. Reuse FineWeb2-Edu-Ro's evaluated curation recipe (human calibration, multilingual/localized quality labels, topic/format/education-level diversity, matched-token/compute comparison) over the candidate sources we are authorized to use. The published RoEdu results use ~6.43B tokens/3.9M samples and report better Romanian benchmark performance than unfiltered FineWeb2/JQL at similar budgets, but the base data are Common Crawl and their rights remain unresolved for our production use.
4. Then use Common Pile as general comparator and separate source packs only after rights eligibility; add EUR-Lex Ro and a separately compiled Lean/Mathlib lane. Keep training/eval data source-disjoint and decontaminate.
2. Construiește un shard Mathlib/Lean separat din surse Apache-2.0 fixate. Păstrează probele de compilare pentru fiecare exemplu și separă testele/benchmarkurile de antrenare.
3. Rulează pe pachetele candidate filtrele Ilaria: detectare RO, verificare diacritice, deduplicare exactă și fuzzy, PII, contaminare cu evaluările blocate, diversitate semantică și scoruri de calitate inspectabile. Evaluează un eșantion uman înainte de a calcula cota în curriculum.
4. Numără tokenii cu tokenizerul Ilaria actual doar pentru diagnostic, apoi măsoară fertility/byte și coverage română. Pentru train RO este necesară o decizie versionată despre extinderea tokenizerului; nu schimbăm tokenizerul înghețat în loc.
5. Publică rapoarte de lineage și un ablation controlat, cu același număr de tokeni și aceeași arhitectură. Compară pachetul curent cu datele noi, scorurile română/matematică/formală, regresiile generale și costul; numai acest test arată dacă datele noi ajută.

## Compararea cu cercetarea agentului — 2026-10-01

Raportul agentului completează bine cercetarea noastră prin opțiuni de cod la scară, matematică filtrată, date educaționale și exemple de SFT/tool use. Îi preluăm inventarul ca listă de experimente, nu ca rețetă de producție. Cifrele de volum de mai jos sunt declarații ale autorilor/cardurilor și trebuie refăcute la revizia fixată; niciuna nu dovedește câștig pentru IMC.

| Recomandarea agentului | Ce aduce față de planul nostru | Decizia Ilaria |
|---|---|---|
| FineMath 4+ | Set separat pentru raționament matematic, declarat la 9,6B tokenuri; mai potrivit pentru comparație decât a adăuga mult CoT nediferențiat. | Challenger de math; întâi rights-at-source, dedup de probleme și soluții, integritate/verificare și ablation cu buget egal. Licența ODC-By a agregatului nu șterge drepturile sursei. |
| The Stack v3 | Cod realist și structură de repository, circa 3,6T tokenuri declarate; îmbunătățește acoperirea API-urilor față de corpusul curent dominat de probleme competitive. | Pilot restrâns, per-fișier, numai expresii SPDX și proveniență acceptate; excludem `no_license`, secrete, vendor/generated și repo-uri/teste din holdout. Cardul oferă `files[].content` și metadata de licență, dar ODC-By la nivel de dataset nu acordă automat drepturi asupra fiecărui fișier. |
| FinePDFs-Edu / FineWiki RO | Mai mult conținut educațional și enciclopedic românesc; FineWiki declară 493.462 articole RO, iar FinePDFs include `ron_Latn`. | Surse de carantină pentru provenance și copyright la nivel de item. FineWiki se suprapune cu Wikipedia și are obligații BY-SA/GFDL; nu îl includem fără o cale aprobată de atribuire și evaluare a share-alike. |
| FineWeb2-Edu-Ro | Valoarea cea mai transferabilă este rețeta de selecție multi-signal și comparația la compute/tokeni egali, nu accesul la datele Common Crawl. | Adoptăm metodologia pe materiale autorizate: calitate, subiect, format, nivel educațional, calibrare umană și benchmark RO fixat. Păstrăm documentele Common Crawl în carantină până la rights-at-source. |
| DCLM, Nemotron-CC, Dolma3 | Repere utile pentru rețete/mixuri web și evaluare la scară. | Comparatoare numai. DCLM declară intenție de cercetare și nu este production-ready; Nemotron cere acordul de date; mixurile Common Crawl/Dolma au obligații ce trebuie urmărite la sursa fiecărui document. Nu acceptăm termeni și nu descarcăm corpusuri gated în această etapă. |
| SmolTalk2, ToolACE, xLAM, Toucan, OpenThoughts3, Open-SWE-Traces | Material pentru etapa separată de instruction following și folosire a uneltelor, nu pentru a umple pretrainingul de bază. | Amânăm până la baseline stabil. Selectăm numai exemple complete, cu rights/provenance și execuție verificabile; grupăm spliturile după problemă/repository/familia generatorului. Exemplele lungi nu se trunchiază arbitrar la contextul 2048. |
| FineVision | Posibilă etapă multimodală. | Nu intră în streamul curent: modelul/trainerul canonic consumă token IDs text. Înainte de orice date imagine sunt necesare encoder, adaptor, format, evaluări și rights gate multimodal. |
| 150B date distincte; 20B tokeni inițial + 100B suplimentari pe 8×H200 | Ipoteză de dimensionare a colecției și a bugetului de antrenare, nu rezultat experimental pe Ilaria. | Nu o adoptăm ca necesar. Stabilim volumul prin curbe de învățare, evaluări la tokeni egali, throughput real IMC, cost și criterii de oprire. Un pool de 150B nu este automat 150B utilizabile/legale/distincte pentru Ilaria. |

Ordinea de lucru rezultată este: (1) reconciliază inventarul/hashurile/atestările pe setul deja acceptat; (2) califică un subset Common Corpus la metadate item-level și verifică disponibilitatea shardurilor; (3) testează lane-uri mici, distincte pentru română generală, educație, matematică verificabilă și cod SPDX; (4) abia apoi adaugă instruction/tool SFT și măsoară dacă fiecare lane îmbunătățește evaluarea relevantă fără regresii. CoRoLa rămâne cea mai interesantă rută de parteneriat pentru română de calitate, iar EUR-Lex este o sursă românească mai restrânsă cu reutilizare oficial documentată.

În `curate_corpus.py`, fiecare document este împărțit pe hashul textului normalizat și linia curată păstrează în principal textul, numele sursei, hashul și calea lane-ului; proveniența fină per fișier/rând trebuie păstrată într-un sidecar legat de hash. Pentru reasoning, trunchierea la 8.000 caractere poate elimina răspunsul final; la candidatele noi nu folosim trunchiere silențioasă. Splitul document-level nu unește automat aceeași întrebare cu mai multe soluții ori aceeași familie de repository/generator, deci e nevoie de un strat de split grupat înainte de train/validation și de verificarea contaminării.

## Gate-uri înainte de H200

- păstrat bundle-ul `reviewed-approved-20260930-v2` ca decizie pentru cele 8 surse externe și cele 2 atestări first-party; reconciliate hashul vechi din `candidate-inventory.json` și obligațiile de proveniență încă deschise (în special originea AoPS/MATH pentru OpenMath);
- re-atestate sursele first-party al căror cod s-a schimbat față de hashurile aprobate; nu includem first-party math cât timp ownership/attestation rămâne fals;
- notice/licență și hash-uri reconciliate pentru fiecare shard nou; nicio sursă candidată doar „publică” fără drept de reutilizare dovedit;
- manifest train/validation, split temporal unde este aplicabil, tokenizer și curriculum versionate;
- splituri grupate după problemă, repository și familie de generator, plus păstrarea provenienței per item într-un sidecar hash-bound;
- lane românesc cu token count IlariaLex și decizie versionată pentru tokenizer înainte de a pretinde acoperire sau calitate în română;
- benchmarkurile rămân excluse din train și decontaminarea este refăcută pe shard-urile noi;
- preflight GPU, checkpoint/resume și export verificate pentru noul manifest;
- costul și pragul de oprire al instanței sunt confirmate înainte de lansare. Oferta observată anterior pentru 8×H200 a fost 38,40 USD/oră; nu porni instanța pentru simpla explorare a datelor.

## Verificare operațională Common Corpus — 2026-10-01

- API-ul Hugging Face `datasets-server` pentru revision-ul public fixat declară configurația `default/train` ca un singur Parquet de **429.962.586 bytes și 69.907 rânduri**; `size`, `parquet` și `splits` concordă. Acest fișier nu este un shard mic pentru pilot și nu reprezintă cele 985 de fișiere Parquet vizibile în arborele complet.
- Endpointul public `/rows` a refuzat chiar și o pagină de un rând: scanarea ar fi citit 429.954.987 bytes peste limita API de 300 MB. Nu a returnat rânduri. `/first-rows` confirmă schema efectivă (`identifier`, `collection`, `open_type`, `license`, `date`, `title`, `creator`, `language`, `word_count`, `token_count`, `text`), dar are exemple de licențe amestecate și documente judiciare; nu poate furniza numărări reprezentative ori calificare de drepturi.
- Rezultatul `/size` indică doar 69.907 rânduri/430 MB în configurația vizibilă, cu schema de 13 coloane. API-ul `tree` listează **985 Parquet / 427.316.295.556 bytes** numai sub `common_corpus_1`. Aceste numere arată un mismatch important între configurația dataset viewer, structura repo-ului și volumetria declarată de card/paper. Nu se descarcă niciun Parquet pentru a investiga acest mismatch.
- Snapshotul metadata salvat deja la `ilaria/docs/research/hf_dataset_metadata_2026-10-01.json` fixează revision-ul `307910e4c5d040d6f318e6edf2a2b97849155771`, dar are `declared_license_metadata: null` și codurile lingvistice declarate omit româna. Endpointul `first-rows` arată că anumite rânduri au `license=Public Domain`, însă distribuția item-level nu este accesibilă prin viewer-ul actual. Nicio astfel de apariție nu aprobă o sursă sau un rând.
- Rezultatele metadata-only curente au fost salvate temporar în `%TEMP%/common-corpus-datasets-server.json`, SHA-256 `2b4b2e57736c0e93169215cf987a43cca7f5508bb309a5882b316d251182e378`; nu conțin text de corpus. Common Corpus rămâne **NO-GO pentru achiziție de text și antrenare** până la reconcilierea dataset-viewer/shards, accesarea unui index metadata fără scanarea textului, drepturi la sursă și validare de proveniență downstream.
- Review independent al sidecar-ului curatorului a confirmat că acesta nu certifică drepturi și a identificat două lipsuri: `dataset_manifest.py` nu validează încă sidecarul/hash-link-ul downstream, iar filtrarea PII din câmpurile metadata este euristică. Patchul testat rămâne doar în worktree-ul izolat; nu se integrează în Main până la gate downstream și soluție de minimizare/PII.
- Sursele OS deja aprobate (`apache_nuttx`, `freebsd_licensed_tree`, `freertos_kernel`, `zephyr`) au licențe permisive verificate per fișier prin SPDX; ele pot genera un pachet separat de **cod/OS**, nu un corpus Public Domain/general ori lane românesc. `licensed_tree_corpus.py` păstrează calea și SPDX-ul, iar registry-ul aprobă utilizarea comercială conform scope-ului sursei; integrarea în streamul IMC tot cere un manifest candidate aliniat cu inventory, lane și pipeline. Niciun pachet de cod nu a fost descărcat în această verificare.

## Rezultate de download/extracție — 2026-10-01 21:11 UTC

Actualizare21:38UTC: OpenMath CoT nou adaugă69.392.651tokeni diagnostici în7151
exemple, toate replay-verificate independent, inclusiv recount. Totalul tuturor
loturilor noi verificate este171.192.809tokeni diagnostici. Cele două loturi Math
rămân în carantină; recipe snapshots/hashuri originale sunt păstrate, iar rețeta
viitoare păstrează case/Unicode la dedup. Receipt: openmath-root-review-20261002.
Pilotul code-only frozen are33.852.096train/7.907.468validation/14.701.949sealed
tokeni, fără46suprapuneri lexicale la benchmark,486grupuri. Nu este fullGenesis;
actualizarea nu închide gate-urile de drepturi ori producție. Pe Main sunt35teste
bench noi PASS, pe lângă80teste ale curatorului/provenienței/manifestului.

Patru sharduri Common Corpus au fost descărcate la revision-ul fixat, inclusiv
trei sharduri noi de 1.295.649.654 bytes. Selecția de cărți are cumulativ56.987
fragmente unice normalizate,43.110.627tokeni diagnostici IlariaLex+EOS. Cele43.098
noi au fost replay-verificate: shard/rând/carte/segment/text; română selectată0.
Volumele și hashurile nu aprobă drepturile; lotul rămâne în carantină.

VoxPopuli RO original train:23.252documente/1.709.030tokeni diagnostici. Dev/test,
audio și identificatorii speaker/session nu au fost emise. Legal notice EP este
încă neverificat, deci lotul rămâne în carantină, cu manifestul inițial înghețat.

FreeRTOS/Zephyr la commiturile canonice:17.518corpuri exact unice,17.991aliases
de proveniență și56.980.501tokeni diagnostici; case/indentation păstrate, SPDX
filtrat. Sursele sunt aprobate, nu încă mixtura frozen. Adaptorul separat nou
pregătește split de grup pentru pilot cod NON_PROMOTABLE, fără să pretindă
îndeplinirea celor opt lane-uri Genesis.

Total nou verificat:101.800.158tokeni diagnostici. Root receipt independent:
E:\nexus-training\evidence\acquisition-root-review-20261001\receipt.json.
Main21teste noi PASS, rețete integrate după handoff, fără stage/commit sau acces
la corpusul/checkpointurile protejate. Hashul rețetei producătoare nu a fost
înregistrat la primele loturi CommonCorpus/Vox și nu îl completăm retroactiv;
rețetele viitoare îl înregistrează și refuză suprascrierea. OpenMath CoT este o
achiziție separată în curs, necontabilizată încă. Bugetul H200 este documentat
în ilaria-brev-h200-launch-plan.md.

## Referințe primare

Actualizare de execuție, 2026-10-01 20:20 UTC: după comanda explicită de download, achiziția publică în carantină a fost efectuată; concluzia veche «NO-GO pentru achiziție de text» este înlocuită de această dovadă. Gating-ul pentru producție/training rămâne separat. Prima pagină tree API cu 985 fișiere nu este inventarul complet; limita viewerului nu este limita downloadului.

| Lot nou pe disc | Material selectat | Documente/fragmente | Tokenuri IlariaLex diagnostic | Stare |
|---|---|---:|---:|---|
| `E:\nexus-training\new-public-20261001\common-corpus` | Public Domain + Open Culture, patru colecții de cărți, SHA LFS verificat | 13.889 | 10.518.749 | Carantină, provenance și hashes; fără train |
| `E:\nexus-training\new-public-20261001\voxpopuli-ro` | Transcrieri originale RO, numai train; fără audio/LM/dev/test | 23.252 | 1.709.030 | Carantină, data CC0 declarată în README; aviz EP încă neverificat |

Selecția totală inițială are 12.227.779 tokenuri diagnostice; nu este un nou manifest de producție și nu înlocuiește corpusul pilotului. Hashurile și ownership-ul sunt în LIVE_STATE.md și manifests per-lot. Extragerea conservatoare nu trunchiază arbitrar documentele; cărțile sunt segmentate cu proveniență la documentul original. Pentru utilizare rămân necesare splituri grupate după original, decontaminare, calificare a drepturilor/calității și manifest complet. Trei shards Common Corpus suplimentare sunt în curs de achiziție într-un folder distinct, cu dedup față de candidatul inițial.

- Common Corpus ICLR 2026/Hugging Face dataset card (2.27T claimed tokens, document-level metadata, current declared language list): https://huggingface.co/datasets/PleIAs/common_corpus
- Common Corpus technical report, arXiv 2506.01732: https://arxiv.org/abs/2506.01732
- Common Corpus v3 HTML paper with corpus composition, Romanian counts and license table: https://arxiv.org/html/2506.01732
- Common Corpus pinned metadata snapshot (metadata only; no corpus rows): `ilaria/docs/research/hf_dataset_metadata_2026-10-01.json`, revision `307910e4c5d040d6f318e6edf2a2b97849155771`, API response SHA-256 `b3efba33c9c6d098b1fb2ea88e25ac68604d274c76c1f7777f4c305b21e07186`.
- FinePDFs-Edu dataset card and per-language configs: https://huggingface.co/datasets/HuggingFaceFW/finepdfs-edu
- The Stack v3 dataset card and file-level provenance/license caveats: https://huggingface.co/datasets/HuggingFaceCode/stack-v3-train
- FineMath dataset card/configs: https://huggingface.co/datasets/HuggingFaceTB/finemath
- FineWiki dataset card and Romanian subset counts: https://huggingface.co/datasets/HuggingFaceFW/finewiki
- SmolTalk2 dataset and per-subset license warning: https://huggingface.co/datasets/HuggingFaceTB/smoltalk2
- DCLM baseline intended-use and Common Crawl provenance: https://huggingface.co/datasets/mlfoundations/dclm-baseline-1.0
- FinePDFs source-page metadata and per-language token counts: https://huggingface.co/datasets/HuggingFaceFW/finepdfs
- HF metadata-only snapshot covering 22 dataset repositories: `ilaria/docs/research/hf_dataset_metadata_2026-10-01.json`.
- CoRoLa official collection scope, methods and text-provider protocols: https://www.racai.ro/p/corola/
- CoRoLa KorAP access statement (corpus not downloadable): https://korap.racai.ro/
- CoRoLa IPR-cleared corpus paper: https://aclanthology.org/L16-1399/
- FineWeb2-Edu-Ro 2026 paper with matched-token method/evaluation: https://aclanthology.org/2026.loreslm-1.13.pdf
- FineWeb2-Edu-Ro research code/data collection: https://github.com/VladNegoita/FineWeb2-Ro
- EUR-Lex legal notice: https://eur-lex.europa.eu/content/legal-notice/legal-notice.html?locale=en
- Common Pile v0.1 (NeurIPS 2025): https://proceedings.neurips.cc/paper_files/paper/2025/hash/52acc050138d6f40dad6f12f91a4ce22-Abstract-Datasets_and_Benchmarks_Track.html
- Common Pile source preparation: https://github.com/r-three/common-pile
- Common Pile filtered data collection: https://huggingface.co/collections/common-pile/common-pile-v01-filtered-data-68300bb0a946d10dda697663
- Common Pile PubMed filtered card, per-document rights fields and data-size/rights caveat: https://huggingface.co/datasets/common-pile/pubmed_filtered
- DCLM paper and evaluation protocol: https://arxiv.org/abs/2406.11794
- FineWeb-2 paper and language statistics: https://openreview.net/forum?id=jnRBe6zatP
- FineWeb-2 dataset card: https://huggingface.co/datasets/HuggingFaceFW/fineweb-2
- FineWeb-2 processing and source repository: https://github.com/huggingface/fineweb-2
- Wikimedia content reuse and attribution: https://www.mediawiki.org/wiki/Wikimedia_APIs/Content_reuse
- Lean 4: https://github.com/leanprover/lean4
- Mathlib4: https://github.com/leanprover-community/mathlib4
- The Stack v2 licensing: https://huggingface.co/datasets/bigcode/the-stack-v2
- OpenStax title-by-title licensing: https://help.openstax.org/s/article/Licensing-information-of-OpenStax-textbooks
