# Hardcodări, Euristici și Limitări în Ilaria

> **Scop**: Acest document declară toate valorile implicite de operare, pragurile euristice, datele de seed (inițializare) și limitările structurale cunoscute din codebase-ul **Ilaria**. Nimic nu este ascuns — acesta este inventarul onest și complet al sistemului.

---

## 1. Date de Inițializare / Seed (Configurabile prin Config)

Toate datele de inițializare sunt acumulate în câmpurile structurii `Config` (vezi [config.go](../cortex/config.go)) și pot fi suprascrise complet prin intermediul unui fișier JSON de configurare (vezi secțiunea 4 pentru detalii despre mecanismul `LoadConfig`) sau prin construcție programatică.

### Topici de Inițializare Automată (`AutoSeedTopics`)
* **Valoare Implicită**: 32 de topici acoperind domenii precum știință, matematică, tehnologie, istorie, geografie, logică și cultura română. Acestea au rolul de a stimula curiozitatea modulului `AutonomousLearner`. Ele nu reprezintă date de antrenament pre-existente, ci interogări de căutare pentru Wikipedia/HuggingFace.

### Seturi de Date de Inițializare (`AutoSeedDatasets`)
* **Valoare Implicită**: `tatsu-lab/alpaca`, `gsm8k`, `hellaswag`. Acestea reprezintă seturi publice cunoscute de instrucțiuni și raționamente utilizate pentru procesul inițial de învățare. Ele pot fi modificate sau golite complet din configurație.

### Limbi de Căutare (`AutoSearchLangs`)
* **Valoare Implicită**: `["en", "ro"]`. Determină limbile în care sunt interogate API-urile Wikipedia.

---

## 2. Date de Evaluare (Benchmark)

Fișierul [data/evals/comprehensive.jsonl](../data/evals/comprehensive.jsonl) conține aproximativ 30 de cazuri de test structurate în 4 categorii majore: *recall*, *generalization*, *wikipedia* și *reasoning*. Acesta reprezintă un set redus de evaluare destinat exclusiv iterațiilor rapide în dezvoltare, nu emiterii de pretenții de capabilitate generală. Răspunsurile așteptate sunt șiruri fixe de caractere, iar evaluarea se face prin scoring parțial (Jaccard).

De asemenea, în [data/evals/hidden_benchmark.jsonl](../data/evals/hidden_benchmark.jsonl) a fost integrat un set robust de exact 100 de cazuri de test de înaltă fidelitate pentru a împiedica supra-ajustarea (overfitting) pe setul de testare vizibil.

> [!WARNING]
> Acest set de evaluare este prea mic pentru a susține afirmații privind inteligența artificială generală (AGI). El testează exclusiv capabilitățile de bază de recuperare a informației (retrieval) și de raționament simbolic rigid.

---

## 3. Motorul de Raționament Determinist (`reasoning.go`)

Motorul de raționament utilizează reguli stricte și potriviri de tip pattern-matching **simbolic/bazat pe reguli**:
* **Aritmetică**: parser de expresii bazat pe expresii regulate (regex).
* **Secvențe**: detecția progresilor aritmetice și geometrice simple.
* **Logică**: parsarea silogismelor simple ("All X are Y. Z is X. Is Z Y?").
* **Sortare**: parsarea și sortarea listelor de valori numerice.

> [!IMPORTANT]
> **Acesta NU este un raționament neural emergent.** Este un mecanism determinist simbolic (așa-numitul "regex shim") care oferă răspunsuri corecte pentru interogări matematice și logice pre-structurate. El nu trebuie prezentat ca dovadă a unei capabilități de gândire emergente a rețelei neuronale spiking.

---

## 4. Valori Implicite de Operare

