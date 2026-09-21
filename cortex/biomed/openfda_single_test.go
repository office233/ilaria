package biomed

import (
	"context"
	"strings"
	"testing"
)

// Live run 2026-09-21: openfda.generic_name:"aspirin" also matches
// combination products (butalbital/aspirin/caffeine). A single-ingredient
// label must win over a newer combination label with the same sections.
func TestLabel_PrefersSingleIngredientOverCombination(t *testing.T) {
	ff := newFixtureFetcher(t, map[string]string{`generic_name%3A%22aspirin%22`: "openfda/label_aspirin_combo_first.json"})
	c := NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0))
	l, err := c.Label(context.Background(), "aspirin")
	if err != nil {
		t.Fatal(err)
	}
	if l.SetID != "single-0000" {
		t.Fatalf("picked %s (%v) instead of the single-ingredient label", l.SetID, l.GenericNames)
	}
}

// Live run 2026-09-21: the most potent ChEMBL record for aspirin is against
// an unrelated enzyme. When the mechanism names a target, activities must be
// requested for that target.
func TestActivities_FilteredByTargetWhenGiven(t *testing.T) {
	ff := newFixtureFetcher(t, map[string]string{"activity.json?molecule_chembl_id=CHEMBL939": "chembl/act_CHEMBL939.json"})
	c := NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0))
	acts, err := c.ActivitiesForTarget(context.Background(), "CHEMBL939", "CHEMBL203", 5)
	if err != nil || len(acts) == 0 {
		t.Fatalf("acts=%d err=%v", len(acts), err)
	}
	found := false
	for _, call := range ff.calls {
		if strings.Contains(call, "activity.json") && strings.Contains(call, "target_chembl_id=CHEMBL203") {
			found = true
		}
	}
	if !found {
		t.Fatalf("activity request must be filtered by target: %v", ff.calls)
	}
}
