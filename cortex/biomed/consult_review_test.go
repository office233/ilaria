package biomed

import (
	"context"
	"strings"
	"testing"
)

// Review 2026-09-21: two drugs in one question must be checked against each
// other even without a patient record, and absent label sections must be
// reported instead of silently yielding "no interaction".

func TestConsult_CrossChecksDrugsNamedTogetherWithoutPatient(t *testing.T) {
	b, _, _ := testBridge(t, allRoutes())
	res, err := b.Consult(context.Background(), ConsultRequest{Drugs: []string{"gefitinib", "warfarin"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Drugs) != 2 {
		t.Fatalf("drugs = %d", len(res.Drugs))
	}
	g := res.Drugs[0]
	if len(g.Interactions) != 1 || g.Interactions[0].WithDrug != "warfarin" || len(g.Interactions[0].Quotes) == 0 {
		t.Fatalf("gefitinib label mentions warfarin; interactions = %+v", g.Interactions)
	}
	joined := strings.ToLower(strings.Join(res.Missing, " | "))
	if !strings.Contains(joined, "warfarin") || !strings.Contains(joined, "label") {
		t.Fatalf("warfarin has no label fixture: Missing must say so, got %v", res.Missing)
	}
}

func TestConsult_ReportsAbsentLabelSections(t *testing.T) {
	routes := allRoutes()
	routes[`generic_name%3A%22gefitinib%22`] = "openfda/label_stub.json"
	b, _, _ := testBridge(t, routes)
	res, err := b.Consult(context.Background(), ConsultRequest{Drugs: []string{"gefitinib"}, Patient: t790mPatient()})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.ToLower(strings.Join(res.Drugs[0].Missing, " | "))
	for _, sec := range []string{"drug_interactions", "contraindications", "pharmacokinetics"} {
		if !strings.Contains(joined, sec) {
			t.Errorf("Missing must name absent section %s: %v", sec, res.Drugs[0].Missing)
		}
	}
	if len(res.Drugs[0].Interactions) != 0 {
		t.Fatalf("no drug_interactions section: interactions must be empty, got %+v", res.Drugs[0].Interactions)
	}
}
