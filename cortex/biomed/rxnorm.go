package biomed

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// RxNorm (US National Library of Medicine) is the normalization authority for
// drug names: any spelling → RxCUI → canonical name.
//
// Endpoints (no API key):
//   https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=...
//   https://rxnav.nlm.nih.gov/REST/rxcui/{id}/properties.json
//   https://rxnav.nlm.nih.gov/REST/displaynames.json   (all display names)

const rxnormBase = "https://rxnav.nlm.nih.gov/REST"

// minApproxScore is the lowest approximateTerm score accepted as a match.
// Exact matches of ingredient names score about 14; this is a matching
// threshold, not medical knowledge.
const minApproxScore = 5.0

// Drug is a normalized drug identity.
type Drug struct {
	RxCUI    string   `json:"rxcui"`
	Name     string   `json:"name"`
	Evidence Evidence `json:"evidence"`
}

// NormalizeDrug resolves any spelling of a drug name to its RxCUI and
// canonical RxNorm name. Unknown names return ErrNotFound.
func (c *Client) NormalizeDrug(ctx context.Context, name string) (Drug, error) {
	term := strings.ToLower(strings.TrimSpace(name)) // RxNorm is case-insensitive; lowercase keeps one cache entry per name
	if term == "" {
		return Drug{}, fmt.Errorf("biomed/rxnorm: empty name: %w", ErrNotFound)
	}
	approxURL := fmt.Sprintf("%s/approximateTerm.json?term=%s&maxEntries=5", rxnormBase, url.QueryEscape(term))
	var approx struct {
		ApproximateGroup struct {
			Candidate []struct {
				RxCUI string `json:"rxcui"`
				Score string `json:"score"`
				Rank  string `json:"rank"`
				Name  string `json:"name"`
			} `json:"candidate"`
		} `json:"approximateGroup"`
	}
	if _, err := c.GetJSON(ctx, "rxnorm", approxURL, &approx); err != nil {
		return Drug{}, err
	}
	bestID, bestScore := "", -1.0
	for _, cand := range approx.ApproximateGroup.Candidate {
		score, _ := strconv.ParseFloat(cand.Score, 64)
		if cand.RxCUI != "" && score > bestScore {
			bestID, bestScore = cand.RxCUI, score
		}
	}
	if bestID == "" || bestScore < minApproxScore {
		return Drug{}, fmt.Errorf("biomed/rxnorm: %q (best score %.1f): %w", term, bestScore, ErrNotFound)
	}

	propsURL := fmt.Sprintf("%s/rxcui/%s/properties.json", rxnormBase, bestID)
	var props struct {
		Properties struct {
			RxCUI string `json:"rxcui"`
			Name  string `json:"name"`
		} `json:"properties"`
	}
	if _, err := c.GetJSON(ctx, "rxnorm", propsURL, &props); err != nil {
		return Drug{}, err
	}
	if props.Properties.RxCUI == "" {
		return Drug{}, fmt.Errorf("biomed/rxnorm: rxcui %s has no properties: %w", bestID, ErrNotFound)
	}
	return Drug{
		RxCUI: props.Properties.RxCUI,
		Name:  strings.ToLower(props.Properties.Name),
		Evidence: Evidence{
			Source:    "rxnorm",
			ID:        props.Properties.RxCUI,
			URL:       propsURL,
			Quote:     fmt.Sprintf("approximateTerm %q → rxcui %s (score %.1f)", term, bestID, bestScore),
			Retrieved: time.Now().UTC(),
		},
	}, nil
}

// DrugNameIndex is the set of all RxNorm display names, used to spot drug
// mentions in free text without any hand-written list.
type DrugNameIndex struct {
	names    map[string]struct{} // normalized (lowercase, single-spaced tokens)
	maxWords int
}

// minMentionLen: names shorter than this ("gold", "iron", "zinc") are common
// words and are not treated as mentions. Matching threshold, not knowledge.
const minMentionLen = 5

var wordRe = regexp.MustCompile(`[\p{L}\p{N}]+`)

// NewDrugNameIndex builds an index from raw names.
func NewDrugNameIndex(names []string) *DrugNameIndex {
	ix := &DrugNameIndex{names: make(map[string]struct{}, len(names))}
	for _, n := range names {
		norm, words := normalizeName(n)
		if len(norm) < minMentionLen || words == 0 {
			continue
		}
		ix.names[norm] = struct{}{}
		if words > ix.maxWords {
			ix.maxWords = words
		}
	}
	if ix.maxWords > 6 {
		ix.maxWords = 6 // long chemical names are matched by their leading tokens rarely; cap the n-gram window
	}
	return ix
}

// Len returns the number of indexed names.
func (ix *DrugNameIndex) Len() int { return len(ix.names) }

// Contains reports whether the normalized name is indexed.
func (ix *DrugNameIndex) Contains(name string) bool {
	norm, _ := normalizeName(name)
	_, ok := ix.names[norm]
	return ok
}

func normalizeName(s string) (string, int) {
	toks := wordRe.FindAllString(strings.ToLower(s), -1)
	return strings.Join(toks, " "), len(toks)
}

// LoadDrugNameIndex fetches (or reads from cache) the full RxNorm display-name
// list and builds the index.
func (c *Client) LoadDrugNameIndex(ctx context.Context) (*DrugNameIndex, error) {
	var out struct {
		DisplayTermsList struct {
			Term []string `json:"term"`
		} `json:"displayTermsList"`
	}
	if _, err := c.GetJSON(ctx, "rxnorm", rxnormBase+"/displaynames.json", &out); err != nil {
		return nil, err
	}
	if len(out.DisplayTermsList.Term) == 0 {
		return nil, fmt.Errorf("biomed/rxnorm: displaynames returned no terms: %w", ErrNotFound)
	}
	return NewDrugNameIndex(out.DisplayTermsList.Term), nil
}

// Mention is a drug name found in free text.
type Mention struct {
	Text  string `json:"text"` // normalized name as indexed
	Start int    `json:"start"`
	End   int    `json:"end"` // byte offsets into the original text
}

// FindMentions scans text for indexed names (1..maxWords tokens). Longest
// match wins; matches do not overlap; order follows the text.
func (ix *DrugNameIndex) FindMentions(text string) []Mention {
	lower := strings.ToLower(text)
	spans := wordRe.FindAllStringIndex(lower, -1)
	var out []Mention
	for i := 0; i < len(spans); {
		matched := false
		for n := min(ix.maxWords, len(spans)-i); n >= 1; n-- {
			var parts []string
			for k := i; k < i+n; k++ {
				parts = append(parts, lower[spans[k][0]:spans[k][1]])
			}
			key := strings.Join(parts, " ")
			if len(key) < minMentionLen {
				continue
			}
			if _, ok := ix.names[key]; ok {
				out = append(out, Mention{Text: key, Start: spans[i][0], End: spans[i+n-1][1]})
				i += n
				matched = true
				break
			}
		}
		if !matched {
			i++
		}
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].Start < out[b].Start })
	return out
}
