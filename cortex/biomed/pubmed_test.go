package biomed

import (
	"context"
	"testing"
)

func pubmedClient(t *testing.T) *Client {
	t.Helper()
	ff := newFixtureFetcher(t, map[string]string{
		"esearch.fcgi":  "pubmed/esearch.json",
		"esummary.fcgi": "pubmed/esummary.json",
	})
	return NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0))
}

func TestPubMedSearch_CountAndPMIDs(t *testing.T) {
	c := pubmedClient(t)
	h, err := c.PubMedSearch(context.Background(), "gefitinib AND T790M", 3)
	if err != nil {
		t.Fatal(err)
	}
	if h.Count != 811 || len(h.PMIDs) != 3 || h.PMIDs[0] != "42579877" {
		t.Fatalf("hits = %+v", h)
	}
	if h.Evidence.Source != "pubmed" || h.Evidence.URL == "" {
		t.Fatalf("evidence = %+v", h.Evidence)
	}
}

func TestPubMedSummaries_TitlesForPMIDs(t *testing.T) {
	c := pubmedClient(t)
	s, err := c.PubMedSummaries(context.Background(), []string{"42579877", "42570503"})
	if err != nil {
		t.Fatal(err)
	}
	if len(s) != 2 {
		t.Fatalf("summaries = %+v", s)
	}
	for _, x := range s {
		if x.PMID == "" || x.Title == "" || x.PubDate == "" {
			t.Fatalf("incomplete summary: %+v", x)
		}
	}
	if empty, err := c.PubMedSummaries(context.Background(), nil); err != nil || len(empty) != 0 {
		t.Fatalf("nil pmids must yield empty without a request: %v %v", empty, err)
	}
}
