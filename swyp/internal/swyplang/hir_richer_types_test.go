package swyplang

import (
	"strings"
	"testing"
)

func TestHIRParsesRicherNestedTypeSignatures(t *testing.T) {
	p, err := ParseCoreModule("types.swyp", `module types.api;
fn keep_option(x: option<i64>) -> option<i64> { return x; }
fn keep_array(x: array<u64,4>) -> array<u64,4> { return x; }
fn keep_result(x: result<option<i64>,array<u64,16>>) -> result<option<i64>,array<u64,16>> { return x; }
fn keep_tuple(x: tuple<i64,bool,bytes>) -> tuple<i64,bool,bytes> { return x; }`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"keep_option": "option<i64>",
		"keep_array":  "array<u64,4>",
		"keep_result": "result<option<i64>,array<u64,16>>",
		"keep_tuple":  "tuple<i64,bool,bytes>",
	}
	for _, decl := range m.Declarations {
		expected, ok := want[decl.ID.Name]
		if !ok {
			continue
		}
		if decl.Function == nil || len(decl.Function.Params) != 1 || decl.Function.Params[0].Type.String() != expected || decl.Function.Result.String() != expected {
			t.Fatalf("%s signature=%+v want=%s", decl.ID.Name, decl.Function, expected)
		}
		delete(want, decl.ID.Name)
	}
	if len(want) != 0 {
		t.Fatalf("missing richer HIR declarations: %v", want)
	}
}

func TestRicherHIRTypesFailClosedInCoreBackend(t *testing.T) {
	p, err := ParseCoreModule("types.swyp", `module types.api;
fn keep(x: option<i64>) -> option<i64> { return x; }`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.CoreIR("keep"); err == nil || !strings.Contains(err.Error(), "does not support type option<i64>") {
		t.Fatalf("CoreIR richer-type boundary error=%v HIR=%+v", err, m)
	}
}

func TestRicherTypeParserRejectsMalformedSource(t *testing.T) {
	cases := []string{
		`module bad; fn f(x: option<>) -> i64 { return 0; }`,
		`module bad; fn f(x: array<i64,nope>) -> i64 { return 0; }`,
		`module bad; fn f(x: result<i64>) -> i64 { return 0; }`,
	}
	for _, source := range cases {
		if _, err := ParseCoreModule("bad.swyp", source); err == nil {
			t.Fatalf("accepted malformed richer type source: %s", source)
		}
	}
}
