package swyplang

import (
	"strings"
	"testing"

	"swyp-lang/internal/hir"
)

func ownershipReportForSource(t *testing.T, source string) hir.OwnershipReport {
	t.Helper()
	p, err := ParseCoreModule("borrow.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	report, err := hir.AnalyzeOwnership(hir.Bundle{Version: hir.Version, Root: m.Name, Modules: []hir.Module{m}})
	if err != nil {
		t.Fatal(err)
	}
	return report
}

func ownershipDiagnosticText(report hir.OwnershipReport) string {
	var b strings.Builder
	for _, d := range report.Diagnostics {
		b.WriteString(d.Code)
		b.WriteByte(':')
		b.WriteString(d.Message)
		b.WriteByte('\n')
	}
	return b.String()
}

func TestHIRLexicalSharedBorrowsCanCoexistAndRelease(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.demo;
fn good(x: vec<u64>) {
    let a = &x;
    let b = &x;
    drop(a);
    drop(b);
    drop(x);
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRLexicalBorrowConflictsAreRejected(t *testing.T) {
	cases := []struct {
		name   string
		source string
		want   string
	}{
		{
			"mutable after shared",
			`module borrow.demo;
fn bad(x: vec<u64>) {
    let a = &x;
    let b = &mut x;
    drop(a);
    drop(b);
    drop(x);
}`,
			"borrow_conflict",
		},
		{
			"move while shared borrowed",
			`module borrow.demo;
fn bad(x: vec<u64>) {
    let a = &x;
    drop(x);
    drop(a);
}`,
			"move_while_borrowed",
		},
		{
			"assignment while mutably borrowed",
			`module borrow.demo;
fn bad(x: u64) {
    let a = &mut x;
    x = 2;
    drop(a);
}`,
			"assign_while_borrowed",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			report := ownershipReportForSource(t, tc.source)
			if report.Status != "error" || !strings.Contains(ownershipDiagnosticText(report), tc.want) {
				t.Fatalf("diagnostics=%s", ownershipDiagnosticText(report))
			}
		})
	}
}

func TestHIRMutableBorrowSupportsStoreAndExplicitRelease(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.demo;
fn good(x: u64) {
    let r = &mut x;
    store(r, 7);
    drop(r);
    let after = x;
    drop(after);
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRLexicalBorrowEndsAtNestedScope(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.demo;
fn good(x: vec<u64>) {
    if true {
        let r = &x;
    }
    drop(x);
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRBorrowCannotEscapeWithoutLifetimeContract(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.demo;
fn bad(x: u64) -> ref<u64> {
    let r = &x;
    return r;
}`)
	text := ownershipDiagnosticText(report)
	if report.Status != "error" || !strings.Contains(text, "borrow_escape") || !strings.Contains(text, "borrowed_result") {
		t.Fatalf("diagnostics=%s", text)
	}
}

func TestHIRBorrowedReturnWithExplicitLifetimeContract(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.demo;
fn identity(x: ref<u64>) -> ref<u64> borrows x {
    return x;
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRBorrowedReturnTracksReborrowProvenance(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.demo;
fn identity(x: ref<u64>) -> ref<u64> borrows x {
    let r = x;
    return r;
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRBorrowedReturnRejectsLifetimeMismatch(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.demo;
fn wrong(x: ref<u64>, y: ref<u64>) -> ref<u64> borrows x {
    return y;
}`)
	text := ownershipDiagnosticText(report)
	if report.Status != "error" || !strings.Contains(text, "lifetime_mismatch") {
		t.Fatalf("diagnostics=%s", text)
	}
}

func TestHIRLifetimeContractRequiresBorrowedParameter(t *testing.T) {
	p, err := ParseCoreModule("borrow.swyp", `module borrow.demo;
fn bad(x: u64) -> ref<u64> borrows x {
    let r = &x;
    return r;
}`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.HIRModule(nil)
	if err == nil || !strings.Contains(err.Error(), "borrow_from \"x\" must name ref<T>, mutref<T> or slice<T>") {
		t.Fatalf("lifetime source error=%v", err)
	}
}

func TestHIRInterFunctionLifetimeContractPropagatesBorrowRoot(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.demo;
fn identity(x: ref<u64>) -> ref<u64> borrows x {
    return x;
}
fn wrapper(x: ref<u64>) -> ref<u64> borrows x {
    return identity(x);
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRBorrowedCallResultCanBeLexicallyReborrowed(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.demo;
fn identity(x: ref<u64>) -> ref<u64> borrows x {
    return x;
}
fn good(x: u64) {
    let r = &x;
    let s = identity(r);
    drop(s);
    drop(r);
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRMutableBorrowedCallResultIsExclusive(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.demo;
fn passthrough(x: mutref<u64>) -> mutref<u64> borrows x {
    return x;
}
fn bad(x: u64) {
    let r = &mut x;
    let s = passthrough(r);
    store(r, 1);
    drop(s);
    store(r, 2);
    drop(r);
}`)
	text := ownershipDiagnosticText(report)
	if report.Status != "error" || !strings.Contains(text, "borrow_conflict") {
		t.Fatalf("diagnostics=%s", text)
	}
}

func TestHIRBorrowDerefAndStoreTyping(t *testing.T) {
	p, err := ParseCoreModule("borrow.swyp", `module borrow.demo;
fn read(r: ref<u64>) -> u64 { return *r + 1; }
fn write(r: mutref<u64>) { store(r, 9); }`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, decl := range m.Declarations {
		if decl.Function == nil || len(decl.Function.Body) == 0 || decl.Function.Body[0].Value == nil {
			continue
		}
		value := decl.Function.Body[0].Value
		switch decl.ID.Name {
		case "read":
			if value.Kind != "binary" || value.Type.Name != "u64" || value.Args[0].Kind != "deref" || value.Args[0].Type.Name != "u64" {
				t.Fatalf("read HIR=%+v", value)
			}
		case "write":
			if value.Kind != "call" || value.Builtin != "store" || len(value.Args) != 2 || value.Args[0].Type.String() != "mutref<u64>" {
				t.Fatalf("write HIR=%+v", value)
			}
		}
	}
}

func TestHIRBorrowTypingRejectsUnsafeOperations(t *testing.T) {
	cases := []string{
		`module bad; fn f(x: ref<vec<u64>>) -> vec<u64> { return *x; }`,
		`module bad; fn f(x: ref<u64>) { store(x, 1); }`,
		`module bad; fn f(x: mutref<vec<u64>>, y: vec<u64>) { store(x, y); }`,
	}
	for _, source := range cases {
		p, err := ParseCoreModule("bad.swyp", source)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := p.HIRModule(nil); err == nil {
			t.Fatalf("invalid borrow/store source accepted: %s", source)
		}
	}
}

func TestHIRMutableBorrowCannotBeCopied(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.demo;
fn bad(x: u64) {
    let a = &mut x;
    let b = a;
    drop(a);
    drop(b);
}`)
	if report.Status != "error" || !strings.Contains(ownershipDiagnosticText(report), "mutref_copy") {
		t.Fatalf("diagnostics=%s", ownershipDiagnosticText(report))
	}
}

func TestHIRBorrowTypesRemainFailClosedInLayoutAndCore(t *testing.T) {
	p, err := ParseCoreModule("borrow.swyp", `module borrow.demo;
fn read(r: ref<u64>) -> u64 { return *r; }`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	bundle := hir.Bundle{Version: hir.Version, Root: "borrow.demo", Modules: []hir.Module{m}}
	if _, err := hir.PlanFixedLayout(bundle, "borrow.demo", hir.TypeRef{Name: "ref", Args: []hir.TypeRef{{Name: "u64"}}}); err == nil || !strings.Contains(err.Error(), "undefined until ownership/descriptor ABI") {
		t.Fatalf("ref layout error=%v", err)
	}
	if _, err := p.CoreIR("read"); err == nil {
		t.Fatal("CoreIR unexpectedly accepted borrow types")
	}
}
