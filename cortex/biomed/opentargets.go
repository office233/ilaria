package biomed

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Open Targets Platform (EMBL-EBI / GSK / Sanger consortium) links targets,
// diseases and drugs with evidence-weighted association scores.
// Endpoint (no API key): https://api.platform.opentargets.org/api/v4/graphql
// Field names follow the schema introspected on 2026-09-21
// (drugAndClinicalCandidates replaced the older knownDrugs).

const opentargetsURL = "https://api.platform.opentargets.org/api/v4/graphql"

// OTEntity is a search hit.
type OTEntity struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Entity string `json:"entity"` // disease | target | drug
}

// DiseaseAssociation is a target→disease association with its overall score.
type DiseaseAssociation struct {
	DiseaseID   string  `json:"disease_id"`
	DiseaseName string  `json:"disease_name"`
	Score       float64 `json:"score"`
}

// TargetAssociation is a disease→target association with its overall score.
type TargetAssociation struct {
	TargetID string  `json:"target_id"`
	Symbol   string  `json:"symbol"`
	Score    float64 `json:"score"`
}

// ClinicalCandidate is a drug that reached a clinical stage for the entity.
type ClinicalCandidate struct {
	DrugChEMBLID     string `json:"drug_chembl_id"`
	DrugName         string `json:"drug_name"`
	MaxClinicalStage string `json:"max_clinical_stage"` // PHASE_1..PHASE_3, APPROVAL, ...
}

// OTTarget is a gene/protein target with its top diseases and drugs.
type OTTarget struct {
	ID             string               `json:"id"` // Ensembl gene ID
	Symbol         string               `json:"symbol"`
	Name           string               `json:"name"`
	Diseases       []DiseaseAssociation `json:"diseases"`
	CandidateCount int                  `json:"candidate_count"`
	Candidates     []ClinicalCandidate  `json:"candidates"`
	Evidence       Evidence             `json:"evidence"`
}

// OTDisease is a disease with its top targets and clinical-stage drugs.
type OTDisease struct {
	ID             string              `json:"id"` // EFO / MONDO ID
	Name           string              `json:"name"`
	Targets        []TargetAssociation `json:"targets"`
	CandidateCount int                 `json:"candidate_count"`
	Candidates     []ClinicalCandidate `json:"candidates"`
	Evidence       Evidence            `json:"evidence"`
}

type gqlRequest struct {
	Query string `json:"query"`
}

type gqlError struct {
	Message string `json:"message"`
}

