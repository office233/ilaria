package cortex

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"nexus-cortex/cortex/biomed"
)

// Review 2026-09-21: Match must not hijack ordinary sentences ("water",
// "silver"), must never block on the network, and rendering must not pair
// mechanisms with the wrong target or print a phase the source did not give.

func TestBiomedTool_MatchNeedsDrugIntentNotJustAnIndexedWord(t *testing.T) {
	tool := newTestBiomedTool(t, gefitinibRoutes())
	if err := tool.Warm(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{"how much water should i drink every day", "my grandmother used silver spoons", "does coffee with caffeine keep you awake"} {
		if tool.Match(q) {
			t.Errorf("must not match a general sentence: %q", q)
		}
	}
	for _, q := range []string{"ce doză de gefitinib iau", "la ce se folosește gefitinib", "gefitinib 250 mg interactions", "can i take gefitinib with warfarin"} {
		if !tool.Match(q) {
			t.Errorf("must match a drug question: %q", q)
		}
	}
}

type slowFetcher struct {
	inner biomedFixtures
	delay time.Duration
}

func (s slowFetcher) Do(req *http.Request) (*http.Response, error) {
	time.Sleep(s.delay)
	return s.inner.Do(req)
}

func TestBiomedTool_MatchNeverBlocksOnIndexLoad(t *testing.T) {
	b, err := biomed.NewBridge(t.TempDir(), biomed.WithFetcher(slowFetcher{biomedFixtures{gefitinibRoutes()}, 2 * time.Second}), biomed.WithThrottle(0))
	if err != nil {
		t.Fatal(err)
	}
	tool := NewBiomedToolWithBridge(b)
	start := time.Now()
	matched := tool.Match("ce doză de gefitinib iau")
	if el := time.Since(start); el > 500*time.Millisecond {
		t.Fatalf("Match blocked for %v while the index was loading", el)
	}
	if matched {
		t.Fatal("index not loaded yet: Match must be false, not block")
	}
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) && !tool.Match("ce doză de gefitinib iau") {
		time.Sleep(100 * time.Millisecond)
	}
	if !tool.Match("ce doză de gefitinib iau") {
		t.Fatal("index never became available")
	}
}

func TestRenderConsult_PairsMechanismsWithTheirOwnTarget(t *testing.T) {
	res := &biomed.ConsultResponse{Drugs: []biomed.DrugReport{{
		Drug: biomed.Drug{RxCUI: "1", Name: "x"},
		Mechanisms: []biomed.Mechanism{
			{Action: "MODULATOR", Description: "Unknown-target modulator", TargetChEMBLID: ""},
			{Action: "INHIBITOR", Description: "EGFR inhibitor", TargetChEMBLID: "CHEMBL203"},
		},
		Targets: []biomed.Target{{ChEMBLID: "CHEMBL203", PrefName: "Epidermal growth factor receptor", GeneSymbols: []string{"EGFR"}}},
	}}}
	out := RenderConsult(res, false)
	for _, ln := range strings.Split(out, "\n") {
		if strings.Contains(ln, "Unknown-target modulator") && strings.Contains(ln, "EGFR") {
			t.Fatalf("target attached to the wrong mechanism: %q", ln)
		}
		if strings.Contains(ln, "EGFR inhibitor") && !strings.Contains(ln, "EGFR") {
			t.Fatalf("mechanism lost its target: %q", ln)
		}
	}
}

func TestRenderConsult_NoPhaseWhenChEMBLHasNone(t *testing.T) {
	res := &biomed.ConsultResponse{Drugs: []biomed.DrugReport{{
		Drug:     biomed.Drug{RxCUI: "1", Name: "x"},
		Molecule: &biomed.Molecule{ChEMBLID: "CHEMBL5282669"},
	}}}
	out := RenderConsult(res, false)
	if strings.Contains(out, "phase 0") {
		t.Fatalf("a null max_phase must not render as phase 0:\n%s", out)
	}
}

// Live run 2026-09-21: the label chosen for "aspirin" may be a combination
// product; its generic names must be visible next to the set_id so a boxed
// warning about the other ingredient is not attributed to aspirin.
func TestRenderConsult_ShowsLabelGenericNames(t *testing.T) {
	res := &biomed.ConsultResponse{Drugs: []biomed.DrugReport{{
		Drug:  biomed.Drug{RxCUI: "1191", Name: "aspirin"},
		Label: &biomed.Label{SetID: "abc", EffectiveTime: "20260527", GenericNames: []string{"ASPIRIN", "BUTALBITAL", "CAFFEINE", "CODEINE"}, Sections: map[string]string{}},
	}}}
	out := RenderConsult(res, false)
	if !strings.Contains(out, "ASPIRIN, BUTALBITAL, CAFFEINE, CODEINE") {
		t.Fatalf("label line must list the label's generic names:\n%s", out)
	}
}