| Setare | Valoare Implicită | Câmp Config | Rol Funcțional |
| :--- | :--- | :--- | :--- |
| **Port Server Dashboard** | `8080` | `Config.WebPort` | Portul de ascultare al serverului HTTP Dashboard. |
| **Adresă Bind Web** | `127.0.0.1` | `Config.WebBindAddr` | Adresa IP pe care se bindează serverul. |
| **Seed RNG** | `42` | `Config.Seed` | Seed-ul utilizat pentru generarea pseudo-aleatoare. |
| **Dimensiune SDR** | `10000` | `Config.SDRSize` | Numărul total de biți ai vectorului sparse distribuite. |
| **Biți Activi SDR** | `50` | `Config.ActiveCount` | Numărul exact de biți setați pe 1 în SDR (sparsity de 0.5%). |
| **Capacitate Max Memories** | `10000` | `Config.MaxMemories` | Limita maximă de memorii stocate în Hippocampus. |
| **Interval Învățare Auto** | `30s` | `Config.AutoLearnInterval` | Frecvența cu care rulează bucla autonomă. |
| **Timeout HTTP Web** | `10s` | `Config.WebLearnerTimeoutSecs` | Limita de timp pentru interogările externe efectuate. |
| **Rată Limită HTTP** | `2s` | `Config.WebLearnerRateLimitMs` | Pauza obligatorie între request-urile către Wikipedia. |
| **Limită Corp Request** | `5 MB` | `Config.WebLearnerBodyLimitMB` | Dimensiunea maximă a răspunsurilor HTTP descărcate. |
| **User-Agent HTTP** | `Ilaria/1.0 (autonomous learner)` | `Config.WebLearnerUserAgent` | Identificatorul HTTP trimis în headerele de request. |
| **Timeout WebGPU** | `5s` | `Config.WebGPUTimeoutSecs` | Timpul maxim de așteptare pentru alocările WebGPU. |
| **Adam β1** | `0.9` | `Config.AdamBeta1` | 1st-moment decay pentru optimizer-ul transformer. |
| **Adam β2** | `0.999` | `Config.AdamBeta2` | 2nd-moment decay pentru optimizer-ul transformer. |
| **Adam ε** | `1e-8` | `Config.AdamEpsilon` | Stabilitate numerică Adam. |
| **Adam max-grad-norm** | `1.0` | `Config.AdamMaxGradNorm` | Global L2 clip pe gradiente. `<=0` dezactivează. |

### Mecanism de Încărcare (`LoadConfig`)

Toate aceste câmpuri pot fi modificate fără recompilare prin editarea unui fișier de configurare JSON. Loader-ul este implementat în [config_loader.go](../cortex/config_loader.go) cu următorul model de precedență:

1. Flag CLI `-config <path>` (orice binar `cmd/*`).
2. Variabilă de mediu `ILARIA_CONFIG=<path>`.
3. Auto-discovery: `./ilaria.json`, apoi `./config.json`.
4. Dacă niciuna nu există, `DefaultConfig()` rămâne sursa unică.

Modelul de merge: orice câmp absent din JSON păstrează valoarea din `DefaultConfig()`. Operatorul poate suprascrie selectiv doar parametrii care îl interesează. La final, `Validate()` rulează automat și respinge configurațiile incoerente.

Exemplu minim (`ilaria.json`):

```json
{
    "seed": 1337,
    "adam_beta1": 0.95,
    "transformer_num_layers": 6
}
```

**Limitări cunoscute**: nu toate `cmd/*` au flag `-config` încă (acoperit: `cortex`, `cortex-web`, `train`; lipsesc: `cortex-broca-train`, `broca-eval`, `broca-probe`, `cortex-tokenizer`, `cortex-eval`, `cortex-diagnose`, `corpus-*`). Acestea folosesc `DefaultConfig()` direct și vor fi convertite progresiv.

---

## 5. Permisiuni de Fișiere și Securitate

