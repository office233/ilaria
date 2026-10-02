package swyplang

import (
	"strings"
	"testing"
)

func TestHIRSliceViewFromArrayAndSlice(t *testing.T) {
	p, err := ParseCoreModule("slice.swyp", `module values.slice;
fn middle(x: array<u64,4>) -> slice<u64> { return x[1:3]; }
fn trim(x: slice<u64>) -> slice<u64> { return x[1:2]; }
fn first(x: slice<u64>) -> u64 { return x[0]; }`)
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
		case "middle", "trim":
			if value.Kind != "slice" || value.Type.String() != "slice<u64>" || len(value.Args) != 3 || value.Args[1].Type.Name != "u64" || value.Args[2].Type.Name != "u64" {
				t.Fatalf("%s slice=%+v", decl.ID.Name, value)
			}
		case "first":
			if value.Kind != "index" || value.Type.Name != "u64" || value.Args[0].Type.String() != "slice<u64>" {
				t.Fatalf("slice index=%+v", value)
			}
		}
	}
}

func TestHIRSliceRejectsInvalidBoundsAndBase(t *testing.T) {
	cases := []struct {
		source string
		want   string
	}{
		{`module bad; fn f(x: u64) -> slice<u64> { return x[0:1]; }`, "slicing requires array<T,N> or slice<T>"},
		{`module bad; fn f(x: array<u64,3>) -> slice<u64> { return x[true:2]; }`, "expected u64, got bool"},
		{`module bad; fn f(x: slice<u64>) -> u64 { return x[true]; }`, "expected u64, got bool"},
	}
	for _, tc := range cases {
		p, err := ParseCoreModule("bad.swyp", tc.source)
		if err != nil {
			t.Fatal(err)
		}
		_, err = p.HIRModule(nil)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("source=%s error=%v want=%q", tc.source, err, tc.want)
		}
	}
}

func TestHIRSliceRemainsFailClosedInCore(t *testing.T) {
	p, err := ParseCoreModule("slice.swyp", `module values.slice;
fn middle(x: array<u64,4>) -> slice<u64> { return x[1:3]; }`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.HIRModule(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := p.CoreIR("middle"); err == nil || !strings.Contains(err.Error(), "does not support type array<u64,4>") {
		t.Fatalf("Core slice boundary error=%v", err)
	}
}
