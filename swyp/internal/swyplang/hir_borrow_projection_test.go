package swyplang

import (
	"strings"
	"testing"
)

func TestHIRBorrowNonCopyStructFieldUsesWholeOwnerLoan(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.projection;
struct Holder {
    data: vec<u64>;
    tag: u64;
}
fn good(x: Holder) {
    let r = &x.data;
    drop(r);
    drop(x);
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRBorrowNonCopyArrayElementUsesWholeOwnerLoan(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.projection;
fn good(x: array<vec<u64>,2>) {
    let r = &x[0];
    drop(r);
    drop(x);
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRProjectionBorrowBlocksMovingWholeOwner(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.projection;
struct Holder { data: vec<u64>; }
fn bad(x: Holder) {
    let r = &x.data;
    drop(x);
    drop(r);
}`)
	text := ownershipDiagnosticText(report)
	if report.Status != "error" || !strings.Contains(text, "move_while_borrowed") {
		t.Fatalf("diagnostics=%s", text)
	}
}

func TestHIRMutableProjectionBorrowsAllowDisjointStaticFields(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.projection;
struct Holder {
    data: vec<u64>;
    tag: u64;
}
fn good(x: Holder) {
    let a = &mut x.data;
    let b = &mut x.tag;
    drop(a);
    drop(b);
    drop(x);
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRMutableProjectionBorrowsRejectOverlappingStaticFields(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.projection;
struct Inner { value: u64; }
struct Holder { left: Inner; right: Inner; }
fn bad(x: Holder) {
    let a = &mut x.left;
    let b = &mut x.left.value;
    drop(a);
    drop(b);
}`)
	text := ownershipDiagnosticText(report)
	if report.Status != "error" || !strings.Contains(text, "borrow_conflict") {
		t.Fatalf("diagnostics=%s", text)
	}
}

func TestHIRMutableIndexedBorrowsAllowDistinctConstantIndices(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.projection;
fn bad(x: array<vec<u64>,2>) {
    let a = &mut x[0];
    let b = &mut x[1];
    drop(a);
    drop(b);
    drop(x);
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRMutableIndexedBorrowsKeepDynamicIndicesConservative(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.projection;
fn bad(x: array<vec<u64>,4>, i: u64, j: u64) {
    let a = &mut x[i];
    let b = &mut x[j];
    drop(a);
    drop(b);
    drop(x);
}`)
	text := ownershipDiagnosticText(report)
	if report.Status != "error" || !strings.Contains(text, "borrow_conflict") {
		t.Fatalf("diagnostics=%s", text)
	}
}

func TestHIRMutableNestedPlacesComposeFieldAndConstantIndex(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.projection;
struct Holder {
    rows: array<vec<u64>,2>;
    other: vec<u64>;
}
fn good(x: Holder) {
    let a = &mut x.rows[0];
    let b = &mut x.rows[1];
    let c = &mut x.other;
    drop(a);
    drop(b);
    drop(c);
    drop(x);
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRDynamicIndexConflictsWithinFieldButNotSiblingField(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.projection;
struct Holder {
    rows: array<vec<u64>,4>;
    other: vec<u64>;
}
fn bad(x: Holder, i: u64) {
    let a = &mut x.rows[i];
    let b = &mut x.rows[0];
    let c = &mut x.other;
    drop(a);
    drop(b);
    drop(c);
    drop(x);
}`)
	text := ownershipDiagnosticText(report)
	if report.Status != "error" || !strings.Contains(text, "borrow_conflict") {
		t.Fatalf("diagnostics=%s", text)
	}
}

func TestHIRConstantSliceRangeAllowsDisjointMutableIndex(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.ranges;
fn good(x: array<u64,4>) {
    let head = x[0:2];
    let tail = &mut x[3];
    drop(head);
    drop(tail);
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRConstantSliceRangeConflictsWithOverlappingMutableIndex(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.ranges;
fn bad(x: array<u64,4>) {
    let head = x[0:2];
    let overlap = &mut x[1];
    drop(head);
    drop(overlap);
}`)
	text := ownershipDiagnosticText(report)
	if report.Status != "error" || !strings.Contains(text, "borrow_conflict") {
		t.Fatalf("diagnostics=%s", text)
	}
}

func TestHIRConstantSliceRangesCanBeDisjoint(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.ranges;
fn good(x: array<u64,4>) {
    let left = x[0:2];
    let right = x[2:4];
    drop(left);
    drop(right);
}`)
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership report=%+v", report)
	}
}

func TestHIRDynamicSliceRangeRemainsContainerConservative(t *testing.T) {
	report := ownershipReportForSource(t, `module borrow.ranges;
fn bad(x: array<u64,4>, end: u64) {
    let dynamic = x[0:end];
    let tail = &mut x[3];
    drop(dynamic);
    drop(tail);
}`)
	text := ownershipDiagnosticText(report)
	if report.Status != "error" || !strings.Contains(text, "borrow_conflict") {
		t.Fatalf("diagnostics=%s", text)
	}
}
