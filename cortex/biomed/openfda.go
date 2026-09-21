package biomed

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// openFDA serves the official FDA prescribing information (SPL labels).
// Endpoint (no API key, 240 req/min anonymous): https://api.fda.gov/drug/label.json

const openfdaBase = "https://api.fda.gov/drug/label.json"

// labelSections are the SPL sections we keep; other keys (tables, packaging)
// are dropped to keep the cache lean. This is a schema choice, not knowledge.
var labelSections = []string{
	"boxed_warning", "indications_and_usage", "dosage_and_administration",
	"contraindications", "warnings_and_cautions", "warnings", "drug_interactions",
	"use_in_specific_populations", "clinical_pharmacology", "mechanism_of_action",
	"pharmacokinetics", "clinical_studies", "adverse_reactions", "overdosage",
}

// clinicalSections decide which of several labels for the same generic name
// is the informative one (OTC repackager stubs carry none of these).
var clinicalSections = []string{
	"drug_interactions", "contraindications", "pharmacokinetics",
	"clinical_pharmacology", "warnings_and_cautions", "use_in_specific_populations",
}

// labelCandidates is how many labels are fetched (newest first) before choosing;
// singleIngredientBonus outweighs a few extra sections but not a full label.
const (
	labelCandidates       = 10
	singleIngredientBonus = 3
)

// Label is one FDA prescribing-information document.
type Label struct {
	SetID         string            `json:"set_id"`
	EffectiveTime string            `json:"effective_time"`
	GenericNames  []string          `json:"generic_names"`
	BrandNames    []string          `json:"brand_names,omitempty"`
	Sections      map[string]string `json:"sections"`
	Evidence      Evidence          `json:"evidence"`
}

// Label fetches up to labelCandidates labels for the generic name, newest
// first, preferring labels that carry a drug_interactions section (openFDA
// `_exists_` filter; OTC repackager stubs have none) and falling back to any
// label. Among the candidates the one with the most clinical sections wins
// (single-ingredient labels get a bonus; ties go to the newest).
// A generic name with no label at all is ErrNotFound.
func (c *Client) Label(ctx context.Context, genericName string) (Label, error) {
	name := strings.ToLower(strings.TrimSpace(genericName))
	base := fmt.Sprintf(`openfda.generic_name:"%s"`, name)
	results, u, err := c.fetchLabels(ctx, base+" AND _exists_:drug_interactions")
	if err != nil && !errors.Is(err, ErrNotFound) {
		return Label{}, err
	}
	if len(results) == 0 {
		if results, u, err = c.fetchLabels(ctx, base); err != nil {
			return Label{}, err
		}
	}
	if len(results) == 0 {
		return Label{}, fmt.Errorf("biomed/openfda: no label for %q: %w", name, ErrNotFound)
	}
	return chooseLabel(results, name, u), nil
}

func (c *Client) fetchLabels(ctx context.Context, search string) ([]map[string]any, string, error) {
	u := fmt.Sprintf("%s?search=%s&limit=%d&sort=effective_time:desc", openfdaBase, url.QueryEscape(search), labelCandidates)
	var out struct {
		Results []map[string]any `json:"results"`
	}
	if _, err := c.GetJSON(ctx, "openfda", u, &out); err != nil {
		return nil, u, err
	}
	return out.Results, u, nil
}

func chooseLabel(results []map[string]any, name, u string) Label {
	best, bestScore := -1, -1
	for i, r := range results {
		score := 0
		for _, sec := range clinicalSections {
			if len(anyStrings(r[sec])) > 0 {
				score++
			}
		}
		// A single-ingredient label for exactly this generic name beats a
		// combination product (butalbital/aspirin/caffeine) with the same sections.
		if of, ok := r["openfda"].(map[string]any); ok {
			if gn := anyStrings(of["generic_name"]); len(gn) == 1 && strings.EqualFold(gn[0], name) {
				score += singleIngredientBonus
			}
		}
		if score > bestScore {
			best, bestScore = i, score
		}
	}
	r := results[best]
	l := Label{Sections: map[string]string{}}
	l.SetID, _ = r["set_id"].(string)
	l.EffectiveTime, _ = r["effective_time"].(string)
	if of, ok := r["openfda"].(map[string]any); ok {
		l.GenericNames = anyStrings(of["generic_name"])
		l.BrandNames = anyStrings(of["brand_name"])
	}
	for _, sec := range labelSections {
		if txt := strings.TrimSpace(strings.Join(anyStrings(r[sec]), "\n")); txt != "" {
			l.Sections[sec] = txt
		}
	}
	l.Evidence = Evidence{
		Source: "openfda", ID: l.SetID, URL: u, Retrieved: time.Now().UTC(),
		Quote: fmt.Sprintf("FDA label set_id %s effective %s (chosen among %d results, score %d)", l.SetID, l.EffectiveTime, len(results), bestScore),
	}
	return l
}

// MissingSections returns which of the named sections the label lacks.
func (l Label) MissingSections(names ...string) []string {
	var missing []string
	for _, n := range names {
		if l.Sections[n] == "" {
			missing = append(missing, n)
		}
	}
	return missing
}

func anyStrings(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// sentenceEnd splits on ". ", "? ", "! " or newlines. Abbreviations ("e.g.")
// may over-split; that only shortens a quote, never invents one.
var sentenceEnd = regexp.MustCompile(`(?:[.?!]\s+|\n+)`)

// FindInSection returns the sentences of a section that contain term
// (case-insensitive). Missing section or no hits → empty slice.
func (l Label) FindInSection(section, term string) []string {
	text := l.Sections[section]
	if text == "" || strings.TrimSpace(term) == "" {
		return nil
	}
	needle := strings.ToLower(term)
	var hits []string
	for _, s := range sentenceEnd.Split(text, -1) {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if strings.Contains(strings.ToLower(s), needle) {
			hits = append(hits, truncateRunes(s, 600))
		}
	}
	return hits
}
