package swyplang

import (
	"strings"
	"testing"
)

func TestHIRStructConstructionAndFieldProjection(t *testing.T) {
	p, err := ParseCoreModule("users.swyp", `module domain.users;
struct User {
    id: u64;
    active: bool;
}
fn make(id: u64) -> User {
    return new User { id: id, active: true };
}
fn user_id(user: User) -> u64 {
    return user.id;
}`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	var sawConstruct, sawField bool
	for _, decl := range m.Declarations {
		if decl.Function == nil || len(decl.Function.Body) == 0 {
			continue
		}
		value := decl.Function.Body[0].Value
		switch decl.ID.Name {
		case "make":
			sawConstruct = value != nil && value.Kind == "struct" && value.Type.String() == "User" && len(value.Fields) == 2
		case "user_id":
			sawField = value != nil && value.Kind == "field" && value.Name == "id" && value.Type.Name == "u64" && len(value.Args) == 1 && value.Args[0].Type.String() == "User"
		}
	}
	if !sawConstruct || !sawField {
		t.Fatalf("construct=%v field=%v HIR=%+v", sawConstruct, sawField, m)
	}
}

func TestHIRStructConstructionRejectsInvalidFields(t *testing.T) {
	cases := []struct {
		source string
		want   string
	}{
		{`module bad; struct User { id: u64; active: bool; } fn f() -> User { return new User { id: 1 }; }`, "missing field active"},
		{`module bad; struct User { id: u64; } fn f() -> User { return new User { id: 1, nope: 2 }; }`, "has no field nope"},
		{`module bad; struct User { id: u64; } fn f() -> User { return new User { id: true }; }`, "expected u64, got bool"},
		{`module bad; struct User { id: u64; } fn f(x: User) -> u64 { return x.nope; }`, "has no field nope"},
		{`module bad; fn f(x: u64) -> u64 { return x.value; }`, "field projection requires struct/record base"},
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

func TestHIRStructConstructionRemainsFailClosedInCore(t *testing.T) {
	p, err := ParseCoreModule("users.swyp", `module domain.users;
struct User { id: u64; }
fn make(id: u64) -> User { return new User { id: id }; }`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.HIRModule(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := p.CoreIR("make"); err == nil || !strings.Contains(err.Error(), "does not support type User") {
		t.Fatalf("Core nominal construction boundary error=%v", err)
	}
}

func TestHIRFieldProjectionParticipatesInTypedOperators(t *testing.T) {
	p, err := ParseCoreModule("users.swyp", `module domain.users;
struct User { id: u64; }
fn small(user: User) -> bool { return user.id < 10; }
fn plus_one(user: User) -> u64 { return user.id + 1; }`)
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
		case "small":
			if value.Kind != "binary" || value.Type.Name != "bool" || value.Args[0].Kind != "field" || value.Args[0].Type.Name != "u64" {
				t.Fatalf("small HIR=%+v", value)
			}
		case "plus_one":
			if value.Kind != "binary" || value.Type.Name != "u64" || value.Args[0].Kind != "field" || value.Args[0].Type.Name != "u64" {
				t.Fatalf("plus_one HIR=%+v", value)
			}
		}
	}
}
