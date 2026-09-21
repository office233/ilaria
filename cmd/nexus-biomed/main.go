// nexus-biomed — command-line front end for Ilaria's biomedical organ.
//
// Every answer is assembled from live public sources (RxNorm, ChEMBL,
// openFDA, Open Targets, PubMed), cached under -cache-dir, and printed with
// the evidence that produced it. Nothing is hardcoded; what the sources do
// not know is listed under "Could not determine".
//
//	go run ./cmd/nexus-biomed -query "gefitinib și warfarină la pacient cu EGFR T790M"
//	go run ./cmd/nexus-biomed -drug gefitinib -patient patient.json -dose 250 -interval 24 -json
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"nexus-cortex/cortex"
	"nexus-cortex/cortex/biomed"
)

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	var drugs, diseases multiFlag
	query := flag.String("query", "", "free-text question (drug mentions are detected with the RxNorm index)")
	flag.Var(&drugs, "drug", "drug name, any spelling (repeatable)")
	flag.Var(&diseases, "disease", "disease name (repeatable)")
	patientPath := flag.String("patient", "", "patient JSON: FHIR Bundle or native biomed.Patient")
	dose := flag.Float64("dose", 0, "dose in mg (with -interval enables the PK simulation)")
	interval := flag.Float64("interval", 24, "dosing interval in hours")
	duration := flag.Float64("duration", 240, "simulated duration in hours")
	cacheDir := flag.String("cache-dir", "data/knowledge/biomed", "cache + knowledge graph directory")
	asJSON := flag.Bool("json", false, "print the full ConsultResponse as JSON")
	refresh := flag.Bool("refresh", false, "ignore cached responses (TTL 0) and refetch")
	timeout := flag.Duration("timeout", 90*time.Second, "overall timeout")
	flag.Parse()

	if *query == "" && len(drugs) == 0 {
		fmt.Fprintln(os.Stderr, "nexus-biomed: give -query or at least one -drug")
		flag.Usage()
		os.Exit(2)
	}

	var opts []biomed.ClientOption
	if *refresh {
		opts = append(opts, biomed.WithTTL(0))
	}
	bridge, err := biomed.NewBridge(*cacheDir, opts...)
	if err != nil {
		fail(err)
	}

	req := biomed.ConsultRequest{Query: *query, Drugs: drugs, Diseases: diseases}
	if *patientPath != "" {
		p, err := loadPatient(*patientPath)
		if err != nil {
			fail(err)
		}
		req.Patient = p
	}
	if *dose > 0 {
		req.Regimen = &biomed.DoseRegimen{DoseMg: *dose, IntervalHours: *interval, DurationHours: *duration}
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	res, err := bridge.Consult(ctx, req)
	if err != nil {
		switch {
		case errors.Is(err, biomed.ErrOffline):
			fmt.Fprintln(os.Stderr, "nexus-biomed: a source is unreachable and not cached:", err)
		case errors.Is(err, biomed.ErrNotFound):
			fmt.Fprintln(os.Stderr, "nexus-biomed: no drug could be identified:", err)
		default:
			fmt.Fprintln(os.Stderr, "nexus-biomed:", err)
		}
		os.Exit(1)
	}

	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(res); err != nil {
			fail(err)
		}
		return
	}
	romanian := strings.ContainsAny(*query, "ăâîșțĂÂÎȘȚ") // no query → English rendering
	fmt.Print(cortex.RenderConsult(res, romanian))
}

// loadPatient accepts either a FHIR Bundle (resourceType == "Bundle") or the
// native biomed.Patient JSON.
func loadPatient(path string) (*biomed.Patient, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var probe struct {
		ResourceType string `json:"resourceType"`
	}
	_ = json.Unmarshal(raw, &probe)
	if probe.ResourceType == "Bundle" {
		return biomed.ParseFHIRBundle(raw)
	}
	var p biomed.Patient
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("patient file is neither a FHIR Bundle nor a biomed.Patient: %w", err)
	}
	return &p, nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "nexus-biomed:", err)
	os.Exit(1)
}
