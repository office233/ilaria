package biomed

import (
	"context"
	"errors"
	"testing"
)

func chemblClient(t *testing.T) *Client {
	t.Helper()
	ff := newFixtureFetcher(t, map[string]string{
		"molecule/search.json?q=gefitinib":            "chembl/search_gefitinib.json",
		"mechanism.json?molecule_chembl_id=CHEMBL939": "chembl/mech_CHEMBL939.json",
		"target/CHEMBL203.json":                       "chembl/target_CHEMBL203.json",
		"activity.json?molecule_chembl_id=CHEMBL939":  "chembl/act_CHEMBL939.json",
	})
	return NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0))
}

func TestMolecule_GefitinibPropertiesFromChEMBL(t *testing.T) {
	c := chemblClient(t)
	m, err := c.Molecule(context.Background(), "gefitinib")
	if err != nil {
		t.Fatal(err)
	}
	if m.ChEMBLID != "CHEMBL939" || m.PrefName != "GEFITINIB" || m.MaxPhase == nil || *m.MaxPhase != 4 || m.BlackBoxWarning {
		t.Fatalf("got %+v", m)
	}
	if len(m.ATC) != 1 || m.ATC[0] != "L01EB01" {
		t.Fatalf("atc = %v", m.ATC)
	}
	p := m.Props
	if p.MW == nil || *p.MW != 446.91 || p.ALogP == nil || *p.ALogP != 4.28 || p.HBA == nil || *p.HBA != 7 || p.HBD == nil || *p.HBD != 1 || p.Ro5Violations == nil || *p.Ro5Violations != 0 || p.PSA == nil || *p.PSA != 68.74 {
		t.Fatalf("props = %+v", p)
	}
	if m.Evidence.Source != "chembl" || m.Evidence.ID != "CHEMBL939" {
		t.Fatalf("evidence = %+v", m.Evidence)
	}
}

func TestMolecule_UnknownIsErrNotFound(t *testing.T) {
	c := chemblClient(t)
	_, err := c.Molecule(context.Background(), "zzzzqq")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}

func TestMechanisms_GefitinibInhibitsEGFR(t *testing.T) {
	c := chemblClient(t)
	ms, err := c.Mechanisms(context.Background(), "CHEMBL939")
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 1 || ms[0].Action != "INHIBITOR" || ms[0].TargetChEMBLID != "CHEMBL203" {
		t.Fatalf("mechanisms = %+v", ms)
	}
	if ms[0].Description == "" || ms[0].Evidence.Source != "chembl" {
		t.Fatalf("mechanism incomplete: %+v", ms[0])
	}
}

func TestTarget_EGFRGeneSymbolAndUniProt(t *testing.T) {
	c := chemblClient(t)
	tg, err := c.Target(context.Background(), "CHEMBL203")
	if err != nil {
		t.Fatal(err)
	}
	if tg.PrefName != "Epidermal growth factor receptor" || tg.Type != "SINGLE PROTEIN" || tg.Organism != "Homo sapiens" {
		t.Fatalf("target = %+v", tg)
	}
	if len(tg.GeneSymbols) == 0 || tg.GeneSymbols[0] != "EGFR" || len(tg.UniProt) == 0 || tg.UniProt[0] != "P00533" {
		t.Fatalf("symbols=%v uniprot=%v", tg.GeneSymbols, tg.UniProt)
	}
}

func TestActivities_RealIC50Measurements(t *testing.T) {
	c := chemblClient(t)
	acts, err := c.Activities(context.Background(), "CHEMBL939", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(acts) == 0 {
		t.Fatal("no activities")
	}
	a := acts[0]
	if a.Type != "IC50" || a.Value != 0.1 || a.Units != "nM" || a.TargetChEMBLID != "CHEMBL203" || a.PChEMBL == nil || *a.PChEMBL != 10.0 {
		t.Fatalf("activity = %+v", a)
	}
	if a.Assay == "" || a.DocumentID == "" || a.Evidence.Source != "chembl" {
		t.Fatalf("activity provenance incomplete: %+v", a)
	}
}