func gqlString(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", " ").Replace(s) + `"`
}

// OTSearch finds entities by free text. entity ∈ {disease,target,drug}.
func (c *Client) OTSearch(ctx context.Context, query, entity string) ([]OTEntity, error) {
	q := fmt.Sprintf(`{ search(queryString:%s, entityNames:[%s], page:{index:0,size:5}) { hits { id name entity } } }`,
		gqlString(strings.TrimSpace(query)), gqlString(entity))
	var out struct {
		Data struct {
			Search struct {
				Hits []OTEntity `json:"hits"`
			} `json:"search"`
		} `json:"data"`
		Errors []gqlError `json:"errors"`
	}
	if _, err := c.PostJSON(ctx, "opentargets", opentargetsURL, gqlRequest{Query: q}, &out); err != nil {
		return nil, err
	}
	if len(out.Errors) > 0 {
		return nil, fmt.Errorf("biomed/opentargets: %s", out.Errors[0].Message)
	}
	return out.Data.Search.Hits, nil
}

// OTTarget fetches a target by Ensembl ID with its top-n diseases.
func (c *Client) OTTarget(ctx context.Context, ensemblID string, n int) (OTTarget, error) {
	if n <= 0 {
		n = 5
	}
	q := fmt.Sprintf(`{ target(ensemblId:%s) { id approvedSymbol approvedName associatedDiseases(page:{index:0,size:%d}) { count rows { score disease { id name } } } drugAndClinicalCandidates { count rows { maxClinicalStage drug { id name } } } } }`,
		gqlString(ensemblID), n)
	var out struct {
		Data struct {
			Target *struct {
				ID       string `json:"id"`
				Symbol   string `json:"approvedSymbol"`
				Name     string `json:"approvedName"`
				Diseases struct {
					Rows []struct {
						Score   float64 `json:"score"`
						Disease struct {
							ID   string `json:"id"`
							Name string `json:"name"`
						} `json:"disease"`
					} `json:"rows"`
				} `json:"associatedDiseases"`
				Drugs struct {
					Count int `json:"count"`
					Rows  []struct {
						Stage string `json:"maxClinicalStage"`
						Drug  struct {
							ID   string `json:"id"`
							Name string `json:"name"`
						} `json:"drug"`
					} `json:"rows"`
				} `json:"drugAndClinicalCandidates"`
			} `json:"target"`
		} `json:"data"`
		Errors []gqlError `json:"errors"`
	}
	if _, err := c.PostJSON(ctx, "opentargets", opentargetsURL, gqlRequest{Query: q}, &out); err != nil {
		return OTTarget{}, err
	}
	if len(out.Errors) > 0 {
		return OTTarget{}, fmt.Errorf("biomed/opentargets: %s", out.Errors[0].Message)
	}
	t := out.Data.Target
	if t == nil {
		return OTTarget{}, fmt.Errorf("biomed/opentargets: target %s: %w", ensemblID, ErrNotFound)
	}
	res := OTTarget{ID: t.ID, Symbol: t.Symbol, Name: t.Name, CandidateCount: t.Drugs.Count,
		Evidence: Evidence{Source: "opentargets", ID: t.ID, URL: opentargetsURL, Quote: t.Symbol + ": " + t.Name, Retrieved: time.Now().UTC()}}
	for _, r := range t.Diseases.Rows {
		res.Diseases = append(res.Diseases, DiseaseAssociation{DiseaseID: r.Disease.ID, DiseaseName: r.Disease.Name, Score: r.Score})
	}
	for _, r := range t.Drugs.Rows {
		res.Candidates = append(res.Candidates, ClinicalCandidate{DrugChEMBLID: r.Drug.ID, DrugName: r.Drug.Name, MaxClinicalStage: r.Stage})
	}
	return res, nil
}

// OTDisease fetches a disease by EFO/MONDO ID with its top-n targets.
func (c *Client) OTDisease(ctx context.Context, efoID string, n int) (OTDisease, error) {
	if n <= 0 {
		n = 5
	}
	q := fmt.Sprintf(`{ disease(efoId:%s) { id name drugAndClinicalCandidates { count rows { maxClinicalStage drug { id name } } } associatedTargets(page:{index:0,size:%d}) { count rows { score target { id approvedSymbol } } } } }`,
		gqlString(efoID), n)
	var out struct {
		Data struct {
			Disease *struct {
				ID    string `json:"id"`
				Name  string `json:"name"`
				Drugs struct {
					Count int `json:"count"`
					Rows  []struct {
						Stage string `json:"maxClinicalStage"`
						Drug  struct {
							ID   string `json:"id"`
							Name string `json:"name"`
						} `json:"drug"`
					} `json:"rows"`
				} `json:"drugAndClinicalCandidates"`
				Targets struct {
					Rows []struct {
						Score  float64 `json:"score"`
						Target struct {
							ID     string `json:"id"`
							Symbol string `json:"approvedSymbol"`
						} `json:"target"`
					} `json:"rows"`
				} `json:"associatedTargets"`
			} `json:"disease"`
		} `json:"data"`
		Errors []gqlError `json:"errors"`
	}
	if _, err := c.PostJSON(ctx, "opentargets", opentargetsURL, gqlRequest{Query: q}, &out); err != nil {
		return OTDisease{}, err
	}
	if len(out.Errors) > 0 {
		return OTDisease{}, fmt.Errorf("biomed/opentargets: %s", out.Errors[0].Message)
	}
	d := out.Data.Disease
	if d == nil {
		return OTDisease{}, fmt.Errorf("biomed/opentargets: disease %s: %w", efoID, ErrNotFound)
	}
	res := OTDisease{ID: d.ID, Name: d.Name, CandidateCount: d.Drugs.Count,
		Evidence: Evidence{Source: "opentargets", ID: d.ID, URL: opentargetsURL, Quote: d.Name, Retrieved: time.Now().UTC()}}
	for _, r := range d.Drugs.Rows {
		res.Candidates = append(res.Candidates, ClinicalCandidate{DrugChEMBLID: r.Drug.ID, DrugName: r.Drug.Name, MaxClinicalStage: r.Stage})
	}
	for _, r := range d.Targets.Rows {
		res.Targets = append(res.Targets, TargetAssociation{TargetID: r.Target.ID, Symbol: r.Target.Symbol, Score: r.Score})
	}
	return res, nil
}
