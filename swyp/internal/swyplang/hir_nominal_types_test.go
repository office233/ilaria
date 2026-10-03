package swyplang

import (
	"strings"
	"testing"
)

func TestHIRParsesStructAndEnumDeclarations(t *testing.T) {
	p, err := ParseCoreModule("model.swyp", `module domain.model;
struct User {
    id: u64;
    name: bytes;
}
enum Lookup {
    Missing;
    Found(User);
}
fn identity(x: User) -> User { return x; }
fn keep_lookup(x: Lookup) -> Lookup { return x; }`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	var sawStruct, sawEnum, sawIdentity bool
	for _, d := range m.Declarations {
		switch d.ID.Canonical() {
		case "domain.model::struct::User":
			sawStruct = true
			if len(d.Fields) != 2 || d.Fields[0].Name != "id" || d.Fields[0].Type.String() != "u64" || d.Fields[1].Type.String() != "bytes" {
				t.Fatalf("struct=%+v", d)
			}
		case "domain.model::enum::Lookup":
			sawEnum = true
			if len(d.Variants) != 2 || d.Variants[0].Name != "Missing" || d.Variants[0].Payload != nil || d.Variants[1].Payload == nil || d.Variants[1].Payload.String() != "User" {
				t.Fatalf("enum=%+v", d)
			}
		case "domain.model::fn::identity":
			sawIdentity = true
			if d.Function == nil || d.Function.Params[0].Type.String() != "User" || d.Function.Result.String() != "User" || len(d.Function.Body) != 1 {
				t.Fatalf("identity=%+v", d)
			}
		}
	}
	if !sawStruct || !sawEnum || !sawIdentity {
		t.Fatalf("missing declarations struct=%v enum=%v identity=%v HIR=%+v", sawStruct, sawEnum, sawIdentity, m.Declarations)
	}
}

func TestNominalTypesSupportForwardReferences(t *testing.T) {
	p, err := ParseCoreModule("forward.swyp", `module domain.forward;
fn keep(x: Later) -> Later { return x; }
struct Later { value: i64; }`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.HIRModule(nil); err != nil {
		t.Fatal(err)
	}
}

func TestNominalTypeValidationRejectsUnknownAndUndeclaredImports(t *testing.T) {
	cases := []struct {
		source string
		want   string
	}{
		{`module bad; fn keep(x: Typo) -> Typo { return x; }`, `unknown nominal type "Typo"`},
		{`module bad; fn keep(x: other.mod.Value) -> other.mod.Value { return x; }`, `requires direct use other.mod`},
		{`module bad; fn main() { let x: Typo = 1; }`, `unknown nominal type "Typo"`},
	}
	for _, tc := range cases {
		_, err := ParseCoreModule("bad.swyp", tc.source)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("source=%s error=%v want=%q", tc.source, err, tc.want)
		}
	}
}

func TestNominalTypesRemainFailClosedInCoreBackend(t *testing.T) {
	p, err := ParseCoreModule("model.swyp", `module domain.model;
struct User { id: u64; }
fn keep(x: User) -> User { return x; }`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.HIRModule(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := p.CoreIR("keep"); err == nil || !strings.Contains(err.Error(), "does not support type User") {
		t.Fatalf("CoreIR nominal boundary error=%v", err)
	}
}