* **Fișiere de Stare și Modele**: Fișierele de persistență ale Organismului (`.nxt1`, `.nxbrain`, `.nxtf`, state-ul Hippocampus) utilizează permisiunea octală strictă `0600` (citire și scriere permisă exclusiv proprietarului procesului). **Excepție documentată**: artefactele de antrenare/diagnostic emise de unele tool-uri din `cmd/` (`cortex-broca-train`, `broca-eval`, `broca-probe`, `cortex-tokenizer`) folosesc `0644` pentru a permite citire de către scripturi de analiză externe rulate fără elevare. Acestea sunt artefacte de output, nu stare sensibilă; uniformizarea la `0600` este o lucrare planificată.
* **Directoare**: Toate directoarele create în timpul execuției (inclusiv folderul de date `./data/cortex/`) utilizează permisiunea strictă `0700` (acces total exclusiv proprietarului).
* **Autentificare Dashboard**: Serverul dashboard generează automat la startup un token criptografic unic de 32 de caractere hexazecimale prin `crypto/rand` (dacă nu este specificat explicit prin `-token`). Acest token este obligatoriu în toate apelurile POST modificatoare și în cele de citire a telemetriei (`/api/stats`).
* **Protecție CSRF / Same-Origin**: Serverul verifică strict potrivirea headerelor `Origin` sau `Referer` (folosind net/url parser) cu portul local de rulare pentru a preveni atacurile de tip Cross-Site Request Forgery.
* **Protecție SSRF**: Modulul `WebLearner` validează schemele adreselor interogate (exclusiv `"https"` securizat) și restricționează domeniile prin intermediul unei whitelist-ări severe (`wikipedia.org`, `huggingface.co`), inclusiv pe fiecare hop de redirect.

---

## 6. End-point-uri API Externe Accesate

| Endpoint de Bază | Scop | Câmp Config Asociat |
| :--- | :--- | :--- |
| `*.wikipedia.org` | Căutare și extragere articole enciclopedice | `Config.WebLearnerWikiBaseURL` |
| `huggingface.co/api/datasets` | Căutare seturi de date de antrenament | `Config.WebLearnerHFSearchURL` |
| `datasets-server.huggingface.co/rows` | Descărcare rânduri cu instrucțiuni brute | `Config.WebLearnerHFRowsURL` |

Sistemul nu utilizează chei de API hardcodate; toate interogările sunt publice și respectă politicile de rate-limiting definite în `Config`.

---

## 7. Scriptul de Descărcare Python (`scripts/download_hf_corpus.py`)

* **Securitate**: Utilizează parametrul `trust_remote_code=False` în toate apelurile bibliotecii `transformers/datasets` pentru a preveni execuția de cod malițios.
* **Versiuni Wikipedia Pinned**: Dump-urile Wikipedia sunt blocate pe versiuni istorice specifice (`"20231101.ro"` și `"20231101.en"`).
* **Plafonări și Eliminări**: Lungimea maximă a frazelor este limitată la 50 de cuvinte, iar fragmentele sub 3 cuvinte sunt respinse automat pentru a preveni zgomotul semantic.

---

## 8. Defecte Logice — Istoric și Status Curent

Auditul static complet din 22 Mai 2026 a identificat 5 defecte logice severe în implementare. **Toate au fost reparate și sunt acum protejate de teste de regresie automate.** Mai jos sunt prezentate în formă istorică pentru transparență și ca documentație a deciziilor de design.

### 1. Generalizarea Conceptelor — REPARAT ([semantic_memory.go](../cortex/semantic_memory.go))

**Bug original (v1)**: Consolidarea aplica `Prototype = Prototype ∩ Input`. Combinată cu uniunea ulterioară `Prototype ∪ (Prototype ∩ Input) ≡ Prototype`, ducea la o identitate matematică: conceptele tinere nu învățau niciodată bit-uri noi și se atrofiau monoton până la SDR-uri vide.

**Tentativă intermediară (v2, supra-corecție)**: `Prototype = Prototype ∪ Input` pentru concepte tinere. Conceptele absorbeau orice bit din orice episod care trecea pragul minim de similaritate → prototip umflat cu zgomot, densitate necontrolată.

**Fix curent (v3)**: merge stratificat în funcție de încredere:
- Bit-uri în AMBELE (intersect) → reinforcement.
- Bit-uri doar în prototip → păstrate (decay lent biologic).
- Bit-uri doar în episod → absorbite NUMAI dacă (a) conceptul e tânăr ȘI (b) similaritatea ≥ `simThreshold + (255-simThreshold)/2` (high-confidence). Altfel ignorate ca zgomot.
- Concepte mature (Count ≥ `SemanticMemoryConceptMaturity`) → prototip IMUTABIL; episodul incrementează doar Count (validare statistică).

**Teste regresie**: `TestSemanticMemoryConsolidation_NoIdentityBug`, `TestSemanticMemoryMatureConceptImmutable`.

