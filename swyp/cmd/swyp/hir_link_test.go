package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"swyp-lang/internal/hir"
)

func TestHIRLinkCommandResolvesQualifiedImportedCall(t *testing.T) {
	root := t.TempDir()
	writeHIRLinkFile(t, root, "app/main.swyp", `module app.main;
use lib.math;
fn run(x: i64) -> i64 { return lib.math.square(x); }`)
	writeHIRLinkFile(t, root, "lib/math.swyp", `module lib.math;
fn square(x: i64) -> i64 { return x * x; }`)
	var out bytes.Buffer
	if err := hirLinkCommand([]string{"-root", root, filepath.Join(root, "app", "main.swyp")}, &out); err != nil {
		t.Fatal(err)
	}
	var bundle hir.Bundle
	if err := json.Unmarshal(out.Bytes(), &bundle); err != nil {
		t.Fatal(err)
	}
	if err := bundle.Validate(); err != nil {
		t.Fatal(err)
	}
	if bundle.Root != "app.main" || len(bundle.Modules) != 2 {
		t.Fatalf("bundle=%+v", bundle)
	}
	for _, module := range bundle.Modules {
		if module.Name != "app.main" {
			continue
		}
		for _, decl := range module.Declarations {
			if decl.ID.Name != "run" || decl.Function == nil || len(decl.Function.Body) != 1 {
				continue
			}
			call := decl.Function.Body[0].Value
			if call == nil || call.Callee == nil || call.Callee.Canonical() != "lib.math::fn::square" || call.Type.Name != "i64" {
				t.Fatalf("linked call=%+v", call)
			}
			return
		}
	}
	t.Fatal("linked run body not found")
}

func TestHIRLinkRequiresDirectUseAndMatchingTypes(t *testing.T) {
	root := t.TempDir()
	writeHIRLinkFile(t, root, "lib/math.swyp", `module lib.math;
fn square(x: i64) -> i64 { return x * x; }`)
	writeHIRLinkFile(t, root, "mid/wrap.swyp", `module mid.wrap;
use lib.math;
fn pass(x: i64) -> i64 { return lib.math.square(x); }`)
	app := writeHIRLinkFile(t, root, "app/main.swyp", `module app.main;
use mid.wrap;
fn run(x: i64) -> i64 { return lib.math.square(x); }`)
	var out bytes.Buffer
	err := hirLinkCommand([]string{"-root", root, app}, &out)
	if err == nil || !strings.Contains(err.Error(), "requires direct use lib.math") {
		t.Fatalf("direct-use error=%v output=%s", err, out.String())
	}

	writeHIRLinkFile(t, root, "app/bad.swyp", `module app.bad;
use lib.math;
fn run() -> i64 { return lib.math.square(true); }`)
	out.Reset()
	err = hirLinkCommand([]string{"-root", root, filepath.Join(root, "app", "bad.swyp")}, &out)
	if err == nil || !strings.Contains(err.Error(), "expected i64, got bool") {
		t.Fatalf("type error=%v output=%s", err, out.String())
	}
}

func TestHIRLinkResolvesQualifiedNominalTypesFromTypeOnlyModule(t *testing.T) {
	root := t.TempDir()
	app := writeHIRLinkFile(t, root, "app/main.swyp", `module app.main;
use lib.types;
fn keep(x: lib.types.User) -> lib.types.User { return x; }`)
	writeHIRLinkFile(t, root, "lib/types.swyp", `module lib.types;
struct User { id: u64; }`)
	var out bytes.Buffer
	if err := hirLinkCommand([]string{"-root", root, app}, &out); err != nil {
		t.Fatal(err)
	}
	var bundle hir.Bundle
	if err := json.Unmarshal(out.Bytes(), &bundle); err != nil {
		t.Fatal(err)
	}
	if err := bundle.Validate(); err != nil {
		t.Fatal(err)
	}
	var sawUser, sawKeep bool
	for _, module := range bundle.Modules {
		for _, decl := range module.Declarations {
			switch decl.ID.Canonical() {
			case "lib.types::struct::User":
				sawUser = true
			case "app.main::fn::keep":
				sawKeep = decl.Function != nil && len(decl.Function.Params) == 1 && decl.Function.Params[0].Type.String() == "lib.types.User"
			}
		}
	}
	if !sawUser || !sawKeep {
		t.Fatalf("linked nominal bundle missing user=%v keep=%v bundle=%+v", sawUser, sawKeep, bundle)
	}
}

