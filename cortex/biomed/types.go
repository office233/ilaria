// Package biomed is Ilaria's biomedical knowledge organ.
//
// Every fact it returns is fetched from a public, authoritative source
// (RxNorm, ChEMBL, openFDA, Open Targets, PubMed) and carries an Evidence
// record saying where it came from. Nothing is hardcoded; when a source has
// no data the function returns an error or a nil field, never a default.
//
// The package must not import nexus-cortex/cortex (the organism adapter
// lives in package cortex to avoid an import cycle).
package biomed

import "time"

// Evidence records where a claim came from so the caller can verify it.
type Evidence struct {
	Source    string    `json:"source"` // rxnorm | chembl | openfda | opentargets | pubmed
	ID        string    `json:"id"`     // source-specific identifier (RxCUI, ChEMBL ID, set_id, EFO/MONDO ID, PMID)
	URL       string    `json:"url"`    // the request that produced the data
	Quote     string    `json:"quote,omitempty"`
	Retrieved time.Time `json:"retrieved"`
}

// Patient is the caller-supplied clinical context. Every field is optional;
// absent data stays absent (no "normal" defaults are ever filled in).
type Patient struct {
	ID                string         `json:"id,omitempty"`
	Sex               string         `json:"sex,omitempty"` // "M" | "F" | "" (unknown)
	Age               *int           `json:"age,omitempty"`
	ActiveMedications []string       `json:"active_medications,omitempty"`
	Conditions        []string       `json:"conditions,omitempty"`
	Variants          []Variant      `json:"variants,omitempty"`
	Labs              map[string]Lab `json:"labs,omitempty"` // keyed by the observation name as recorded (e.g. "eGFR", "ALT")
}

// Variant is a genomic variant, e.g. {Gene: "EGFR", Change: "T790M"}.
type Variant struct {
	Gene   string `json:"gene"`
	Change string `json:"change"`
}

// String renders the variant the way it is written in labels and papers.
func (v Variant) String() string {
	if v.Gene == "" {
		return v.Change
	}
	if v.Change == "" {
		return v.Gene
	}
	return v.Gene + " " + v.Change
}

// Lab is one measured observation.
type Lab struct {
	Value    float64   `json:"value"`
	Unit     string    `json:"unit,omitempty"`
	Observed time.Time `json:"observed,omitempty"`
}
