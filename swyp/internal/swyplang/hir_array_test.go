package swyplang

import (
	"strings"
	"testing"
)

func TestHIRArrayLiteralUsesContextualType(t *testing.T) {
	p, err := ParseCoreModule("arrays.swyp", `module values.arrays;
fn make() -> array<i64,3> {
    let x: array<i64,3> = [1, 2, 3];
    return x;
}`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Declarations) != 1 || m.Declarations[0].Function == nil || len(m.Declarations[0].Function.Body) != 2 {
		t.Fatalf("HIR=%+v", m)
	}
	let := m.Declarations[0].Function.Body[0]
	if let.Value == nil || let.Value.Kind != "array" || let.Value.Type.String() != "array<i64,3>" || len(let.Value.Args) != 3 {
		t.Fatalf("array literal=%+v", let.Value)
	}
	for i, element := range let.Value.Args {
		if element.Type.Name != "i64" {
			t.Fatalf("element %d type=%s", i, element.Type.String())
		}
	}
}

func TestHIRArrayLiteralRejectsLengthAndElementMismatch(t *testing.T) {
	cases := []struct {
		source string
		want   string
	}{
		{`module bad; fn f() -> array<i64,2> { return [1]; }`, "has 1 elements, expected 2"},
		{`module bad; fn f() -> array<i64,2> { return [1, true]; }`, "expected i64, got bool"},
		{`module bad; fn f() { let x = [1, 2]; }`, "requires contextual array<T,N> type"},
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

func TestNestedHIRArrayLiteral(t *testing.T) {
	p, err := ParseCoreModule("matrix.swyp", `module values.matrix;
fn make() -> array<array<u64,2>,2> { return [[1,2],[3,4]]; }`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	value := m.Declarations[0].Function.Body[0].Value
	if value == nil || value.Type.String() != "array<array<u64,2>,2>" || len(value.Args) != 2 || value.Args[0].Type.String() != "array<u64,2>" {
		t.Fatalf("matrix literal=%+v", value)
	}
}
