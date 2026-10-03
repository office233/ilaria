package main

import (
	"errors"
	"strings"
	"testing"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/swyplang"
)

func TestCompilerDiagnosticPreservesSourceCodeAndLocation(t *testing.T) {
	_, err := swyplang.ParseCore("candidate.swyp", `fn main() { let x: mystery = 1; }`)
	if err == nil {
		t.Fatal("expected source diagnostic")
	}
	d := compilerDiagnostic(err)
	if d.Code != swyplang.DiagnosticInvalidType {
		t.Fatalf("code=%q diagnostic=%+v", d.Code, d)
	}
	if d.Location.File != "candidate.swyp" || d.Location.Line != 1 || d.Location.Column <= 0 {
		t.Fatalf("location=%+v", d.Location)
	}
	if !strings.Contains(d.Message, "candidate.swyp:1:") || !strings.Contains(d.Message, "expected type") {
		t.Fatalf("message=%q", d.Message)
	}
}

func TestCompilerDiagnosticPassesCoreDiagnosticThrough(t *testing.T) {
	want := &coreir.Diagnostic{Code: "invalid_json", Message: "bad json"}
	got := compilerDiagnostic(errors.Join(errors.New("outer"), want))
	if got != want {
		t.Fatalf("core diagnostic was copied or replaced: got=%p want=%p", got, want)
	}
}