func TestHIRLinkBuildsImportedStructValues(t *testing.T) {
	root := t.TempDir()
	app := writeHIRLinkFile(t, root, "app/main.swyp", `module app.main;
use lib.types;
fn make(id: u64) -> lib.types.User {
    return new lib.types.User { id: id, active: true };
}
fn read(user: lib.types.User) -> u64 {
    return user.id;
}`)
	writeHIRLinkFile(t, root, "lib/types.swyp", `module lib.types;
struct User { id: u64; active: bool; }`)
	var out bytes.Buffer
	if err := hirLinkCommand([]string{"-root", root, app}, &out); err != nil {
		t.Fatal(err)
	}
	var bundle hir.Bundle
	if err := json.Unmarshal(out.Bytes(), &bundle); err != nil {
		t.Fatal(err)
	}
	if err := bundle.Validate(); err != nil {
		t.Fatal(err)
	}
	var sawNew, sawRead bool
	for _, module := range bundle.Modules {
		if module.Name != "app.main" {
			continue
		}
		for _, decl := range module.Declarations {
			if decl.Function == nil || len(decl.Function.Body) == 0 || decl.Function.Body[0].Value == nil {
				continue
			}
			value := decl.Function.Body[0].Value
			switch decl.ID.Name {
			case "make":
				sawNew = value.Kind == "struct" && value.Type.String() == "lib.types.User" && len(value.Fields) == 2
			case "read":
				sawRead = value.Kind == "field" && value.Name == "id" && value.Type.Name == "u64"
			}
		}
	}
	if !sawNew || !sawRead {
		t.Fatalf("linked struct new=%v read=%v bundle=%+v", sawNew, sawRead, bundle)
	}
}

func TestHIRLinkBuildsImportedEnumAndMatch(t *testing.T) {
	root := t.TempDir()
	app := writeHIRLinkFile(t, root, "app/main.swyp", `module app.main;
use lib.status;
fn found(x: u64) -> lib.status.Lookup { return lib.status.Lookup::Found(x); }
fn unwrap(value: lib.status.Lookup) -> u64 {
    return match value { Missing => 0, Found(x) => x, };
}`)
	writeHIRLinkFile(t, root, "lib/status.swyp", `module lib.status;
enum Lookup { Missing; Found(u64); }`)
	var out bytes.Buffer
	if err := hirLinkCommand([]string{"-root", root, app}, &out); err != nil {
		t.Fatal(err)
	}
	var bundle hir.Bundle
	if err := json.Unmarshal(out.Bytes(), &bundle); err != nil {
		t.Fatal(err)
	}
	if err := bundle.Validate(); err != nil {
		t.Fatal(err)
	}
	var sawFound, sawMatch bool
	for _, module := range bundle.Modules {
		if module.Name != "app.main" {
			continue
		}
		for _, decl := range module.Declarations {
			if decl.Function == nil || len(decl.Function.Body) == 0 || decl.Function.Body[0].Value == nil {
				continue
			}
			value := decl.Function.Body[0].Value
			switch decl.ID.Name {
			case "found":
				sawFound = value.Kind == "enum" && value.Type.String() == "lib.status.Lookup" && value.Name == "Found"
			case "unwrap":
				sawMatch = value.Kind == "match" && len(value.Arms) == 2 && value.Arms[1].BindingType != nil && value.Arms[1].BindingType.Name == "u64"
			}
		}
	}
	if !sawFound || !sawMatch {
		t.Fatalf("linked enum found=%v match=%v bundle=%+v", sawFound, sawMatch, bundle)
	}
}

func writeHIRLinkFile(t *testing.T, root, rel, source string) string {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
