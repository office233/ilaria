package biomed

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// ParseFHIRBundle converts an HL7 FHIR Bundle (Patient, Condition,
// MedicationRequest/MedicationStatement, Observation) into a Patient.
// Fields the bundle does not state stay absent; no "normal" values are
// ever assumed.
func ParseFHIRBundle(raw []byte) (*Patient, error) {
	var bundle struct {
		ResourceType string `json:"resourceType"`
		Entry        []struct {
			Resource map[string]any `json:"resource"`
		} `json:"entry"`
	}
	if err := json.Unmarshal(raw, &bundle); err != nil {
		return nil, fmt.Errorf("biomed/fhir: invalid bundle JSON: %w", err)
	}
	p := &Patient{Labs: map[string]Lab{}}
	for _, e := range bundle.Entry {
		res := e.Resource
		switch res["resourceType"] {
		case "Patient":
			if id, ok := res["id"].(string); ok {
				p.ID = id
			}
			switch strings.ToLower(str(res["gender"])) {
			case "female":
				p.Sex = "F"
			case "male":
				p.Sex = "M"
			}
			if bd, ok := res["birthDate"].(string); ok {
				if t, err := time.Parse("2006-01-02", bd); err == nil {
					age := yearsSince(t, time.Now())
					p.Age = &age
				}
			}
		case "Condition":
			if name := conceptText(res["code"]); name != "" {
				p.Conditions = append(p.Conditions, name)
			}
		case "MedicationRequest", "MedicationStatement":
			if name := conceptText(res["medicationCodeableConcept"]); name != "" {
				p.ActiveMedications = append(p.ActiveMedications, name)
			}
		case "Observation":
			parseObservation(res, p)
		}
	}
	return p, nil
}

func parseObservation(res map[string]any, p *Patient) {
	name := conceptText(res["code"])
	// Genomic variant reported as components {gene, variant}.
	if comps, ok := res["component"].([]any); ok {
		var gene, change string
		for _, c := range comps {
			cm, ok := c.(map[string]any)
			if !ok {
				continue
			}
			key := strings.ToLower(conceptText(cm["code"]))
			val := str(cm["valueString"])
			switch {
			case strings.Contains(key, "gene"):
				gene = val
			case strings.Contains(key, "variant") || strings.Contains(key, "change") || strings.Contains(key, "allele"):
				change = val
			}
		}
		if gene != "" || change != "" {
			p.Variants = append(p.Variants, Variant{Gene: gene, Change: change})
			return
		}
	}
	vq, ok := res["valueQuantity"].(map[string]any)
	if !ok || name == "" {
		return
	}
	val, ok := vq["value"].(float64)
	if !ok {
		return
	}
	lab := Lab{Value: val, Unit: str(vq["unit"])}
	if ts, ok := res["effectiveDateTime"].(string); ok {
		if t, err := time.Parse(time.RFC3339, ts); err == nil {
			lab.Observed = t
		}
	}
	p.Labs[name] = lab
}

// conceptText returns CodeableConcept.text, else the first coding's display,
// else the first coding's code.
func conceptText(v any) string {
	cc, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	if t := str(cc["text"]); t != "" {
		return t
	}
	if codings, ok := cc["coding"].([]any); ok && len(codings) > 0 {
		if c0, ok := codings[0].(map[string]any); ok {
			if d := str(c0["display"]); d != "" {
				return d
			}
			return str(c0["code"])
		}
	}
	return ""
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func yearsSince(birth, now time.Time) int {
	years := now.Year() - birth.Year()
	if now.YearDay() < birth.YearDay() {
		years--
	}
	return years
}
