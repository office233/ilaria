package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"swyp-lang/internal/hir"
)

func TestHIRLayoutCommandPlansImportedStruct(t *testing.T) {
	root := t.TempDir()
	app := writeHIRLinkFile(t, root, "app/main.swyp", `module app.main;
use lib.types;
fn main() {}`)
	writeHIRLinkFile(t, root, "lib/types.swyp", `module lib.types;
struct Packet { kind: u8; id: u64; tag: array<u8,3>; }`)
	var out bytes.Buffer
	if err := hirLayoutCommand([]string{"-root", root, "-type", "lib.types.Packet", app}, &out); err != nil {
		t.Fatal(err)
	}
	var layout hir.Layout
	if err := json.Unmarshal(out.Bytes(), &layout); err != nil {
		t.Fatal(err)
	}
	if layout.ABI != hir.FixedLayoutABI || layout.Size != 24 || layout.Align != 8 || len(layout.Fields) != 3 {
		t.Fatalf("layout=%+v", layout)
	}
}

func TestHIRLayoutCommandFailsClosedForSlice(t *testing.T) {
	root := t.TempDir()
	app := writeHIRLinkFile(t, root, "app/main.swyp", `module app.main;
fn main() {}`)
	var out bytes.Buffer
	err := hirLayoutCommand([]string{"-root", root, "-type", "slice<u64>", app}, &out)
	if err == nil || !strings.Contains(err.Error(), "undefined until ownership/descriptor ABI") {
		t.Fatalf("slice layout error=%v output=%s", err, out.String())
	}
	if out.Len() != 0 {
		t.Fatalf("layout command emitted output on failure: %s", out.String())
	}
}
