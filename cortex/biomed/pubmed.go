package biomed

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// PubMed E-utilities (NCBI) provide literature evidence: how many papers
// discuss a (drug, variant/disease) pair, and which ones.
// Endpoints (no API key, ≤3 req/s): esearch.fcgi, esummary.fcgi

const eutilsBase = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

// PubMedHits is the result of a literature search.
type PubMedHits struct {
	Query    string   `json:"query"`
	Count    int      `json:"count"`
	PMIDs    []string `json:"pmids"`
	Evidence Evidence `json:"evidence"`
}

// PubMedSummary is a citation.
type PubMedSummary struct {
	PMID    string `json:"pmid"`
	Title   string `json:"title"`
	Source  string `json:"source"` // journal abbreviation
	PubDate string `json:"pub_date"`
}

// PubMedSearch runs an esearch and returns the total count plus up to max PMIDs.
func (c *Client) PubMedSearch(ctx context.Context, term string, max int) (PubMedHits, error) {
	if max <= 0 {
		max = 5
	}
	u := fmt.Sprintf("%s/esearch.fcgi?db=pubmed&term=%s&retmax=%d&retmode=json", eutilsBase, url.QueryEscape(term), max)
	var out struct {
		Result struct {
			Count  string   `json:"count"`
			IDList []string `json:"idlist"`
		} `json:"esearchresult"`
	}
	if _, err := c.GetJSON(ctx, "pubmed", u, &out); err != nil {
		return PubMedHits{}, err
	}
	n, _ := strconv.Atoi(out.Result.Count)
	return PubMedHits{
		Query: term, Count: n, PMIDs: out.Result.IDList,
		Evidence: Evidence{Source: "pubmed", ID: "esearch:" + term, URL: u, Retrieved: time.Now().UTC(),
			Quote: fmt.Sprintf("%d PubMed records for %q", n, term)},
	}, nil
}

// PubMedSummaries fetches titles for PMIDs (no request for an empty list).
func (c *Client) PubMedSummaries(ctx context.Context, pmids []string) ([]PubMedSummary, error) {
	if len(pmids) == 0 {
		return nil, nil
	}
	u := fmt.Sprintf("%s/esummary.fcgi?db=pubmed&id=%s&retmode=json", eutilsBase, url.QueryEscape(strings.Join(pmids, ",")))
	var out struct {
		Result map[string]json.RawMessage `json:"result"`
	}
	if _, err := c.GetJSON(ctx, "pubmed", u, &out); err != nil {
		return nil, err
	}
	var uids []string
	if raw, ok := out.Result["uids"]; ok {
		_ = json.Unmarshal(raw, &uids)
	}
	res := make([]PubMedSummary, 0, len(uids))
	for _, id := range uids {
		raw, ok := out.Result[id]
		if !ok {
			continue
		}
		var rec struct {
			UID     string `json:"uid"`
			Title   string `json:"title"`
			Source  string `json:"source"`
			PubDate string `json:"pubdate"`
		}
		if err := json.Unmarshal(raw, &rec); err != nil {
			continue
		}
		res = append(res, PubMedSummary{PMID: rec.UID, Title: rec.Title, Source: rec.Source, PubDate: rec.PubDate})
	}
	return res, nil
}
