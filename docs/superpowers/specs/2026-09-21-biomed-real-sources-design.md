# Design: organe de cunoaștere reală pentru Ilaria (biomed + sandbox) și curățarea codului Antigravity

Data: 2026-09-21. Branch: `agent/nexusbio-biomed-cortex`. Stare: aprobat verbal de utilizator („merg pe mâna ta, dar vreau surse reale și totul funcțional").

## 1. Scop

Ilaria (NexusCortex) nu concurează ca LLM clasic. Câștigă pe axele unde un creier cu memorie
și organe de verificare bate structural un model înghețat:

1. învață permanent dintr-o singură expunere (hipocamp + punte cognitivă, există);
2. își verifică afirmațiile pe surse autoritare live și păstrează cunoașterea pe disc;
3. execută cod real ca să se testeze;
4. rulează local, privat, ieftin.

Această lucrare livrează punctele 2 și 3 și elimină tot codul-teatru introdus de Antigravity.

## 2. Ce se elimină (fără înlocuitor)

| Fișier | Motiv |
|---|---|
| `cortex/thalamus_router.go` (+test) | gating fix `sin(i*d+j)`, neantrenabil; MoE revine după modelul dens, cu test de echivalență Go≡PyTorch |
| `cortex/moe_drive_loader.go` (+test) | format „RGBA32" fals (float32 brut), fabrică greutăți la fișier lipsă |
| `forge/colab_moe_brain.py`, `colab_deep_train_top.py`, `colab_master_brain_v2.py`, `self_evolving_loop.py`, `moe_1bit.py` | curriculum memorizat, „auto-evoluție" care nu antrenează, tokenizer necitibil din Go, fără export nxtf; `moe_1bit` e cod mort fără test de round-trip |
| `cortex/biomed/{sovereign_identity,federated_learning,empathy_triage,generative_molecular,presymptomatic_engine,edge_optimizer,multimodal_encoder,dataset_adapters,drug_discovery,digital_twin,clinical_copilot,causal_graph}.go` | simulări fără date reale (criptare homomorfică pe float-uri în clar, zgomot pe vectori sintetici, SMILES aleatoare, tabel de 5 medicamente, confidențe constante) |
| `cortex/swe/{formal_verifier,living_codebase,mcts_reasoner}.go` | „verificare formală" prin substring, „anticorpi" = ReplaceAll, MCTS fără rollout |

Regula: mai bine 4 module reale decât 15 false. Orice funcție care nu poate obține date reale întoarce o eroare explicită, nu un număr inventat.

## 3. Organul biomedical (`cortex/biomed`, rescris)

### 3.1 Surse (toate publice, fără cheie API)

| Sursă | Rol | Endpoint |
|---|---|---|
| RxNorm (NLM) | normalizare nume medicament → RxCUI; index complet de nume pentru detecție în text | `rxnav.nlm.nih.gov/REST/approximateTerm.json`, `/REST/displaynames.json`, `/REST/rxcui/{id}/properties.json` |
| ChEMBL (EMBL-EBI) | ID ChEMBL, proprietăți fizico-chimice (MW, ALogP, HBD, HBA, PSA, încălcări Ro5), black-box warning, ATC, fază maximă; mecanism de acțiune și țintă; bioactivități (IC50/Ki) reale | `www.ebi.ac.uk/chembl/api/data/{molecule,mechanism,target,activity}.json` |
| openFDA (FDA) | prospectul oficial: boxed warning, contraindicații, interacțiuni, avertizări, dozare, populații speciale (renal/hepatic), farmacocinetică | `api.fda.gov/drug/label.json` |
| Open Targets Platform | normalizare boală (EFO), asocieri țintă-boală cu scor, medicamente cunoscute pe țintă/boală cu fază clinică | `api.platform.opentargets.org/api/v4/graphql` |
| PubMed E-utilities | dovezi: PMID-uri și număr de articole pentru o pereche (medicament, variantă/boală) | `eutils.ncbi.nlm.nih.gov/entrez/eutils/{esearch,esummary}.fcgi` |

Verificat 2026-09-21: toate răspund de pe mașina utilizatorului. API-ul de interacțiuni RxNav e retras (404); interacțiunile vin din secțiunea `drug_interactions` a prospectului openFDA.

### 3.2 Straturi

```
cmd/nexus-biomed (CLI)        cortex/biomed_tool.go (Tool în organism)
            \                        /
             cortex/biomed.Bridge.Consult(request)
                 |  entități (index RxNorm + Open Targets search)
                 |  graf de cunoaștere (entități + muchii cu sursă)  <- persistat JSON
                 |  PK/PD (parametri extrași din prospect, altfel eroare)
                 |  confidență derivată din dovezi
             client HTTP cu allow-list, throttle, cache pe disc
                 rxnorm.go  chembl.go  openfda.go  opentargets.go  pubmed.go
```

`cortex/biomed` NU importă `cortex` (evită ciclul). Adaptorul de Tool stă în pachetul `cortex`.

### 3.3 Componente

**`source.go`**: `Client` cu allow-list de domenii (cele 5 de mai sus), throttle (cel puțin 250 ms între cereri per domeniu, 350 ms pentru PubMed), timeout 20 s, User-Agent identificabil, cache pe disc `<cacheDir>/<sursă>/<sha256(url+body)>.json` cu TTL configurabil (implicit 30 zile). Interfața `Fetcher` permite fixture-uri în teste. Cache-ul ESTE „cunoașterea pe disc": crește cu fiecare entitate întâlnită și se poate muta pe Drive.

**`rxnorm.go`**: `NormalizeDrug(name) (Drug, error)` prin approximateTerm (scor peste prag, altfel `ErrNotFound`); `DrugNameIndex` construit o dată din `displaynames.json` (zeci de mii de nume), cache-uit; `FindDrugMentions(text) []Mention` caută 1-3-grame din text în index (fără listă hardcodată).

**`chembl.go`**: `Molecule(name)`, `Mechanisms(chemblID)`, `Target(targetID)`, `Activities(chemblID, limit)`. Proprietățile Ro5 vin din `molecule_properties`; nu se calculează afinități, se raportează măsurătorile reale (tip, valoare, unitate, țintă, referință).

**`openfda.go`**: `Label(genericName) (Label, error)` cu secțiunile ca text + `set_id`, `effective_time`. **`pk_extract.go`**: extrage din secțiunea de farmacocinetică, prin regex documentate: timp de înjumătățire, volum de distribuție, clearance, legare de proteine, fracție eliminată renal. Fiecare valoare poartă fragmentul de text sursă; lipsă = `nil`, nu default.

**`opentargets.go`**: `SearchDisease(name)`, `SearchTarget(symbol)`, `TargetAssociations(targetID, n)`, `KnownDrugs(targetID)`.

**`pubmed.go`**: `Count(term) (n, []PMID)`, `Summaries(pmids)`.

**`graph.go`**: `KnowledgeGraph` (entități, muchii `{Source, Target, Relation, Evidence []Evidence}`), `Evidence{Source, ID, URL, Retrieved, Quote}`. Metode `Build*` care populează din surse; `Save/Load` JSON. Nicio entitate la construcție.

**`pkpd.go`**: model cu un compartiment, dozare repetată (matematică reală, testată pe cazuri analitice). Intrare: `PKParameters` extrase + `Patient`. Dacă lipsește t½ sau Vd, `ErrInsufficientPK`. Ajustările renale/hepatice NU sunt calculate din formule inventate; se raportează textul secțiunilor „use in specific populations"/„dosage" cu termeni renal/hepatic evidențiați, plus eGFR-ul pacientului dacă e cunoscut.

**`consult.go`**: `Bridge.Consult(ConsultRequest) (ConsultResponse, error)`:
1. detectează medicamente (index RxNorm) și boli (Open Targets search) în întrebare și în profilul pacientului;
2. pentru fiecare medicament: molecule + mecanism (ChEMBL), prospect (openFDA), PK extras, interacțiuni cu medicația activă a pacientului (căutare a numelor din medicația activă în secțiunea `drug_interactions`);
3. pentru variante genomice din profil (ex. `EGFR T790M`): căutare a variantei în prospect + număr PubMed pentru „(drug) AND (variant)"; se raportează ce s-a găsit, nu un verdict de rezistență;
4. confidență = funcție documentată de: număr de surse independente care au întors date, fază maximă ChEMBL, existența unui prospect FDA; niciodată o constantă;
5. răspunsul conține `Sources []Evidence`, `Missing []string` (ce nu s-a putut afla) și `Disclaimer`.

**`fhir.go`**: parserul FHIR rescris: câmpuri opționale (`*float64`), fără valori „normale" implicite.

**`types.go`**: `Patient{ID, Sex, Age *int, ActiveMedications, Conditions, Variants []Variant, Labs map[string]Lab}`.

### 3.4 Integrare în organism

`cortex/biomed_tool.go`: `BiomedTool` implementează `Tool`. `Match` = indexul RxNorm găsește cel puțin un medicament în input (index încărcat lazy din cache; dacă nu există cache și nu e internet, tool-ul e inactiv, nu blochează). `Execute` = `Consult` + formatare text. Înregistrat în `NewOrganism` și `LoadOrganism` alături de celelalte tool-uri, activat de `Config.Biomed.Enabled` (implicit off, ca WebLearner).

### 3.5 CLI

`cmd/nexus-biomed`: `-query`, `-patient patient.json` (FHIR sau format nativ), `-cache-dir` (implicit `data/knowledge/biomed`), `-json`. Fără `-demo-all` cu date inventate.

## 4. Sandbox real (`cortex/swe`)

`sandbox_executor.go`: `RunGo(ctx, files map[string]string) (ExecutionResult, error)`: scrie fișierele într-un director temporar cu `go.mod` propriu, rulează `go vet ./...` apoi `go test ./... -v`, cu timeout din context. Parsează `file:line:col: msg` în `Diagnostics` și `--- FAIL: TestX` în `FailedTestNames`; numără `--- PASS/FAIL`. Nu există „auto-repair": repararea e sarcina creierului (LM + memorie), sandbox-ul doar spune adevărul. `codegraph.go` rămâne. `types.go` păstrează doar tipurile folosite.

## 5. Erori și limite

- Fără internet și fără cache: `ErrOffline` cu numele sursei; nimic nu se fabrică.
- Rate limit (429/503): backoff exponențial, max 3 încercări, apoi eroare.
- PubMed fără cheie: cel mult 3 cereri/s (throttle).
- Cache-ul poate fi invalidat cu `-refresh`.
- Textele de prospect sunt în engleză; răspunsul le citează ca atare.

## 6. Testare

- Unit: fixture-uri înregistrate din API-urile reale (`testdata/<sursă>/*.json`) prin `Fetcher` fals; teste pentru extracția PK (fragmente reale de prospect), PK/PD (soluție analitică), graf (persistență), detecție de mențiuni.
- Live (opțional, `NEXUS_BIOMED_LIVE=1`): un consult real pentru gefitinib + pacient cu T790M, verifică prezența surselor.
- Sandbox: compilează un program mic, un test care pică, o eroare de sintaxă.
- Gate: `gofmt -l` gol, `go vet ./...`, `go test -count=1 -timeout 180s ./...`.

## 7. În afara acestei lucrări (urmează)

- Modelul dens 150-350M pe H100 (train_ilaria.py, corpus RO+EN pe Drive, export nxtf).
- SFT pe date distilate (distill_cot.py).
- MoE, doar cu exporter Python→Go și test de echivalență.
- Snapshot-uri offline (ChEMBL SQLite, openFDA dumps) pe Drive, umplute de consolidarea din somn.
