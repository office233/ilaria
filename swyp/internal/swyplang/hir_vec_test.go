package swyplang

import (
	"strings"
	"testing"

	"swyp-lang/internal/hir"
)

func TestHIRVecLiteralIndexAndOwnership(t *testing.T) {
	p, err := ParseCoreModule("vec.swyp", `module values.vec;
fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    let x: u64 = v[1];
    drop(v);
    return x;
}`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Declarations) != 1 || m.Declarations[0].Function == nil {
		t.Fatalf("HIR=%+v", m)
	}
	body := m.Declarations[0].Function.Body
	if len(body) != 4 || body[0].Value == nil || body[0].Value.Kind != "vec" || body[0].Value.Type.String() != "vec<u64>" {
		t.Fatalf("vec body=%+v", body)
	}
	if body[1].Value == nil || body[1].Value.Kind != "index" || body[1].Value.Type.Name != "u64" {
		t.Fatalf("vec index=%+v", body[1].Value)
	}
	report, err := hir.AnalyzeOwnership(hir.Bundle{Version: hir.Version, Root: m.Name, Modules: []hir.Module{m}})
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership=%+v", report)
	}
}

func TestHIRVecLiteralRequiresExplicitMoveConsumption(t *testing.T) {
	p, err := ParseCoreModule("vec.swyp", `module values.vec;
fn leak() {
    let v: vec<u64> = [1, 2];
}`)
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
	if report.Status != "error" {
		t.Fatalf("vec leak unexpectedly accepted: %+v", report)
	}
}

func TestHIRVecSliceBorrowsOwnerUntilRelease(t *testing.T) {
	p, err := ParseCoreModule("vec.swyp", `module values.vec;
fn good() -> u64 {
    let v: vec<u64> = [10, 20, 30, 40];
    let s: slice<u64> = v[1:4];
    let x: u64 = s[1];
    drop(s);
    drop(v);
    return x;
}`)
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
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership=%+v", report)
	}
}

func TestHIRVecCannotMoveWhileSliceViewIsLive(t *testing.T) {
	p, err := ParseCoreModule("vec.swyp", `module values.vec;
fn bad() {
    let v: vec<u64> = [10, 20, 30];
    let s: slice<u64> = v[0:2];
    drop(v);
    drop(s);
}`)
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
	if report.Status != "error" {
		t.Fatalf("move with live vec slice unexpectedly accepted: %+v", report)
	}
}

func TestHIRVecElementMutableRefOwnership(t *testing.T) {
	p, err := ParseCoreModule("vec.swyp", `module values.vec;
fn good() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    let r = &mut v[1];
    store(r, 25);
    let x: u64 = *r;
    drop(r);
    drop(v);
    return x;
}`)
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
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership=%+v", report)
	}
}

func TestHIRVecLenAndCapacityDoNotConsumeOwner(t *testing.T) {
	p, err := ParseCoreModule("vec.swyp", `module values.vec;
fn good() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    let n: u64 = vec_len(v);
    let c: u64 = vec_capacity(v);
    drop(v);
    return n + c;
}`)
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
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership=%+v", report)
	}
}

func TestHIRVecPushMutatesOwnerWithoutMovingIt(t *testing.T) {
	p, err := ParseCoreModule("vec.swyp", `module values.vec;
fn good() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    vec_push(v, 40);
    vec_push(v, 50);
    let x: u64 = v[4];
    drop(v);
    return x;
}`)
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
	if report.Status != "ok" || len(report.Diagnostics) != 0 {
		t.Fatalf("ownership=%+v", report)
	}
}

func TestHIRVecPushRejectsActiveBorrow(t *testing.T) {
	p, err := ParseCoreModule("vec.swyp", `module values.vec;
fn bad() {
    let v: vec<u64> = [10, 20];
    let r = &v[0];
    vec_push(v, 30);
    drop(r);
    drop(v);
}`)
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
	if report.Status != "error" || !strings.Contains(ownershipDiagnosticText(report), "borrow_conflict") {
		t.Fatalf("ownership=%+v", report)
	}
}