### 2. Stabilitate Prefrontală Dominată de Tăcere — REPARAT ([prefrontal.go](../cortex/prefrontal.go#L274))

**Bug original**: `measureStability` număra TOȚI neuronii (firing + silent) în calculul similarității între snapshot-uri consecutive. Într-o rețea sparse cu ~5% activitate, 95% dintre neuroni erau silent în ambele snapshot-uri → "match" trivial care bloca stability la ~95% indiferent de comportamentul real al rețelei.

**Fix**: Jaccard pe neuronii care au tras în cel puțin un snapshot (`prev[j] || curr[j]`). Numără doar `intersection / union`, ignorând silent-silent matches. Pattern-uri identice → 255; pattern-uri disjunct active → 0; overlap 50% → ~85.

**Teste regresie**: `TestMeasureStability_NoSilentMatchBias`, `TestMeasureStability_EdgeCases`.

### 3. Dublă Incrementare ActiveCount în Encoder — REPARAT ([encoder.go](../cortex/encoder.go#L181))

**Bug original**: `EncodeSentence` apela `combined.Set(shiftedIdx)` (care incrementează `ActiveCount` intern) ȘI manual `combined.ActiveCount++`, dublând counter-ul. Densitatea raportată = 2× realitate → corupea toate calculele de similaritate ce divid prin `ActiveCount`.

**Fix**: eliminarea incrementării manuale; `Set()` rămâne singura sursă de adevăr (cu check de duplicat pentru a evita dublarea pe re-set).

**Teste regresie**: `TestEncodeSentence_ActiveCountConsistency`, `TestEncodeWord_ActiveCountConsistency` (verifică `ActiveCount == real_popcount` pe inputuri variate, inclusiv edge cases).

### 4. Shared-Weights în Fractal Cortex — REPARAT ([fractal_cortex.go](../cortex/fractal_cortex.go#L87))

**Bug original**: `SpawnNeurogenesis` clona weights din block-părinte (`copyTernaryWeights`) fără perturbație. Noul block aplica exact aceleași transformări ternare → zero parametri independenți, "neurogeneza" iluzorie.

**Fix**: după clone, `perturbTernaryLayer` flippează `FractalPerturbRate` % din bit-uri cu seed per-block (`uint64(blockID)`). Rate default = 25 (~10% flip). Garantează break-symmetry între block-uri.

**Teste regresie**: `TestPerturbTernaryLayer_BreaksSymmetry` (verifică divergența clone-uri vs original și între seed-uri diferite), `TestPerturbTernaryLayer_ZeroRateNoOp`, `TestPerturbTernaryLayer_NilSafe`.

### 5. Căutare Liniară O(N) în Hippocampus — INVESTIGAT, MENȚINUT INTENȚIONAT ([hippocampus.go](../cortex/hippocampus.go))

**Observație originală**: `RecallScored` parcurge secvențial toate `Memories`, complexitate O(N).

**Investigație empirică**: Implementarea unui inverted bit-index `map[bit]→[memIdx]` (alternativă la O(N)) a fost testată cu benchmark riguros. **Rezultat surprinzător**: pentru workload-urile actuale (N ≤ 10k memorii, SDR sparse 0.5%), bitIndex este **~4× MAI LENT** decât scanarea liniară:

| Implementare | Timp/op (5000 memorii, SDR 1000×50) |
|---|---|
| Scanare liniară (default) | ~144 µs |
| bitIndex + lookup | ~619 µs |

**Motivul**: `SDR.Similarity` este bitwise pe `uint64` — extrem de cache-friendly, auto-vectorizat de compiler, ~ns per memorie. Map allocation/iteration peste candidate (cu duplicate per bit comun) domină costul. Constantele de hardware modern bat asimptotica algoritmică pentru aceste dimensiuni.

**Decizie**: scanarea liniară rămâne path-ul default și optim pentru constrângerile actuale. Infrastructura bitIndex EXISTĂ ([hippocampus.go](../cortex/hippocampus.go) — `bitIndex`, `EnableBitIndex`, `RecallScoredIndexed`) ca opt-in pentru workload-uri viitoare cu:
- N >> 50.000 memorii
- SDR-uri foarte mari (≥ 100k bits)
- Sparsity foarte joasă (< 0.1%)

