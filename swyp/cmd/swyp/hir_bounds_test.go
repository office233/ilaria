package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"swyp-lang/internal/hir"
)

func TestHIRBoundsCommandReportsProvenAndRuntimeChecks(t *testing.T) {
	root := t.TempDir()
	app := writeHIRLinkFile(t, root, "app/main.swyp", `module app.main;
fn check(x: array<u64,4>, i: u64) -> u64 {
    let a = x[1];
    let b = x[i];
    return a + b;
}`)
	var out bytes.Buffer
	if err := hirBoundsCommand([]string{"-root", root, app}, &out); err != nil {
		t.Fatal(err)
	}
	var report hir.BoundsReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.Status != "ok" || len(report.Checks) != 2 {
		t.Fatalf("report=%+v", report)
	}
	var proven, runtime bool
	for _, check := range report.Checks {
		proven = proven || check.Status == "proven"
		runtime = runtime || check.Status == "runtime_required"
	}
	if !proven || !runtime {
		t.Fatalf("checks=%+v", report.Checks)
	}
}

func TestHIRBoundsCommandRejectsStaticOutOfBounds(t *testing.T) {
	root := t.TempDir()
	app := writeHIRLinkFile(t, root, "app/main.swyp", `module app.main;
fn bad(x: array<u64,4>) -> u64 { return x[4]; }`)
	var out bytes.Buffer
	err := hirBoundsCommand([]string{"-root", root, app}, &out)
	if err == nil || !strings.Contains(err.Error(), "bounds check failed") || !strings.Contains(out.String(), "index_out_of_bounds") {
		t.Fatalf("error=%v output=%s", err, out.String())
	}
}
