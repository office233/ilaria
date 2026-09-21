# Biomed Real Sources + Real Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Antigravity's simulated biomedical/SWE modules with organs that answer only from live authoritative sources (RxNorm, ChEMBL, openFDA, Open Targets, PubMed) cached on disk, and a sandbox that really compiles and tests Go code.

**Architecture:** `cortex/biomed` is a standalone package (no import of `cortex`) with one HTTP `Client` (allow-list, throttle, disk cache, injectable `Fetcher`) and one file per source; `consult.go` composes them into a `ConsultResponse` whose every claim carries `Evidence`. `cortex/biomed_tool.go` adapts it to the organism's `Tool` interface. `cortex/swe/sandbox_executor.go` shells out to the real `go` toolchain in a temp module.

**Tech Stack:** Go 1.26 stdlib only (`net/http`, `encoding/json`, `regexp`, `os/exec`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-biomed-real-sources-design.md`

## Global Constraints

- `cortex/biomed` must not import `nexus-cortex/cortex` (import cycle).
- No hardcoded drug/disease/PK tables anywhere. Missing data returns an error or `nil`, never a default value.
- Every numeric/textual claim in a `ConsultResponse` carries `Evidence{Source, ID, URL, Retrieved, Quote}`.
- Allowed hosts: `rxnav.nlm.nih.gov`, `www.ebi.ac.uk`, `api.fda.gov`, `api.platform.opentargets.org`, `eutils.ncbi.nlm.nih.gov`. Anything else is rejected before the request is made.
- Throttle: at least 250 ms between requests per host, 350 ms for PubMed. Timeout 20 s. 429/503: exponential backoff, max 3 attempts.
- Cache: `<cacheDir>/<source>/<sha256(method+url+body)>.json`, TTL default 30 days.
- Unit tests are offline (fixtures under `cortex/biomed/testdata/`). Live tests run only with `NEXUS_BIOMED_LIVE=1`.
- Gate before every commit: `gofmt -l` empty on touched files, `go vet ./...`, `go test -count=1 -timeout 180s ./...`.

## Review Focus

1. Input `"aspirin and warfarin"` with patient on warfarin: interactions section of the aspirin label must be searched for "warfarin" and reported with the quote; nothing about "bleeding risk" may be asserted without a quote. Test in Task 10.
2. Drug name with a typo (`"gefitnib"`): RxNorm approximateTerm normalizes it; mention finder may miss it, but `Consult` with an explicit `Drugs` list must still work. Test in Task 4 and Task 10.
3. Offline with empty cache: `Consult` returns `ErrOffline` wrapped with the source name; `BiomedTool.Match` returns false without panicking. Test in Task 3 and Task 11.
4. Label whose pharmacokinetics section lacks a half-life: `ExtractPK` returns `HalfLifeHours == nil`; `Simulate` returns `ErrInsufficientPK`. Test in Task 6 and Task 9.
5. Sandbox input containing a `}` inside a string literal or a test that hangs: real compiler handles the first; the second must be killed by the context deadline and reported as `TimedOut`. Test in Task 2.

---

### Task 1: Remove the simulated modules

**Files:**
- Delete: `cortex/thalamus_router.go`, `cortex/thalamus_router_test.go`, `cortex/moe_drive_loader.go`, `cortex/moe_drive_loader_test.go`
- Delete: `forge/colab_moe_brain.py`, `forge/colab_deep_train_top.py`, `forge/colab_master_brain_v2.py`, `forge/self_evolving_loop.py`, `forge/moe_1bit.py`
- Delete: `cortex/biomed/*.go` (all), `cortex/swe/formal_verifier.go`, `cortex/swe/living_codebase.go`, `cortex/swe/mcts_reasoner.go`, `cortex/swe/swe_test.go`, `cmd/nexus-biomed/main.go`
- Modify: `forge/COLAB_GUIDE.md` (tokenizer path `./data/tokenizer.json`; drop the 150M `--grad-checkpoint` only if VRAM allows: keep it)

- [ ] Delete the files listed above (they are untracked; plain `rm`).
- [ ] Run `go build ./...` — expected: fails only because `cmd/nexus-biomed` and `cortex/swe` are now empty/inconsistent; delete `cmd/nexus-biomed/` entirely for now and keep `cortex/swe/{codegraph,types}.go`.
- [ ] `gofmt -w cortex/swe/*.go`; `go build ./... && go vet ./cortex/swe/` pass.
- [ ] Commit: `chore: remove simulated biomed/swe/MoE modules and Colab notebooks (theatre, see spec)`.

### Task 2: Real Go sandbox (`cortex/swe`)

**Files:**
- Rewrite: `cortex/swe/sandbox_executor.go`
- Modify: `cortex/swe/types.go` (keep `DiagnosticError`, `ExecutionResult`; add `TimedOut bool`; drop `PatchProposal`, `FormalProperty`, `FormalProofCertificate`)
- Test: `cortex/swe/sandbox_test.go`

**Interfaces:**
- Produces: `func RunGo(ctx context.Context, files map[string]string) (ExecutionResult, error)`; `files` keys are relative paths inside a fresh module `sandbox`.

- [ ] Write failing tests:

```go
func TestRunGo_PassingTest(t *testing.T) {
	res, err := RunGo(context.Background(), map[string]string{
		"add.go":      "package sandbox\nfunc Add(a, b int) int { return a + b }\n",
		"add_test.go": "package sandbox\nimport \"testing\"\nfunc TestAdd(t *testing.T) { if Add(2, 2) != 4 { t.Fatal(\"bad\") } }\n",
	})
	if err != nil || !res.Success || res.TestsPassed != 1 || res.TestsFailed != 0 { t.Fatalf("%+v %v", res, err) }
}
func TestRunGo_CompileError(t *testing.T)  // "package sandbox\nfunc Broken() int { return \"x\" }\n" → Success=false, Diagnostics[0].Line==2, Kind==DiagTypeMismatch or DiagSyntaxError
func TestRunGo_FailingTest(t *testing.T)   // t.Fatal in test → TestsFailed==1, FailedTestNames==["TestX"]
func TestRunGo_BraceInString(t *testing.T) // `s := "}"` compiles fine → Success=true
func TestRunGo_Timeout(t *testing.T)       // test with `select {}` and ctx timeout 3s → TimedOut=true, Success=false
```

- [ ] Run `go test ./cortex/swe/ -run TestRunGo` — expected: compile failure (RunGo undefined).
- [ ] Implement `RunGo`: `os.MkdirTemp`, write `go.mod` (`module sandbox\n\ngo 1.26\n`) and files, `exec.CommandContext(ctx, "go", "vet", "./...")` then `go test ./... -v -count=1`, env `GOFLAGS=-mod=mod`, `GOWORK=off`. Parse stderr/stdout lines with `^(\S+\.go):(\d+):(\d+): (.*)$` into `DiagnosticError` (Kind: `DiagSyntaxError` if message contains "syntax error", `DiagTypeMismatch` if contains "cannot use" or "mismatched", `DiagUndefinedSymbol` if contains "undefined:", else `DiagTypeMismatch`). Count `--- PASS:` / `--- FAIL: (\S+)`. `TimedOut = errors.Is(ctx.Err(), context.DeadlineExceeded)`. `Success = exit==0 && !TimedOut && len(Diagnostics)==0`.
- [ ] Run the tests — expected: all PASS.
- [ ] Commit: `feat(swe): real Go sandbox that vets, builds and tests code in a temp module`.

### Task 3: `cortex/biomed` foundation: types, errors, HTTP client with cache

**Files:**
- Create: `cortex/biomed/types.go`, `cortex/biomed/errors.go`, `cortex/biomed/client.go`
- Test: `cortex/biomed/client_test.go`

**Interfaces (Produces):**
```go
type Evidence struct { Source, ID, URL, Quote string; Retrieved time.Time }
type Fetcher interface { Do(req *http.Request) (*http.Response, error) }
type Client struct { /* fetcher, cacheDir, ttl, per-host last-request times, mu */ }
func NewClient(cacheDir string, opts ...ClientOption) *Client  // options: WithFetcher, WithTTL, WithUserAgent
func (c *Client) GetJSON(ctx context.Context, source, url string, out any) (cached bool, err error)
func (c *Client) PostJSON(ctx context.Context, source, url string, body any, out any) (cached bool, err error)
var ErrNotFound, ErrOffline, ErrInsufficientPK, ErrDisallowedHost error
type Patient struct { ID, Sex string; Age *int; ActiveMedications []string; Conditions []string; Variants []Variant; Labs map[string]Lab }
type Variant struct { Gene, Change string }          // e.g. {"EGFR","T790M"}
type Lab struct { Value float64; Unit string; Observed time.Time }
```

- [ ] Write failing tests: disallowed host rejected before any fetch (fake fetcher records zero calls); second `GetJSON` for same URL served from cache (fetcher called once, `cached==true`); expired TTL refetches; 503 twice then 200 succeeds (backoff, use `WithBackoff(time.Millisecond)`); fetcher returning network error with no cache → `errors.Is(err, ErrOffline)`.
- [ ] Run — expected: compile failure.
- [ ] Implement `client.go`. Cache key `sha256(method + "\n" + url + "\n" + body)`; file holds `{ "retrieved": RFC3339, "body": <raw json> }`. Throttle by host with a `map[string]time.Time` under mutex. Backoff base 500 ms (overridable).
- [ ] Run tests — PASS. Commit: `feat(biomed): typed evidence, patient model, cached allow-listed HTTP client`.

### Task 4: RxNorm: normalization, name index, mention finder

**Files:**
- Create: `cortex/biomed/rxnorm.go`
- Fixtures: `cortex/biomed/testdata/rxnorm/approx_gefitinib.json`, `props_328134.json`, `displaynames.json` (copied from recorded responses)
- Test: `cortex/biomed/rxnorm_test.go`

**Interfaces (Produces):**
```go
type Drug struct { RxCUI, Name string; Evidence Evidence }
func (c *Client) NormalizeDrug(ctx context.Context, name string) (Drug, error)      // approximateTerm score >= 10 else ErrNotFound; then rxcui/{id}/properties for canonical name
type DrugNameIndex struct { /* map[string]struct{} of lowercase names, maxWords int */ }
func (c *Client) LoadDrugNameIndex(ctx context.Context) (*DrugNameIndex, error)      // displaynames.json, cached
type Mention struct { Text string; Start, End int }
func (ix *DrugNameIndex) FindMentions(text string) []Mention                          // 1..4-grams, lowercase, names with len >= 4 only, longest match wins, no overlaps
```

- [ ] Tests: `NormalizeDrug("gefitinib")` → RxCUI "328134", Name "gefitinib"; `NormalizeDrug("zzzzqq")` → `ErrNotFound` (fixture with empty candidate list); `FindMentions("Pacientul ia gefitinib și metformin zilnic")` → 2 mentions in order; `FindMentions("no drugs here")` → 0.
- [ ] Fake fetcher: `fixtureFetcher{routes map[string]string}` matching by URL substring, used by all later tasks (put it in `client_test.go` as `newFixtureFetcher(t, map[string]string{...})`).
- [ ] Implement; PASS; commit: `feat(biomed): RxNorm normalization and data-driven drug mention finder`.

### Task 5: ChEMBL: molecule, mechanism, target, activities

**Files:**
- Create: `cortex/biomed/chembl.go`
- Fixtures: `testdata/chembl/search_gefitinib.json`, `mech_CHEMBL939.json`, `target_CHEMBL203.json`, `act_CHEMBL939.json`
- Test: `cortex/biomed/chembl_test.go`

**Interfaces (Produces):**
```go
type Molecule struct { ChEMBLID, PrefName string; MaxPhase float64; BlackBoxWarning bool; ATC []string; Props MoleculeProps; Evidence Evidence }
type MoleculeProps struct { MW, ALogP, PSA *float64; HBA, HBD, Ro5Violations *int }
type Mechanism struct { Action, Description, TargetChEMBLID string; Evidence Evidence }
type Target struct { ChEMBLID, PrefName, Type, Organism string; GeneSymbols []string; UniProt []string; Evidence Evidence }
type Activity struct { Type string; Value float64; Units string; PChEMBL *float64; TargetChEMBLID, TargetName, Assay, DocumentID string; Evidence Evidence }
func (c *Client) Molecule(ctx, name string) (Molecule, error)         // /molecule/search.json?q=&limit=5 → pick exact pref_name match (case-insensitive) else first; none → ErrNotFound
func (c *Client) Mechanisms(ctx, chemblID string) ([]Mechanism, error)
func (c *Client) Target(ctx, targetID string) (Target, error)
func (c *Client) Activities(ctx, chemblID string, limit int) ([]Activity, error)  // standard_type__in=IC50,Ki , order_by=standard_value
```

- [ ] Tests from fixtures: gefitinib → CHEMBL939, MaxPhase 4, Ro5Violations 0, ATC L01EB01; mechanism → INHIBITOR / target CHEMBL203; target → gene EGFR, UniProt P00533; activities[0] → IC50 0.1 nM.
- [ ] Implement (strings in ChEMBL JSON come as strings for floats: parse with `strconv.ParseFloat`); PASS; commit.

### Task 6: openFDA label + PK extraction

**Files:**
- Create: `cortex/biomed/openfda.go`, `cortex/biomed/pk_extract.go`
- Fixture: `testdata/openfda/label_gefitinib.json`
- Test: `cortex/biomed/openfda_test.go`, `cortex/biomed/pk_extract_test.go`

**Interfaces (Produces):**
```go
type Label struct { SetID, EffectiveTime string; GenericNames []string; Sections map[string]string; Evidence Evidence }  // section keys as in openFDA (boxed_warning, contraindications, drug_interactions, warnings_and_cautions, dosage_and_administration, use_in_specific_populations, pharmacokinetics, clinical_pharmacology, mechanism_of_action, indications_and_usage)
func (c *Client) Label(ctx, genericName string) (Label, error)     // search=openfda.generic_name:"NAME"&limit=1 ; 404 → ErrNotFound
func (l Label) FindInSection(section, term string) []string        // sentences of the section containing term (case-insensitive); sentence split on ". "
type PKParameters struct { HalfLifeHours, VdLiters, ClearanceLPerHour, ProteinBoundFraction, RenalFraction *Measured }
type Measured struct { Value float64; Unit string; Quote string }
func ExtractPK(pkText string) PKParameters
```

Regexes (documented in code): half-life `(?i)half-?life[^.]{0,80}?(\d+(?:\.\d+)?)\s*(hours?|hr|h|days?|minutes?)`; Vd `(?i)volume of distribution[^.]{0,60}?(\d+(?:[.,]\d+)?)\s*(L|liters?)`; clearance `(?i)clearance[^.]{0,60}?(\d+(?:\.\d+)?)\s*(L/h|L/hr|mL/min)`; protein binding `(?i)(\d+(?:\.\d+)?)\s*%[^.]{0,40}?(bound|binding)` or `(?i)(bound|binding)[^.]{0,40}?(\d+(?:\.\d+)?)\s*%`; renal `(?i)(?:urine|renal)[^.]{0,60}?(\d+(?:\.\d+)?)\s*%` and `(?i)(\d+(?:\.\d+)?)\s*%[^.]{0,60}?(?:urine|renal)`. Days→hours ×24, minutes→hours ÷60.

- [ ] Tests: gefitinib label → SetID `0afc12dd-12f8-4def-9027-f38412a862b9`, `FindInSection("drug_interactions","warfarin")` non-empty; `ExtractPK` on gefitinib PK text → HalfLife 48 h, Vd 1400 L, RenalFraction < 5 %; `ExtractPK("no numbers here")` → all nil.
- [ ] Implement; PASS; commit.

### Task 7: Open Targets + PubMed

**Files:**
- Create: `cortex/biomed/opentargets.go`, `cortex/biomed/pubmed.go`
- Fixtures: `testdata/opentargets/search_disease.json`, `target_EGFR.json`, `disease_NSCLC.json`; `testdata/pubmed/esearch.json`, `esummary.json`
- Test: `cortex/biomed/opentargets_test.go`, `cortex/biomed/pubmed_test.go`

**Interfaces (Produces):**
```go
type OTEntity struct { ID, Name, Entity string }
func (c *Client) OTSearch(ctx, query string, entity string) ([]OTEntity, error)  // entity in {"disease","target","drug"}
type DiseaseAssociation struct { DiseaseID, DiseaseName string; Score float64 }
type ClinicalCandidate struct { DrugChEMBLID, DrugName, MaxClinicalStage string }
type OTTarget struct { ID, Symbol, Name string; Diseases []DiseaseAssociation; Candidates []ClinicalCandidate; Evidence Evidence }
type OTDisease struct { ID, Name string; Candidates []ClinicalCandidate; Targets []TargetAssociation; Evidence Evidence }
type TargetAssociation struct { TargetID, Symbol string; Score float64 }
func (c *Client) OTTarget(ctx, ensemblID string, n int) (OTTarget, error)
func (c *Client) OTDisease(ctx, efoID string, n int) (OTDisease, error)
type PubMedHits struct { Count int; PMIDs []string; Query string; Evidence Evidence }
func (c *Client) PubMedSearch(ctx, term string, max int) (PubMedHits, error)
type PubMedSummary struct { PMID, Title, Source, PubDate string }
func (c *Client) PubMedSummaries(ctx, pmids []string) ([]PubMedSummary, error)
```

GraphQL bodies exactly as recorded on 2026-09-21 (`drugAndClinicalCandidates { count rows { maxClinicalStage drug { id name } } }`, `associatedDiseases(page:{index:0,size:N}) { count rows { score disease { id name } } }`, `associatedTargets(page:...) { count rows { score target { id approvedSymbol } } }`).

- [ ] Tests from fixtures: disease search "non-small cell lung carcinoma" → MONDO_0005233; target EGFR → top disease MONDO_0005233 score > 0.8; PubMed esearch → Count 811 (fixture), 3 PMIDs; summaries → 2 titles.
- [ ] Implement; PASS; commit.

### Task 8: Knowledge graph with persistence

**Files:**
- Create: `cortex/biomed/graph.go`
- Test: `cortex/biomed/graph_test.go`

**Interfaces (Produces):**
```go
type Entity struct { ID, Name, Kind string }                 // Kind: drug|target|disease|variant ; ID like "rxcui:328134", "chembl:CHEMBL203", "mondo:MONDO_0005233", "variant:EGFR:T790M"
type Edge struct { From, To, Relation string; Score *float64; Evidence []Evidence }   // Relation: has_mechanism|targets|associated_with|candidate_for|interacts_with|mentioned_with
type KnowledgeGraph struct { Entities map[string]Entity; Edges []Edge }
func NewKnowledgeGraph() *KnowledgeGraph
func (g *KnowledgeGraph) AddEntity(e Entity); func (g *KnowledgeGraph) AddEdge(e Edge)   // dedupe by (From,To,Relation), merge evidence
func (g *KnowledgeGraph) Neighbors(id, relation string) []Edge
func (g *KnowledgeGraph) Save(path string) error; func LoadKnowledgeGraph(path string) (*KnowledgeGraph, error)
```

- [ ] Tests: add duplicate edge merges evidence (len==2); Save/Load round-trip equal; Load of missing file → empty graph, nil error.
- [ ] Implement; PASS; commit.

### Task 9: PK/PD one-compartment model

**Files:**
- Create: `cortex/biomed/pkpd.go`
- Test: `cortex/biomed/pkpd_test.go`

**Interfaces (Produces):**
```go
type DoseRegimen struct { DoseMg, IntervalHours, DurationHours float64; Bioavailability float64 /* 0<F<=1, default 1 */ }
type PKPoint struct { TimeHours, ConcMgPerL float64 }
type PKSimulation struct { Points []PKPoint; CmaxSS, CminSS, AUCPerInterval float64; Params PKParameters }
func Simulate(p PKParameters, r DoseRegimen) (PKSimulation, error)   // requires HalfLifeHours and VdLiters else ErrInsufficientPK
```
Model: `k = ln2/t½`, single IV-bolus-like oral absorption ignored (documented), superposition of doses: `C(t) = Σ_i F·D/Vd · exp(-k (t - t_i))` for `t_i <= t`, step 0.25 h. Steady-state Cmax analytic: `F·D/Vd / (1 - e^{-kτ})`, Cmin = Cmax·e^{-kτ}. AUC per interval at SS = `F·D/(Vd·k)`.

- [ ] Tests: single dose D=100 mg, Vd=10 L, t½=ln2 h (k=1): C(0)=10, C(1)≈3.68; SS Cmax matches analytic within 1e-6; missing t½ → `ErrInsufficientPK`.
- [ ] Implement; PASS; commit.

### Task 10: Consult bridge + FHIR + confidence

**Files:**
- Create: `cortex/biomed/consult.go`, `cortex/biomed/fhir.go`
- Test: `cortex/biomed/consult_test.go` (offline via fixture fetcher; live test gated by `NEXUS_BIOMED_LIVE=1`), `cortex/biomed/fhir_test.go`

**Interfaces (Produces):**
```go
type Bridge struct { Client *Client; Graph *KnowledgeGraph; GraphPath string; index *DrugNameIndex }
func NewBridge(cacheDir string, opts ...ClientOption) (*Bridge, error)      // loads graph from <cacheDir>/graph.json if present
type ConsultRequest struct { Query string; Drugs []string /* explicit, optional */; Patient *Patient; Regimen *DoseRegimen; Language string /* "ro"|"en", default from query */ }
type DrugReport struct {
	Drug Drug; Molecule *Molecule; Mechanisms []Mechanism; Targets []Target; TopActivities []Activity
	Label *Label; BoxedWarning, Contraindications []string /* sentences */
	Interactions []InteractionHit         // {WithDrug string; Quotes []string; Evidence}
	VariantHits  []VariantHit             // {Variant; LabelQuotes []string; PubMed PubMedHits}
	PK *PKParameters; Simulation *PKSimulation
	OrganNotes []string                   // sentences from use_in_specific_populations/dosage mentioning renal|hepatic|kidney|liver, only if patient has eGFR/ALT labs
	Missing []string
}
type ConsultResponse struct { Drugs []DrugReport; Diseases []OTDisease; Confidence float64; ConfidenceRationale string; Sources []Evidence; Missing []string; Disclaimer string }
func (b *Bridge) Consult(ctx context.Context, req ConsultRequest) (*ConsultResponse, error)
func ParseFHIRBundle(raw []byte) (*Patient, error)   // Patient/Condition/MedicationRequest/MedicationStatement/Observation(valueQuantity → Labs[code text]); no defaults
```
Confidence (documented): start 0; +0.25 if RxNorm normalized; +0.25 if FDA label found; +0.2 if ChEMBL mechanism found; +0.1 if ChEMBL max_phase >= 4; +0.1 if at least one PubMed hit for a requested variant; +0.1 if Open Targets association for a requested disease. Clamp to 1. `ConfidenceRationale` lists which terms fired.

- [ ] Tests (fixtures routed by URL substring): `Consult{Query:"Pacient cu NSCLC EGFR T790M sub gefitinib, ia și warfarină", Patient:{ActiveMedications:["warfarin"], Variants:[{EGFR,T790M}]}}` → one DrugReport for gefitinib with Molecule CHEMBL939, ≥1 Interaction with warfarin containing a quote, VariantHits[0].PubMed.Count == 811, PK.HalfLifeHours 48, Confidence ≥ 0.8, Sources non-empty, Disclaimer non-empty; explicit `Drugs:["gefitnib"]` (typo) still resolves via approximateTerm fixture; offline fetcher with empty cache → error wraps `ErrOffline`; `Missing` lists "pharmacokinetics" when label has no PK section (fixture with the section removed).
- [ ] FHIR tests: bundle with Patient(birthDate)+Condition+MedicationRequest+Observation(eGFR valueQuantity) → Age set, Labs["eGFR"] present; bundle without Observation → `Labs` empty (no defaults).
- [ ] Implement; PASS; commit: `feat(biomed): evidence-carrying consult over live sources`.

### Task 11: Organism tool adapter

**Files:**
- Create: `cortex/biomed_tool.go`, `cortex/biomed_tool_test.go`
- Modify: `cortex/config.go` (add `Biomed BiomedConfig{Enabled bool; CacheDir string}`), `cortex/organism.go:216-222` and `:1974-1980` (register when enabled)

**Interfaces:**
```go
type BiomedTool struct { bridge *biomed.Bridge; index *biomed.DrugNameIndex /* lazy */ }
func NewBiomedTool(cacheDir string) *BiomedTool
func (t *BiomedTool) Name() string { return "biomed" }
func (t *BiomedTool) Match(lower string) bool   // false if index cannot be loaded (offline, no cache); true if >=1 mention
func (t *BiomedTool) Execute(input string) (string, bool)   // Consult with 20 s ctx; format: mechanism, boxed warning, interactions with quotes, PK, sources list; ok=false on error
```

- [ ] Tests: with cache dir seeded by copying fixtures into cache layout is impractical, so inject `biomed.WithFetcher` via `NewBiomedToolWithClient(client)`; `Match("ce este gefitinib")` true; `Match("salut")` false; offline `Match` false and no panic; `Execute` output contains "CHEMBL939" and "openFDA".
- [ ] Wire into `NewOrganism`/`LoadOrganism` behind `cfg.Biomed.Enabled`; existing organism tests unaffected (default off).
- [ ] PASS; commit.

### Task 12: CLI, guide, gate

**Files:**
- Create: `cmd/nexus-biomed/main.go` (flags `-query`, `-drug` (repeatable), `-patient file.json` (FHIR bundle or native `Patient` JSON, detected by `resourceType`), `-dose`, `-interval`, `-cache-dir` default `data/knowledge/biomed`, `-json`, `-refresh`)
- Modify: `forge/COLAB_GUIDE.md` (tokenizer path), `README.md` (short section "Organ biomedical cu surse reale" with the CLI example)

- [ ] Implement CLI: text output in the language of the query (RO if query contains Romanian diacritics or words from the organism's existing RO detection), JSON with `-json`.
- [ ] Live smoke (only if `NEXUS_BIOMED_LIVE=1`): `go run ./cmd/nexus-biomed -query "gefitinib și warfarină la pacient cu EGFR T790M"` prints sources.
- [ ] Gate: `gofmt -l cortex cmd | grep .` empty; `go vet ./...`; `go test -count=1 -timeout 180s ./...`.
- [ ] Commit: `feat(nexus-biomed): CLI over the real-source bridge; docs`.
