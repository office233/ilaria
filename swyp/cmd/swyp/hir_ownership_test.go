package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"swyp-lang/internal/hir"
)

func TestHIROwnershipCommandAcceptsExplicitDrop(t *testing.T) {
	root := t.TempDir()
	app := writeHIRLinkFile(t, root, "app/main.swyp", `module app.main;
fn release(x: vec<u64>) { drop(x); }`)
	var out bytes.Buffer
	if err := hirOwnershipCommand([]string{"-root", root, app}, &out); err != nil {
		t.Fatal(err)
	}
	var report hir.OwnershipReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("report=%+v", report)
	}
}

func TestHIROwnershipCommandReturnsReportOnFailure(t *testing.T) {
	root := t.TempDir()
	app := writeHIRLinkFile(t, root, "app/main.swyp", `module app.main;
fn bad(x: vec<u64>) { drop(x); drop(x); }`)
	var out bytes.Buffer
	err := hirOwnershipCommand([]string{"-root", root, app}, &out)
	if err == nil || !strings.Contains(err.Error(), "ownership check failed") {
		t.Fatalf("error=%v output=%s", err, out.String())
	}
	var report hir.OwnershipReport
	if jsonErr := json.Unmarshal(out.Bytes(), &report); jsonErr != nil {
		t.Fatal(jsonErr)
	}
	if report.Status != "error" || len(report.Diagnostics) == 0 {
		t.Fatalf("report=%+v", report)
	}
	var sawUseAfterMove bool
	for _, diagnostic := range report.Diagnostics {
		if diagnostic.Code == "use_after_move" {
			sawUseAfterMove = true
		}
	}
	if !sawUseAfterMove {
		t.Fatalf("missing use_after_move: %+v", report.Diagnostics)
	}
}

func TestHIROwnershipCommandRejectsBorrowedReturn(t *testing.T) {
	root := t.TempDir()
	app := writeHIRLinkFile(t, root, "app/main.swyp", `module app.main;
fn view(x: slice<u64>) -> slice<u64> { return x; }`)
	var out bytes.Buffer
	err := hirOwnershipCommand([]string{"-root", root, app}, &out)
	if err == nil {
		t.Fatal("borrowed return unexpectedly accepted")
	}
	if !strings.Contains(out.String(), "borrow_escape") || !strings.Contains(out.String(), "borrowed_result") {
		t.Fatalf("output=%s", out.String())
	}
}

func TestHIROwnershipCommandAcceptsCrossModuleLifetimeContract(t *testing.T) {
	root := t.TempDir()
	app := writeHIRLinkFile(t, root, "app/main.swyp", `module app.main;
use lib.borrow;
fn wrapper(x: ref<u64>) -> ref<u64> borrows x {
    return lib.borrow.identity(x);
}`)
	writeHIRLinkFile(t, root, "lib/borrow.swyp", `module lib.borrow;
fn identity(x: ref<u64>) -> ref<u64> borrows x {
    return x;
}`)
	var out bytes.Buffer
	if err := hirOwnershipCommand([]string{"-root", root, app}, &out); err != nil {
		t.Fatal(err)
	}
	var report hir.OwnershipReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("report=%+v", report)
	}
}

func TestHIROwnershipCommandRejectsBorrowedCallWithoutLifetimeContract(t *testing.T) {
	root := t.TempDir()
	app := writeHIRLinkFile(t, root, "app/main.swyp", `module app.main;
use lib.borrow;
fn bad(x: ref<u64>) -> ref<u64> borrows x {
    let r = lib.borrow.identity(x);
    return r;
}`)
	writeHIRLinkFile(t, root, "lib/borrow.swyp", `module lib.borrow;
fn identity(x: ref<u64>) -> ref<u64> {
    return x;
}`)
	var out bytes.Buffer
	err := hirOwnershipCommand([]string{"-root", root, app}, &out)
	if err == nil {
		t.Fatal("borrowed call without callee lifetime contract unexpectedly accepted")
	}
	if !strings.Contains(out.String(), "borrow_provenance") || !strings.Contains(out.String(), "borrowed_result") {
		t.Fatalf("output=%s", out.String())
	}
}