**Teste regresie**: `TestHippocampus_BitIndexCorrectness` (echivalență fast vs slow path), `TestHippocampus_BitIndexUpdatesOnEviction`, `TestHippocampus_BitIndexNilSafeAfterLoad`. `BenchmarkHippocampusRecall` documentează trade-off-ul empiric.

**Lecție**: auditul static a marcat corect O(N) ca anti-pattern teoretic; măsurătoarea empirică a arătat că alternativa "elegantă" e mai rea. Cod simplu + benchmark > optimizare prematură.

---

## 9. Auto-Eval în Trainer — Decuplarea Loss-ului de Calitate

Adăugat în Mai 2026 după auditul cursei C (val_loss 5.32 → accuracy 0/24 pe broca-eval). Problema descoperită: **val_loss scădea monotonic** în timpul training-ului, dar nu exista vizibilitate dacă scăderea loss-ului se traducea în câștig de acuratețe pe task-uri reale. Curele de antrenament rulau ore întregi fără semnal early.

### Soluție

`cmd/cortex-broca-train` (`main.go`) acceptă acum două flag-uri noi:

```bash
cortex-broca-train -auto-eval -eval-history ./eval-history.jsonl ...
```

**Mecanism**:
1. La fiecare new-best checkpoint (`val_loss` mai mic decât `bestVal`), trainer-ul trimite request către un goroutine-worker dedicat (canal cu buffer 1, drop-on-full).
2. Worker-ul lansează `broca-eval` ca **subprocess CPU-only** (variabila `CUDA_VISIBLE_DEVICES=-1` forțată) — GPU-ul rămâne dedicat training-ului.
3. Subprocess-ul evaluează cele 24 task-uri din `evalsuite.Standard` și scrie un raport JSON detaliat în `<data-dir>/evals/auto-step<N>.json`.
4. Worker-ul parsează raportul și append-ează o linie compactă în `<data-dir>/eval-history.jsonl`:
   ```json
   {"step": 5000, "val_loss": 5.32, "overall_accuracy": 0.083,
    "per_category_accuracy": {"factual": 0.125, "math": 0.0, ...}}
   ```

### Garanții de robustețe

| Scenariu | Comportament |
|---|---|
| `broca-eval` lipsește din PATH/dir | Warning printat, hook DISABLED, training continuă |
| Subprocess crash / exit code != 0 | Eroare logată în JSONL (`error` field), training continuă |
| Worker-ul e ocupat când vine alt best | Request-ul nou e DROPPED cu mesaj (canal buffer 1) — păstrăm doar pe ultimul checkpoint, fără backlog |
| Crash trainer mid-eval | JSONL e Sync()-uit după fiecare scriere → istoric integru |

### Cost

- **Pe training**: zero (subprocess izolat, goroutine async, GPU separat de CPU subprocess).
- **Pe disk**: ~8 KB per eval JSON full + ~500 B per JSONL linie.
- **Pe timp wall**: ~5-25s per eval (depinde de CoT), dar paralel cu training-ul.

### Flag-uri principale

| Flag | Default | Rol |
|---|---|---|
| `-auto-eval` | `false` | Activează hook-ul (opt-in) |
| `-auto-eval-bin` | auto-detect lângă trainer | Path explicit la `broca-eval` |
| `-auto-eval-cot` | `false` | Trimite `--cot` la subprocess (mai lent, mai precis) |
| `-auto-eval-cot-samples` | `3` | Câte voturi Self-Consistency când `-auto-eval-cot` |
| `-auto-eval-temp` | `0.6` | Temperatura sampling subprocess |
| `-auto-eval-top-k` | `40` | Top-k sampling subprocess |
| `-auto-eval-max-tokens` | `40` | Tokens generate per task |
| `-eval-history` | `<data-dir>/eval-history.jsonl` | Path JSONL append-only |
| `-config` | _none_ | JSON config; flag-urile CLI au prioritate peste config |

Toate sunt configurabile via JSON `-config` (cheia `auto_eval`, `auto_eval_cot`, etc.).

### Validare

