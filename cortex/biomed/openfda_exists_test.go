package biomed

import (
	"context"
	"strings"
	"testing"
)

// Live run 2026-09-21: for aspirin the ten newest labels are all OTC stubs,
// so the label query must first ask openFDA for labels that actually carry
// the clinical sections (_exists_ filter) and only then fall back to any label.
func TestLabel_AsksForLabelsWithClinicalSectionsFirst(t *testing.T) {
	ff := newFixtureFetcher(t, map[string]string{
		`_exists_`: "openfda/label_gefitinib.json",
	})
	c := NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0))
	l, err := c.Label(context.Background(), "gefitinib")
	if err != nil {
		t.Fatal(err)
	}
	if l.SetID != "0afc12dd-12f8-4def-9027-f38412a862b9" {
		t.Fatalf("got %s", l.SetID)
	}
	if len(ff.calls) != 1 || !strings.Contains(ff.calls[0], "_exists_") {
		t.Fatalf("first request must carry the _exists_ filter and succeed alone: %v", ff.calls)
	}
}

func TestLabel_FallsBackToAnyLabelWhenNoneHasClinicalSections(t *testing.T) {
	ff := newFixtureFetcher(t, map[string]string{
		`%22aspirin%22&limit`: "openfda/label_stub.json", // plain query only; the _exists_ query 404s
	})
	c := NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0))
	l, err := c.Label(context.Background(), "aspirin")
	if err != nil {
		t.Fatal(err)
	}
	if l.SetID != "0058175f-3474-40c3-a046-6cfaec86d84b" {
		t.Fatalf("expected the stub label from the fallback query, got %s", l.SetID)
	}
	if len(ff.calls) != 2 {
		t.Fatalf("expected _exists_ query then plain query, got %v", ff.calls)
	}
}

// ChEMBL marks activities with no assigned target as "Unchecked"; those rows
// must not be reported as the drug's top potency.
func TestActivities_SkipsUncheckedTargets(t *testing.T) {
	ff := newFixtureFetcher(t, map[string]string{"activity.json?molecule_chembl_id=CHEMBL939": "chembl/act_unchecked_first.json"})
	c := NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0))
	acts, err := c.Activities(context.Background(), "CHEMBL939", 5)
	if err != nil || len(acts) == 0 {
		t.Fatalf("acts=%d err=%v", len(acts), err)
	}
	for _, a := range acts {
		if a.TargetName == "Unchecked" {
			t.Fatalf("Unchecked target reported: %+v", a)
		}
	}
	if acts[0].TargetChEMBLID != "CHEMBL203" {
		t.Fatalf("first real activity expected, got %+v", acts[0])
	}
}
