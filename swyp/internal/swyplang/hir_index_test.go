package swyplang

import (
	"strings"
	"testing"
)

func TestHIRArrayIndexIsTyped(t *testing.T) {
	p, err := ParseCoreModule("index.swyp", `module values.index;
fn second(x: array<i64,3>) -> i64 { return x[1]; }`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	value := m.Declarations[0].Function.Body[0].Value
	if value == nil || value.Kind != "index" || value.Type.Name != "i64" || len(value.Args) != 2 {
		t.Fatalf("index=%+v", value)
	}
	if value.Args[0].Type.String() != "array<i64,3>" || value.Args[1].Type.Name != "u64" {
		t.Fatalf("index operands=%+v", value.Args)
	}
}

func TestHIRArrayIndexRejectsWrongBaseAndIndexType(t *testing.T) {
	cases := []struct {
		source string
		want   string
	}{
		{`module bad; fn f(x: i64) -> i64 { return x[0]; }`, "indexing requires array<T,N>"},
		{`module bad; fn f(x: array<i64,2>) -> i64 { return x[true]; }`, "expected u64, got bool"},
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

func TestArrayIndexRemainsFailClosedInCoreLowering(t *testing.T) {
	p, err := ParseCoreModule("index.swyp", `module values.index;
fn second(x: array<i64,3>) -> i64 { return x[1]; }`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.HIRModule(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := p.CoreIR("second"); err == nil {
		t.Fatal("CoreIR unexpectedly accepted array index before array layout/runtime semantics exist")
	}
}

func TestHIRArrayIndexParticipatesInTypedOperators(t *testing.T) {
	p, err := ParseCoreModule("index.swyp", `module values.index;
fn less(x: array<u64,3>) -> bool { return x[1] < 10; }
fn add(x: array<u64,3>) -> u64 { return x[1] + 1; }`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.HIRModule(nil); err != nil {
		t.Fatal(err)
	}
}
