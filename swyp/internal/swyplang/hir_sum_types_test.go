package swyplang

import (
	"strings"
	"testing"
)

func TestHIROptionAndResultConstructorsAndMatch(t *testing.T) {
	p, err := ParseCoreModule("sum.swyp", `module values.sum;
fn maybe(x: u64) -> option<u64> { return some(x); }
fn absent() -> option<u64> { return none(); }
fn unwrap(x: option<u64>) -> u64 {
    return match x { None => 0, Some(v) => v, };
}
fn success(x: u64) -> result<u64,bool> { return ok(x); }
fn failure() -> result<u64,bool> { return err(true); }
fn result_value(x: result<u64,bool>) -> u64 {
    return match x { Ok(v) => v, Err(e) => 0, };
}`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]struct {
		kind, variant, typ string
	}{
		"maybe":   {"enum", "Some", "option<u64>"},
		"absent":  {"enum", "None", "option<u64>"},
		"success": {"enum", "Ok", "result<u64,bool>"},
		"failure": {"enum", "Err", "result<u64,bool>"},
	}
	for _, decl := range m.Declarations {
		if decl.Function == nil || len(decl.Function.Body) == 0 || decl.Function.Body[0].Value == nil {
			continue
		}
		value := decl.Function.Body[0].Value
		if expected, ok := want[decl.ID.Name]; ok {
			if value.Kind != expected.kind || value.Name != expected.variant || value.Type.String() != expected.typ {
				t.Fatalf("%s value=%+v", decl.ID.Name, value)
			}
			delete(want, decl.ID.Name)
		}
		if decl.ID.Name == "unwrap" {
			if value.Kind != "match" || len(value.Arms) != 2 || value.Arms[1].Binding != "v" || value.Arms[1].BindingType == nil || value.Arms[1].BindingType.Name != "u64" {
				t.Fatalf("option match=%+v", value)
			}
		}
		if decl.ID.Name == "result_value" {
			if value.Kind != "match" || len(value.Arms) != 2 || value.Arms[0].Binding != "v" || value.Arms[0].BindingType == nil || value.Arms[0].BindingType.Name != "u64" || value.Arms[1].BindingType == nil || value.Arms[1].BindingType.Name != "bool" {
				t.Fatalf("result match=%+v", value)
			}
		}
	}
	if len(want) != 0 {
		t.Fatalf("missing sum constructors: %v", want)
	}
}

func TestHIROptionResultRequireContextAndExhaustiveMatch(t *testing.T) {
	cases := []struct {
		source string
		want   string
	}{
		{`module bad; fn f() { let x = some(1); }`, "requires contextual option<T> or result<T,E> type"},
		{`module bad; fn f() -> u64 { return some(1); }`, "some requires contextual option<T>"},
		{`module bad; fn f() -> option<u64> { return some(true); }`, "expected u64, got bool"},
		{`module bad; fn f() -> option<u64> { return none(1); }`, "none expects 0 arguments"},
		{`module bad; fn f(x: option<u64>) -> u64 { return match x { None => 0, }; }`, "non-exhaustive match"},
		{`module bad; fn f(x: result<u64,bool>) -> u64 { return match x { Ok(v) => v, }; }`, "non-exhaustive match"},
		{`module bad; fn f(x: option<u64>) -> u64 { return match x { None(v) => 0, Some(v) => v, }; }`, "unit variant None cannot bind payload"},
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

func TestOptionResultRemainFailClosedInCore(t *testing.T) {
	p, err := ParseCoreModule("sum.swyp", `module values.sum;
fn maybe(x: u64) -> option<u64> { return some(x); }`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.HIRModule(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := p.CoreIR("maybe"); err == nil || !strings.Contains(err.Error(), "does not support type option<u64>") {
		t.Fatalf("Core option boundary error=%v", err)
	}
}
