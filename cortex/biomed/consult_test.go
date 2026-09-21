package biomed

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// allRoutes wires every recorded fixture so a full consult runs offline.
func allRoutes() map[string]string {
	return map[string]string{
		"approximateTerm.json?term=gefitinib":         "rxnorm/approx_gefitinib.json",
		"approximateTerm.json?term=gefitnib":          "rxnorm/approx_gefitinib.json",
		"approximateTerm.json?term=warfarin":          "rxnorm/approx_none.json", // not needed for the assertions; keeps traffic explicit
		"rxcui/328134/properties":                     "rxnorm/props_328134.json",
		"displaynames.json":                           "rxnorm/displaynames.json",
		"molecule/search.json?q=gefitinib":            "chembl/search_gefitinib.json",
		"mechanism.json?molecule_chembl_id=CHEMBL939": "chembl/mech_CHEMBL939.json",
		"target/CHEMBL203.json":                       "chembl/target_CHEMBL203.json",
		"activity.json?molecule_chembl_id=CHEMBL939":  "chembl/act_CHEMBL939.json",
		`generic_name%3A%22gefitinib%22`:              "openfda/label_gefitinib.json",
		`POST:opentargets|entityNames:[\"disease\"]`:  "opentargets/search_disease.json",
		`POST:opentargets|entityNames:[\"target\"]`:   "opentargets/search_target.json",
		"POST:opentargets|ENSG00000146648":            "opentargets/target_EGFR.json",
		"POST:opentargets|MONDO_0005233":              "opentargets/disease_NSCLC.json",
		"esearch.fcgi":                                "pubmed/esearch.json",
		"esummary.fcgi":                               "pubmed/esummary.json",
	}
}

func testBridge(t *testing.T, routes map[string]string) (*Bridge, *fixtureFetcher, string) {
	t.Helper()
	ff := newFixtureFetcher(t, routes)
	dir := t.TempDir()
	b, err := NewBridge(dir, WithFetcher(ff), WithThrottle(0), WithBackoff(0))
	if err != nil {
		t.Fatal(err)
	}
	return b, ff, dir
}

func t790mPatient() *Patient {
	return &Patient{
		ID:                "P1",
		ActiveMedications: []string{"warfarin"},
		Conditions:        []string{"non-small cell lung carcinoma"},
		Variants:          []Variant{{Gene: "EGFR", Change: "T790M"}},
		Labs:              map[string]Lab{"eGFR": {Value: 38, Unit: "mL/min/1.73m2"}},
	}
}

