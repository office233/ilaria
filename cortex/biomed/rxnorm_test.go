package biomed

import (
	"context"
	"errors"
	"testing"
)

func rxnormClient(t *testing.T) (*Client, *fixtureFetcher) {
	t.Helper()
	ff := newFixtureFetcher(t, map[string]string{
		"approximateTerm.json?term=gefitinib": "rxnorm/approx_gefitinib.json",
		"approximateTerm.json?term=gefitnib":  "rxnorm/approx_gefitinib.json", // typo still resolves
		"approximateTerm.json?term=zzzzqq":    "rxnorm/approx_none.json",
		"rxcui/328134/properties":             "rxnorm/props_328134.json",
		"displaynames.json":                   "rxnorm/displaynames.json",
	})
	return NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0)), ff
}

func TestNormalizeDrug_ResolvesCanonicalNameAndRxCUI(t *testing.T) {
	c, _ := rxnormClient(t)
	d, err := c.NormalizeDrug(context.Background(), "Gefitinib")
	if err != nil {
		t.Fatal(err)
	}
	if d.RxCUI != "328134" || d.Name != "gefitinib" {
		t.Fatalf("got %+v", d)
	}
	if d.Evidence.Source != "rxnorm" || d.Evidence.ID != "328134" || d.Evidence.URL == "" {
		t.Fatalf("evidence incomplete: %+v", d.Evidence)
	}
}

func TestNormalizeDrug_TypoResolvesViaApproximateMatch(t *testing.T) {
	c, _ := rxnormClient(t)
	d, err := c.NormalizeDrug(context.Background(), "gefitnib")
	if err != nil {
		t.Fatal(err)
	}
	if d.RxCUI != "328134" {
		t.Fatalf("got %+v", d)
	}
}

func TestNormalizeDrug_UnknownIsErrNotFound(t *testing.T) {
	c, _ := rxnormClient(t)
	_, err := c.NormalizeDrug(context.Background(), "zzzzqq")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestDrugNameIndex_FindsMentionsInRomanianSentence(t *testing.T) {
	c, ff := rxnormClient(t)
	ix, err := c.LoadDrugNameIndex(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if ix.Len() < 100 {
		t.Fatalf("index too small: %d", ix.Len())
	}
	m := ix.FindMentions("Pacientul ia Gefitinib și metformin zilnic, fără warfarină.")
	if len(m) != 2 || m[0].Text != "gefitinib" || m[1].Text != "metformin" {
		t.Fatalf("mentions = %+v", m)
	}
	if m[0].Start >= m[0].End || m[1].Start <= m[0].End {
		t.Fatalf("bad offsets: %+v", m)
	}
	if n := ix.FindMentions("no drugs are mentioned in this sentence"); len(n) != 0 {
		t.Fatalf("false positives: %+v", n)
	}
	// Loading again must come from cache: exactly one network call for the index.
	if _, err := c.LoadDrugNameIndex(context.Background()); err != nil {
		t.Fatal(err)
	}
	calls := 0
	for _, call := range ff.calls {
		if contains(call, "displaynames") {
			calls++
		}
	}
	if calls != 1 {
		t.Fatalf("displaynames fetched %d times, want 1", calls)
	}
}

func TestDrugNameIndex_LongestMatchWinsAndNoOverlap(t *testing.T) {
	ix := NewDrugNameIndex([]string{"aspirin", "aspirin 81 mg oral tablet", "warfarin"})
	m := ix.FindMentions("she takes Aspirin 81 mg oral tablet with warfarin")
	if len(m) != 2 || m[0].Text != "aspirin 81 mg oral tablet" || m[1].Text != "warfarin" {
		t.Fatalf("mentions = %+v", m)
	}
}

func TestDrugNameIndex_IgnoresShortNames(t *testing.T) {
	ix := NewDrugNameIndex([]string{"gold", "iron", "zinc", "acetaminophen"})
	if m := ix.FindMentions("the gold and iron prices rose"); len(m) != 0 {
		t.Fatalf("short generic words must not be mentions: %+v", m)
	}
	if m := ix.FindMentions("took acetaminophen"); len(m) != 1 {
		t.Fatalf("expected one mention, got %+v", m)
	}
}

func contains(s, sub string) bool {
	return len(sub) > 0 && len(s) >= len(sub) && indexOf(s, sub) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
