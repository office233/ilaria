package biomed

import (
	"context"
	"strings"
	"testing"
)

// Review 2026-09-21: openFDA with limit=1 and no sort returns an arbitrary
// (often stub) label; we must fetch several, newest first, and keep the one
// that actually carries the sections we consult.

func TestLabel_PicksNewestResultThatHasClinicalSections(t *testing.T) {
	ff := newFixtureFetcher(t, map[string]string{
		`generic_name%3A%22aspirin%22`: "openfda/label_aspirin_multi.json",
	})
	c := NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0))
	l, err := c.Label(context.Background(), "aspirin")
	if err != nil {
		t.Fatal(err)
	}
	if l.SetID != "0afc12dd-12f8-4def-9027-f38412a862b9" {
		t.Fatalf("picked the stub label %s instead of the full one", l.SetID)
	}
	if l.Sections["drug_interactions"] == "" {
		t.Fatal("full label must carry drug_interactions")
	}
	for _, call := range ff.calls {
		if strings.Contains(call, "label.json") && (!strings.Contains(call, "sort=effective_time") || strings.Contains(call, "limit=1&")) {
			t.Fatalf("label request must sort newest-first and fetch several: %s", call)
		}
	}
}

func TestLabel_StubOnlyResultStillReturnedWithMissingSections(t *testing.T) {
	ff := newFixtureFetcher(t, map[string]string{`generic_name%3A%22aspirin%22`: "openfda/label_stub.json"})
	c := NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0))
	l, err := c.Label(context.Background(), "aspirin")
	if err != nil {
		t.Fatal(err)
	}
	missing := l.MissingSections("drug_interactions", "contraindications", "pharmacokinetics")
	if len(missing) != 3 {
		t.Fatalf("stub label must report the absent sections, got %v", missing)
	}
}