func TestConsult_GefitinibWithT790MAndWarfarin(t *testing.T) {
	b, _, dir := testBridge(t, allRoutes())
	res, err := b.Consult(context.Background(), ConsultRequest{
		Query:   "Pacient cu NSCLC EGFR T790M sub gefitinib, ia și warfarină",
		Patient: t790mPatient(),
		Regimen: &DoseRegimen{DoseMg: 250, IntervalHours: 24, DurationHours: 240},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Drugs) != 1 {
		t.Fatalf("drugs = %d (%+v)", len(res.Drugs), res.Drugs)
	}
	d := res.Drugs[0]
	if d.Drug.RxCUI != "328134" || d.Molecule == nil || d.Molecule.ChEMBLID != "CHEMBL939" {
		t.Fatalf("identity: %+v %+v", d.Drug, d.Molecule)
	}
	if len(d.Mechanisms) != 1 || len(d.Targets) != 1 || d.Targets[0].GeneSymbols[0] != "EGFR" {
		t.Fatalf("mechanism/targets: %+v %+v", d.Mechanisms, d.Targets)
	}
	if len(d.TopActivities) == 0 || d.TopActivities[0].Type != "IC50" {
		t.Fatalf("activities: %+v", d.TopActivities)
	}
	if d.Label == nil || d.Label.SetID == "" || len(d.Contraindications) == 0 {
		t.Fatalf("label: %+v", d.Label)
	}
	if len(d.Interactions) != 1 || d.Interactions[0].WithDrug != "warfarin" || len(d.Interactions[0].Quotes) == 0 ||
		!strings.Contains(strings.ToLower(d.Interactions[0].Quotes[0]), "warfarin") {
		t.Fatalf("interactions: %+v", d.Interactions)
	}
	if len(d.VariantHits) != 1 || d.VariantHits[0].PubMed.Count != 811 || d.VariantHits[0].Variant.Change != "T790M" {
		t.Fatalf("variant hits: %+v", d.VariantHits)
	}
	if d.PK == nil || d.PK.HalfLifeHours == nil || d.PK.HalfLifeHours.Value != 48 {
		t.Fatalf("pk: %+v", d.PK)
	}
	if d.Simulation == nil || d.Simulation.CmaxSS <= 0 {
		t.Fatalf("simulation: %+v", d.Simulation)
	}
	if len(d.OrganNotes) == 0 {
		t.Fatal("patient has eGFR: expected renal/hepatic sentences from the label")
	}
	if len(d.TargetAssociations) != 1 || d.TargetAssociations[0].Symbol != "EGFR" || len(d.TargetAssociations[0].Diseases) == 0 {
		t.Fatalf("target associations: %+v", d.TargetAssociations)
	}
	if len(res.Diseases) != 1 || res.Diseases[0].ID != "MONDO_0005233" || len(res.Diseases[0].Candidates) == 0 {
		t.Fatalf("diseases: %+v", res.Diseases)
	}
	if res.Confidence < 0.8 || res.ConfidenceRationale == "" {
		t.Fatalf("confidence = %.2f (%s)", res.Confidence, res.ConfidenceRationale)
	}
	if len(res.Sources) < 5 || res.Disclaimer == "" {
		t.Fatalf("sources = %d, disclaimer = %q", len(res.Sources), res.Disclaimer)
	}
	seen := map[string]bool{}
	for _, s := range res.Sources {
		seen[s.Source] = true
	}
	for _, src := range []string{"rxnorm", "chembl", "openfda", "opentargets", "pubmed"} {
		if !seen[src] {
			t.Errorf("source %s missing from Sources", src)
		}
	}
	// The knowledge graph on disk must have grown from this consult.
	g, err := LoadKnowledgeGraph(filepath.Join(dir, "graph.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Entities) < 3 || len(g.Neighbors("rxcui:328134", "")) == 0 {
		t.Fatalf("graph not persisted: entities=%d edges=%d", len(g.Entities), len(g.Edges))
	}
}

func TestConsult_ExplicitDrugWithTypoResolves(t *testing.T) {
	b, _, _ := testBridge(t, allRoutes())
	res, err := b.Consult(context.Background(), ConsultRequest{Drugs: []string{"gefitnib"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Drugs) != 1 || res.Drugs[0].Drug.RxCUI != "328134" {
		t.Fatalf("drugs = %+v", res.Drugs)
	}
	if res.Drugs[0].Simulation != nil || len(res.Drugs[0].OrganNotes) != 0 {
		t.Fatalf("no regimen / no labs: simulation and organ notes must be absent: %+v", res.Drugs[0])
	}
}

func TestConsult_NoDrugFoundIsErrNotFound(t *testing.T) {
	b, _, _ := testBridge(t, allRoutes())
	_, err := b.Consult(context.Background(), ConsultRequest{Query: "salut, ce mai faci?"})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestConsult_OfflineWithoutCacheIsErrOffline(t *testing.T) {
	routes := map[string]string{}
	for k := range allRoutes() {
		routes[k] = "" // "" = network failure
	}
	b, _, _ := testBridge(t, routes)
	_, err := b.Consult(context.Background(), ConsultRequest{Drugs: []string{"gefitinib"}})
	if !errors.Is(err, ErrOffline) {
		t.Fatalf("err = %v, want ErrOffline", err)
	}
	_, err = b.Consult(context.Background(), ConsultRequest{Query: "ia gefitinib"})
	if !errors.Is(err, ErrOffline) {
		t.Fatalf("mention path: err = %v, want ErrOffline", err)
	}
}

func TestConsult_MissingListsWhatCouldNotBeLearned(t *testing.T) {
	routes := allRoutes()
	routes[`generic_name%3A%22gefitinib%22`] = "openfda/label_gefitinib_nopk.json"
	b, _, _ := testBridge(t, routes)
	res, err := b.Consult(context.Background(), ConsultRequest{
		Drugs:   []string{"gefitinib"},
		Regimen: &DoseRegimen{DoseMg: 250, IntervalHours: 24, DurationHours: 48},
	})
	if err != nil {
		t.Fatal(err)
	}
	d := res.Drugs[0]
	if d.Simulation != nil {
		t.Fatalf("no PK section: simulation must be nil, got %+v", d.Simulation)
	}
	joined := strings.ToLower(strings.Join(d.Missing, " | "))
	if !strings.Contains(joined, "pharmacokinetic") {
		t.Fatalf("Missing = %v, want a pharmacokinetics entry", d.Missing)
	}
	if !strings.Contains(strings.ToLower(strings.Join(res.Missing, " | ")), "pharmacokinetic") {
		t.Fatalf("response-level Missing = %v", res.Missing)
	}
}

func TestConsult_ConfidenceIsDerivedNotConstant(t *testing.T) {
	full, _, _ := testBridge(t, allRoutes())
	r1, err := full.Consult(context.Background(), ConsultRequest{Drugs: []string{"gefitinib"}, Patient: t790mPatient()})
	if err != nil {
		t.Fatal(err)
	}
	// Same drug, but openFDA has no label and PubMed is down: confidence must drop.
	routes := allRoutes()
	delete(routes, `generic_name%3A%22gefitinib%22`)
	routes["esearch.fcgi"] = ""
	partial, _, _ := testBridge(t, routes)
	r2, err := partial.Consult(context.Background(), ConsultRequest{Drugs: []string{"gefitinib"}, Patient: t790mPatient()})
	if err != nil {
		t.Fatal(err)
	}
	if !(r2.Confidence < r1.Confidence) {
		t.Fatalf("confidence did not drop: full %.2f vs partial %.2f", r1.Confidence, r2.Confidence)
	}
	if r2.Drugs[0].Label != nil {
		t.Fatal("label must be nil when openFDA has none")
	}
	if len(r2.Missing) == 0 {
		t.Fatal("Missing must name the unavailable sources")
	}
}

func TestNewBridge_LoadsExistingGraph(t *testing.T) {
	dir := t.TempDir()
	g := NewKnowledgeGraph()
	g.AddEntity(Entity{ID: "rxcui:1", Name: "x", Kind: "drug"})
	if err := g.Save(filepath.Join(dir, "graph.json")); err != nil {
		t.Fatal(err)
	}
	b, err := NewBridge(dir, WithFetcher(newFixtureFetcher(t, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Graph.Entities) != 1 {
		t.Fatalf("graph not loaded: %+v", b.Graph)
	}
	if _, err := os.Stat(filepath.Join(dir, "graph.json")); err != nil {
		t.Fatal(err)
	}
}
