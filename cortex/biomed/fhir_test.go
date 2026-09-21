package biomed

import (
	"testing"
	"time"
)

const fhirBundle = `{
  "resourceType": "Bundle",
  "entry": [
    {"resource": {"resourceType": "Patient", "id": "p-42", "gender": "female", "birthDate": "1960-05-01"}},
    {"resource": {"resourceType": "Condition", "code": {"text": "Non-small cell lung carcinoma"}}},
    {"resource": {"resourceType": "Condition", "code": {"coding": [{"system": "http://snomed.info/sct", "code": "44054006", "display": "Type 2 diabetes mellitus"}]}}},
    {"resource": {"resourceType": "MedicationRequest", "medicationCodeableConcept": {"text": "warfarin 5 mg"}}},
    {"resource": {"resourceType": "MedicationStatement", "medicationCodeableConcept": {"coding": [{"display": "Metformin"}]}}},
    {"resource": {"resourceType": "Observation", "code": {"text": "eGFR"}, "effectiveDateTime": "2026-09-01T10:00:00Z",
      "valueQuantity": {"value": 38, "unit": "mL/min/1.73m2"}}},
    {"resource": {"resourceType": "Observation", "code": {"coding": [{"code": "1742-6", "display": "ALT"}]},
      "valueQuantity": {"value": 61, "unit": "U/L"}}},
    {"resource": {"resourceType": "Observation", "code": {"text": "EGFR T790M mutation"}, "component": [
      {"code": {"text": "gene"}, "valueString": "EGFR"}, {"code": {"text": "variant"}, "valueString": "T790M"}]}}
  ]
}`

func TestParseFHIRBundle_ExtractsWithoutDefaults(t *testing.T) {
	p, err := ParseFHIRBundle([]byte(fhirBundle))
	if err != nil {
		t.Fatal(err)
	}
	if p.ID != "p-42" || p.Sex != "F" {
		t.Fatalf("identity: %+v", p)
	}
	wantAge := time.Now().Year() - 1960
	if p.Age == nil || (*p.Age != wantAge && *p.Age != wantAge-1) {
		t.Fatalf("age = %v, want about %d", p.Age, wantAge)
	}
	if len(p.Conditions) != 2 || p.Conditions[0] != "Non-small cell lung carcinoma" || p.Conditions[1] != "Type 2 diabetes mellitus" {
		t.Fatalf("conditions = %v", p.Conditions)
	}
	if len(p.ActiveMedications) != 2 || p.ActiveMedications[0] != "warfarin 5 mg" || p.ActiveMedications[1] != "Metformin" {
		t.Fatalf("medications = %v", p.ActiveMedications)
	}
	if lab, ok := p.Labs["eGFR"]; !ok || lab.Value != 38 || lab.Unit != "mL/min/1.73m2" || lab.Observed.IsZero() {
		t.Fatalf("eGFR lab = %+v (ok=%v)", lab, ok)
	}
	if lab, ok := p.Labs["ALT"]; !ok || lab.Value != 61 {
		t.Fatalf("ALT lab = %+v (ok=%v)", lab, ok)
	}
	if len(p.Variants) != 1 || p.Variants[0].Gene != "EGFR" || p.Variants[0].Change != "T790M" {
		t.Fatalf("variants = %+v", p.Variants)
	}
}

func TestParseFHIRBundle_NoObservationsMeansNoLabs(t *testing.T) {
	p, err := ParseFHIRBundle([]byte(`{"resourceType":"Bundle","entry":[{"resource":{"resourceType":"Patient","id":"x"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Labs) != 0 || p.Age != nil || p.Sex != "" || len(p.Variants) != 0 {
		t.Fatalf("unknown data must stay absent, got %+v", p)
	}
}

func TestParseFHIRBundle_InvalidJSON(t *testing.T) {
	if _, err := ParseFHIRBundle([]byte("{not json")); err == nil {
		t.Fatal("expected error")
	}
}