Testată manual (Mai 2026) cu mini-training de 10 steps pe state-ul cursei C:
- 2 evaluări auto declanșate corect (la step 5 și 10)
- JSONL conține 2 linii, fiecare cu accuracy 0% (consistent cu eval-ul manual al cursei C)
- Fallback graceful confirmat când binarul lipsește SAU eșuează (exit code != 0)

---

## 10. Capcană Runtime — CUDA DLL Discovery la Binarele Compilate cu `-tags cuda`

Adăugat în Mai 2026 după ce cursa D a eșuat silent la prima lansare cu exit code `0xC0000135` (STATUS_DLL_NOT_FOUND). Sesiunea a costat ~10 min de debugging înainte să fie identificat.

### Problema

Binarele compilate cu `go build -tags cuda ./cmd/...` au o dependență CGO de `cuda_ilaria.dll` (wrapper-ul local din `cortex/compute/cuda/cuda_ilaria.dll`). La runtime, Windows caută acest DLL în ordinea standard de DLL Search:

1. Directorul executabilului
2. `C:\Windows\System32`
3. `C:\Windows`
4. CWD (doar dacă `SafeDllSearchMode` permite — adesea NU)
5. Directoarele din `PATH`

**Niciunul dintre acestea nu include `cortex/compute/cuda/`** unde `build.bat` produce DLL-ul. Rezultat: binarul nu pornește, niciun mesaj de eroare util — doar exit code `-1073741515`.

### De ce cursa C a mers totuși

Cursa C a fost lansată cu binarul **co-localizat în rădăcina proiectului** (`go run` sau `go build` fără `-o`, care lasă executabilul în CWD). Probabil DLL-ul a fost copiat manual de un script anterior, sau procesul a fost lansat prin alt mecanism care a setat `PATH` să includă `cortex/compute/cuda/`. **Nu există nicio garanție automatizată** că lucrul ăsta se repetă.

### Workaround actual (Mai 2026)

Manual: copiază `cuda_ilaria.dll` lângă orice binar care folosește CUDA:

```powershell
Copy-Item "D:\Ilaria cortex\cortex\compute\cuda\cuda_ilaria.dll" `
          "D:\Ilaria cortex\bin-cursa-D\"
