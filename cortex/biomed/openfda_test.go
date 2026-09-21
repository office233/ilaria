package biomed

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func openfdaClient(t *testing.T) *Client {
	t.Helper()
	ff := newFixtureFetcher(t, map[string]string{
		`generic_name%3A%22gefitinib%22`: "openfda/label_gefitinib.json",
	})
	return NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0))
}

func TestLabel_GefitinibSectionsAndIdentity(t *testing.T) {
	c := openfdaClient(t)
	l, err := c.Label(context.Background(), "gefitinib")
	if err != nil {
		t.Fatal(err)
	}
	if l.SetID != "0afc12dd-12f8-4def-9027-f38412a862b9" || l.EffectiveTime != "20230222" {
		t.Fatalf("identity = %+v", l)
	}
	if len(l.GenericNames) != 1 || l.GenericNames[0] != "GEFITINIB" {
		t.Fatalf("generic names = %v", l.GenericNames)
	}
	for _, sec := range []string{"drug_interactions", "contraindications", "pharmacokinetics", "use_in_specific_populations", "dosage_and_administration", "warnings_and_cautions"} {
		if l.Sections[sec] == "" {
			t.Errorf("section %s missing", sec)
		}
	}
	if l.Evidence.Source != "openfda" || l.Evidence.ID != l.SetID {
		t.Fatalf("evidence = %+v", l.Evidence)
	}
}

func TestLabel_UnknownDrugIsErrNotFound(t *testing.T) {
	c := openfdaClient(t)
	_, err := c.Label(context.Background(), "zzzzqq")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}

func TestLabel_FindInSectionReturnsSentencesWithTerm(t *testing.T) {
	c := openfdaClient(t)
	l, err := c.Label(context.Background(), "gefitinib")
	if err != nil {
		t.Fatal(err)
	}
	hits := l.FindInSection("drug_interactions", "warfarin")
	if len(hits) == 0 {
		t.Fatal("expected sentences mentioning warfarin in drug_interactions")
	}
	for _, h := range hits {
		if !strings.Contains(strings.ToLower(h), "warfarin") {
			t.Fatalf("sentence does not contain term: %q", h)
		}
		if len(h) > 600 {
			t.Fatalf("sentence too long (not split): %d chars", len(h))
		}
	}
	if got := l.FindInSection("drug_interactions", "zzzzqq"); len(got) != 0 {
		t.Fatalf("expected no hits, got %v", got)
	}
	if got := l.FindInSection("no_such_section", "warfarin"); len(got) != 0 {
		t.Fatalf("missing section must yield no hits, got %v", got)
	}
}
