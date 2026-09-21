package biomed

import (
	"context"
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

// Label is one FDA prescribing-information document.
type Label struct {
	SetID         string            `json:"set_id"`
	EffectiveTime string            `json:"effective_time"`
	GenericNames  []string          `json:"generic_names"`
	BrandNames    []string          `json:"brand_names,omitempty"`
	Sections      map[string]string `json:"sections"`
	Evidence      Evidence          `json:"evidence"`
}

// Label fetches the most recent label whose generic name matches.
func (c *Client) Label(ctx context.Context, genericName string) (Label, error) {
	name := strings.ToLower(strings.TrimSpace(genericName))
	search := fmt.Sprintf(`openfda.generic_name:"%s"`, name)
	u := fmt.Sprintf("%s?search=%s&limit=1", openfdaBase, url.QueryEscape(search))
	var out struct {
		Results []map[string]any `json:"results"`
	}
	if _, err := c.GetJSON(ctx, "openfda", u, &out); err != nil {
		return Label{}, err
	}
	if len(out.Results) == 0 {
		return Label{}, fmt.Errorf("biomed/openfda: no label for %q: %w", name, ErrNotFound)
	}
	r := out.Results[0]
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
		Quote: fmt.Sprintf("FDA label set_id %s effective %s", l.SetID, l.EffectiveTime),
	}
	return l, nil
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
			if len(s) > 600 {
				s = s[:600] + "…"
			}
			hits = append(hits, s)
		}
	}
	return hits
}
