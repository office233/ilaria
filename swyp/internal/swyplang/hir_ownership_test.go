package swyplang

import (
	"strings"
	"testing"

	"swyp-lang/internal/hir"
)

func TestHIRDropProvidesExplicitAffineConsumption(t *testing.T) {
	p, err := ParseCoreModule("ownership.swyp", `module ownership.demo;
fn release(x: vec<u64>) { drop(x); }`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	bundle := hir.Bundle{Version: hir.Version, Root: "ownership.demo", Modules: []hir.Module{m}}
	report, err := hir.AnalyzeOwnership(bundle)
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
	drop := m.Declarations[0].Function.Body[0].Value
	if drop == nil || drop.Kind != "call" || drop.Builtin != "drop" || drop.Type.Name != "void" {
		t.Fatalf("drop HIR=%+v", drop)
	}
}

func TestHIRDropMakesUseAfterMoveVisible(t *testing.T) {
	p, err := ParseCoreModule("ownership.swyp", `module ownership.demo;
fn bad(x: vec<u64>) { drop(x); drop(x); }`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	report, err := hir.AnalyzeOwnership(hir.Bundle{Version: hir.Version, Root: "ownership.demo", Modules: []hir.Module{m}})
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "error" {
		t.Fatalf("ownership report=%+v", report)
	}
	var joined strings.Builder
	for _, d := range report.Diagnostics {
		joined.WriteString(d.Message)
		joined.WriteByte('\n')
	}
	if !strings.Contains(joined.String(), "use of moved value x") {
		t.Fatalf("diagnostics=%s", joined.String())
	}
}

func TestHIRDropRemainsHIROnly(t *testing.T) {
	p, err := ParseCoreModule("ownership.swyp", `module ownership.demo;
fn release(x: vec<u64>) { drop(x); }`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.CoreIR("release"); err == nil {
		t.Fatal("CoreIR unexpectedly accepted HIR-only drop/richer ownership type")
	}
}
