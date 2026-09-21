package biomed

import (
	"context"
	"testing"
)

func otClient(t *testing.T) *Client {
	t.Helper()
	ff := newFixtureFetcher(t, map[string]string{
		"POST:opentargets|search(":         "opentargets/search_disease.json",
		"POST:opentargets|ENSG00000146648": "opentargets/target_EGFR.json",
		"POST:opentargets|MONDO_0005233":   "opentargets/disease_NSCLC.json",
	})
	return NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0))
}

func TestOTSearch_DiseaseResolvesToMONDO(t *testing.T) {
	c := otClient(t)
	hits, err := c.OTSearch(context.Background(), "non-small cell lung carcinoma", "disease")
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) < 1 || hits[0].ID != "MONDO_0005233" || hits[0].Name != "non-small cell lung carcinoma" || hits[0].Entity != "disease" {
		t.Fatalf("hits = %+v", hits)
	}
}

func TestOTTarget_EGFRAssociationsAndCandidates(t *testing.T) {
	c := otClient(t)
	tg, err := c.OTTarget(context.Background(), "ENSG00000146648", 3)
	if err != nil {
		t.Fatal(err)
	}
	if tg.Symbol != "EGFR" || tg.Name != "epidermal growth factor receptor" {
		t.Fatalf("target = %+v", tg)
	}
	if len(tg.Diseases) != 3 || tg.Diseases[0].DiseaseID != "MONDO_0005233" || tg.Diseases[0].Score < 0.8 {
		t.Fatalf("diseases = %+v", tg.Diseases)
	}
	if tg.CandidateCount != 82 || len(tg.Candidates) == 0 || tg.Candidates[0].DrugChEMBLID == "" || tg.Candidates[0].MaxClinicalStage == "" {
		t.Fatalf("candidates = %d %+v", tg.CandidateCount, tg.Candidates)
	}
	if tg.Evidence.Source != "opentargets" || tg.Evidence.ID != "ENSG00000146648" {
		t.Fatalf("evidence = %+v", tg.Evidence)
	}
}

func TestOTDisease_NSCLCCandidatesAndTargets(t *testing.T) {
	c := otClient(t)
	d, err := c.OTDisease(context.Background(), "MONDO_0005233", 3)
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "non-small cell lung carcinoma" || d.CandidateCount != 1072 || len(d.Candidates) == 0 {
		t.Fatalf("disease = %+v", d)
	}
	if len(d.Targets) != 3 || d.Targets[0].Symbol == "" || d.Targets[0].Score <= 0 {
		t.Fatalf("targets = %+v", d.Targets)
	}
}