```

Verificare rapidă: `& binar.exe --help` întoarce `exit 0` cu output, NU `exit -1073741515` silent.

### Fix corect (TODO)

Două opțiuni curate, neimplementate încă:

1. **Build script `scripts/build-cuda-cmd.ps1`** care:
   - Rulează `go build -tags cuda -o <out>`
   - Copiază automat `cortex/compute/cuda/cuda_ilaria.dll` lângă executabil
   - Refuză să producă binarul dacă DLL-ul nu există (forțează `build.bat` întâi)

2. **Embed DLL în binar** prin Go 1.16+ `embed` + extract-on-first-run în `os.TempDir()/ilaria/` + `LoadLibrary` explicit. Mai complex, dar elimină toată gestionarea manuală.

### De ce e o hardcodare ascunsă

Asocierea "binar `-tags cuda` are nevoie de DLL în CWD/dir-exe" nu apare nicăieri în cod sursă vizibil — e o consecință a tag-ului de build + comportamentului Windows DLL loader. **Cineva nou pe proiect (sau eu peste 2 săptămâni) nu are nicio șansă să descopere asta fără să se lovească de exit-code-ul fără context.** Documentat aici exact ca să nu se mai întâmple.

---

## 11. Bug-uri de Scoring în `evalsuite/score.go`

Descoperite în Mai 2026 după investigația cursei D (vezi `docs/plans/2026-05-25-cursa-D-postmortem.md`). Cursa D a raportat două spike-uri de 4.17% accuracy (1/24) la step 12000 și 19500 — investigația a arătat că sunt **false-positive** cauzate de scoring laxist, nu de învățare reală.

### Bug #1 — `ModeContainsAny` cu substring fără word boundary

`evalsuite/score.go:62` folosește `strings.Contains(lowerGen, want)`. Pentru `Expected: ["yes", "no"]`, substringul `"no"` apare în:
- `know`, `now`, `snow`, `knowledge`, `cannot`, etc.

Generation `"In your mindful of buno can help people know from the city."` se marchează **CORRECT** pentru `reason_syllogism` (expected: yes OR no), deși răspunsul e gibberish.

**Impact**: 1-2/24 spike-uri trecătoare în orice cursă suficient de lungă, cauzate exclusiv de noroc — interpretate eronat ca semnale de învățare.

**Fix viitor**: word boundary check (`regexp.MustCompile(\bword\b)`) ÎN LOC DE `strings.Contains`. Trivial, dar schimbă scorul tuturor cursei istorice → necomparabilitate.

### Bug #2 — `ModeNumeric` extrage primul număr indiferent de poziție

`evalsuite/score.go:77` folosește `reNumber.FindString(generated)` care întoarce **primul** match de `-?\d+(?:\.\d+)?` în întreaga generație.

Generation `"9. In the average of 1513 square- 24 million for 94. In the two three people..."` se marchează **CORRECT** pentru `math_sqrt` (expected: 9), deși restul răspunsului e fără legătură cu sqrt(81). Modelul a câștigat pentru că primul caracter întâmplător a fost "9".

**Impact**: orice generation cu numărul corect oriunde devine corectă. Spike-uri matematice frecvente, niciuna meritate.

**Fix viitor**: extragere "answer-line aware" — caută numărul în primele 20 caractere SAU după ultimul `=` SAU pe ultima linie. Decizia de design e netrivială (numerice cu CoT au răspunsul la finalul lanțului de raționament).

### De ce nu se repară acum

1. **Comparabilitate istorică**: cursa C, D, și orice cursă viitoare folosesc același scorer. Schimbarea scorerului acum ar face cursele necomparabile — am pierde baseline-ul.
2. **Reset-ul baseline-ului costă**: cursa următoare ar trebui repornită cu evalsuite v2 pentru a stabili noul baseline.
3. **Magnitudinea bias-ului e cunoscută**: din investigația cursei D, bias-ul e ~4% absolut pe sesiunile care nu învață. Pentru orice accuracy > 10%, semnalul depășește zgomotul.

### Plan reparare (TODO sesiune dedicată)

1. Fix `ModeContainsAny`: word boundary regex.
2. Fix `ModeNumeric`: ultima linie sau primii N=20 caractere.
3. Rescore istoric: rulează v2 scorer offline pe toate `data/cortex-auto/evals/auto-step*.json` și verifică câte spike-uri istorice dispar.
4. Bump scorer version în output JSON (`"scorer_version": 2`) pentru audit trail.
5. Repornire baseline doar dacă rescore-ul arată > 1pp diferență sistematică.

---

## 12. Ce NU Este Hardcodat în Ilaria

* **Fără Secrete sau Token-uri de API**: Codebase-ul nu conține chei private, parole sau token-uri de autentificare expuse în cod.
* **Fără Căi Absolute de Sistem în Codul Go**: Nu există dependențe de structuri absolute de directoare de pe mașina de producție în codul Go; toate rutele de stocare implicite sunt relative (`./data/cortex`). Singura excepție istorică (`cortex/compute/cuda/build.bat`) a fost convertită la auto-detecție prin `%CUDA_PATH%` și `vswhere.exe`. **Caveat runtime**: binarele compilate cu `-tags cuda` au dependență implicită de `cuda_ilaria.dll` — vezi §10.
* **Ponderi Ne-Hardcodate**: Nu există coeficienți neurali statici definiți în cod; toate ponderile sunt fie generate stochastic la inițializare, fie ajustate dinamic prin reguli de plasticitate.
* **Reproductibilitate**: RNG-urile principale (`cmd/train`, `cmd/cortex`, `cortex/ternary_train`) sunt seed-uite din `cfg.Seed` (default `42`), nu din `time.Now()`. `TernaryLayer` are câmp `PRNGState` persistat între apeluri pentru STDP determinist. Modificat după auditul intern din 2026.
* **Hyperparametri Adam Configurabili**: `Beta1`, `Beta2`, `Epsilon`, `MaxGradNorm` sunt expuse ca câmpuri `Config` (`AdamBeta1`, etc.) — pot fi suprascrise prin JSON config fără recompilare. `DefaultAdamConfig()` derivă din `DefaultConfig()`, sursă unică de adevăr.
