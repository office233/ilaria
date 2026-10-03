package swyplang

import (
	"strings"
	"testing"

	"swyp-lang/internal/hir"
)

func TestCoreProgramHIRDeclarationsAreQualifiedAndTyped(t *testing.T) {
	p, err := ParseCoreModule("math.swyp", `module app.math;
use platform.types;
fn square(x: i64) -> i64 { return x * x; }`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	if m.Name != "app.math" || strings.Join(m.Uses, ",") != "platform.types" || len(m.Declarations) != 1 {
		t.Fatalf("HIR=%+v", m)
	}
	var found bool
	for _, d := range m.Declarations {
		if d.ID.Name == "square" {
			found = true
			if d.ID.Canonical() != "app.math::fn::square" || len(d.Function.Params) != 1 || d.Function.Params[0].Type.Name != "i64" || d.Function.Result.Name != "i64" {
				t.Fatalf("square HIR=%+v", d)
			}
		}
	}
	if !found {
		t.Fatal("square declaration missing")
	}
}

func TestLegacyProgramHIRUsesCheckedInferredTypes(t *testing.T) {
	p, err := ParseModule("legacy.swyp", `module compat.math;
fn id(x) { return x; }
fn use_id() -> number { return id(1); }`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range m.Declarations {
		if d.ID.Name == "id" {
			if d.Function.Params[0].Type.Name != "number" || d.Function.Result.Name != "number" {
				t.Fatalf("inferred id signature=%+v", d.Function)
			}
			return
		}
	}
	t.Fatal("id declaration missing")
}

func TestModuleParsersDoNotWeakenEntryProgramContract(t *testing.T) {
	source := `module lib.math;
fn square(x: i64) -> i64 { return x * x; }`
	if _, err := ParseCoreModule("lib.swyp", source); err != nil {
		t.Fatalf("library module rejected: %v", err)
	}
	_, err := ParseCore("lib.swyp", source)
	requireSourceDiagnostic(t, err, DiagnosticMissingMain)

	legacy := `module lib.compat;
fn id(x: number) -> number { return x; }`
	if _, err := ParseModule("legacy-lib.swyp", legacy); err != nil {
		t.Fatalf("legacy library module rejected: %v", err)
	}
	_, err = Parse("legacy-lib.swyp", legacy)
	requireSourceDiagnostic(t, err, DiagnosticMissingMain)
}

func TestCoreHIRBodyResolvesLocalCallAndTypes(t *testing.T) {
	p, err := ParseCoreModule("math.swyp", `module app.math;
fn square(x: i64) -> i64 { return x * x; }
fn fourth(x: i64) -> i64 { return square(square(x)); }`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	var fourth *hir.Function
	for i := range m.Declarations {
		if m.Declarations[i].ID.Name == "fourth" {
			fourth = m.Declarations[i].Function
		}
	}
	if fourth == nil || len(fourth.Body) != 1 || fourth.Body[0].Value == nil {
		t.Fatalf("fourth body=%+v", fourth)
	}
	outer := fourth.Body[0].Value
	if outer.Callee == nil || outer.Callee.Canonical() != "app.math::fn::square" || outer.Type.Name != "i64" {
		t.Fatalf("outer call=%+v", outer)
	}
	if len(outer.Args) != 1 || outer.Args[0].Callee == nil || outer.Args[0].Callee.Canonical() != "app.math::fn::square" {
		t.Fatalf("nested call=%+v", outer.Args)
	}
}

func TestCoreParserAcceptsQualifiedCallForHIRButCoreIRFailsClosed(t *testing.T) {
	p, err := ParseCoreModule("app.swyp", `module app.main;
use lib.math;
fn run(x: i64) -> i64 { return lib.math.square(x); }`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.CoreIR("run"); err == nil {
		t.Fatal("CoreIR unexpectedly linked qualified imported call without module linker")
	}
}
