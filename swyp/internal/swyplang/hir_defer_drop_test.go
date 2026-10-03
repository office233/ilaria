package swyplang

import (
	"strings"
	"testing"
)

func TestHIRDeferDropConsumesMoveOwnerAtScopeExit(t *testing.T) {
	report := ownershipReportForSource(t, `module cleanup.demo;
fn good() {
    let v: vec<u64> = [1,2,3];
    defer_drop(v);
    vec_push(v, 4);
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRDeferDropRejectsDuplicateAndMoveAfterSchedule(t *testing.T) {
	cases := []struct {
		name   string
		source string
		want   string
	}{
		{
			"duplicate",
			`module cleanup.demo;
fn bad() {
    let v: vec<u64> = [1];
    defer_drop(v);
    defer_drop(v);
}`,
			"duplicate_defer_drop",
		},
		{
			"manual drop",
			`module cleanup.demo;
fn bad() {
    let v: vec<u64> = [1];
    defer_drop(v);
    drop(v);
}`,
			"drop_after_defer_drop",
		},
		{
			"move into call",
			`module cleanup.demo;
fn consume(v: vec<u64>) { drop(v); }
fn bad() {
    let v: vec<u64> = [1];
    defer_drop(v);
    consume(v);
}`,
			"move_after_defer_drop",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			report := ownershipReportForSource(t, tc.source)
			text := ownershipDiagnosticText(report)
			if report.Status != "error" || !strings.Contains(text, tc.want) {
				t.Fatalf("diagnostics=%s want=%s", text, tc.want)
			}
		})
	}
}

func TestHIRDeferDropAllowsTopLevelMoveParameter(t *testing.T) {
	report := ownershipReportForSource(t, `module cleanup.demo;
fn good(v: vec<u64>) -> u64 {
    defer_drop(v);
    let n: u64 = vec_len(v);
    return n;
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRDeferDropRejectsParameterSchedulingInNestedScope(t *testing.T) {
	report := ownershipReportForSource(t, `module cleanup.demo;
fn bad(v: vec<u64>) {
    if true {
        defer_drop(v);
    }
    drop(v);
}`)
	text := ownershipDiagnosticText(report)
	if report.Status != "error" || !strings.Contains(text, "defer_drop_scope") {
		t.Fatalf("diagnostics=%s", text)
	}
}
