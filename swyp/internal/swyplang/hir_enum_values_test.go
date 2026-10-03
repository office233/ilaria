package swyplang

import (
	"strings"
	"testing"
)

func TestHIREnumConstructionAndExhaustiveMatch(t *testing.T) {
	p, err := ParseCoreModule("lookup.swyp", `module domain.lookup;
enum Lookup {
    Missing;
    Found(u64);
}
fn found(x: u64) -> Lookup { return Lookup::Found(x); }
fn missing() -> Lookup { return Lookup::Missing; }
fn unwrap(value: Lookup) -> u64 {
    return match value {
        Missing => 0,
        Found(x) => x,
    };
}`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	var sawFound, sawMissing, sawMatch bool
	for _, decl := range m.Declarations {
		if decl.Function == nil || len(decl.Function.Body) == 0 || decl.Function.Body[0].Value == nil {
			continue
		}
		value := decl.Function.Body[0].Value
		switch decl.ID.Name {
		case "found":
			sawFound = value.Kind == "enum" && value.Name == "Found" && value.Type.String() == "Lookup" && len(value.Args) == 1 && value.Args[0].Type.Name == "u64"
		case "missing":
			sawMissing = value.Kind == "enum" && value.Name == "Missing" && len(value.Args) == 0
		case "unwrap":
			sawMatch = value.Kind == "match" && value.Type.Name == "u64" && len(value.Arms) == 2 && value.Arms[1].Binding == "x" && value.Arms[1].BindingType != nil && value.Arms[1].BindingType.Name == "u64"
		}
	}
	if !sawFound || !sawMissing || !sawMatch {
		t.Fatalf("found=%v missing=%v match=%v HIR=%+v", sawFound, sawMissing, sawMatch, m)
	}
}

func TestHIREnumAndMatchRejectInvalidShapes(t *testing.T) {
	cases := []struct {
		source string
		want   string
	}{
		{`module bad; enum E { A; B(u64); } fn f() -> E { return E::A(1); }`, "expects no payload"},
		{`module bad; enum E { A; B(u64); } fn f() -> E { return E::B; }`, "expects one payload"},
		{`module bad; enum E { A; B(u64); } fn f() -> E { return E::B(true); }`, "expected u64, got bool"},
		{`module bad; enum E { A; } fn f() -> E { return E::Missing; }`, "has no variant Missing"},
		{`module bad; enum E { A; B(u64); } fn f(v: E) -> u64 { return match v { A => 0, }; }`, "non-exhaustive match"},
		{`module bad; enum E { A; B(u64); } fn f(v: E) -> u64 { return match v { A(x) => 0, B(y) => y, }; }`, "unit variant A cannot bind payload"},
		{`module bad; enum E { A; B(u64); } fn f(v: E) -> u64 { return match v { A => 0, B => 1, }; }`, "payload variant B requires binding"},
		{`module bad; enum E { A; B(u64); } fn f(v: E) -> u64 { return match v { A => 0, B(x) => true, }; }`, "expected u64, got bool"},
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

func TestHIREnumMatchRemainsFailClosedInCore(t *testing.T) {
	p, err := ParseCoreModule("lookup.swyp", `module domain.lookup;
enum E { A; B(u64); }
fn f(v: E) -> u64 { return match v { A => 0, B(x) => x, }; }`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.HIRModule(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := p.CoreIR("f"); err == nil || !strings.Contains(err.Error(), "does not support type E") {
		t.Fatalf("Core enum boundary error=%v", err)
	}
}
