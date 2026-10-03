package main

import (
	"bytes"
	"encoding/json"
	"testing"

	"swyp-lang/internal/hir"
)

func TestHIRDescriptorCommandPlansSlice(t *testing.T) {
	root := t.TempDir()
	app := writeHIRLinkFile(t, root, "app/main.swyp", `module app.main;
fn noop() {}`)
	var out bytes.Buffer
	if err := hirDescriptorCommand([]string{"-root", root, "-type", "slice<u64>", app}, &out); err != nil {
		t.Fatal(err)
	}
	var plan hir.DescriptorPlan
	if err := json.Unmarshal(out.Bytes(), &plan); err != nil {
		t.Fatal(err)
	}
	if plan.ABI != hir.DescriptorABI || plan.Kind != "slice" || plan.ElementStride != 8 || plan.Ownership != hir.OwnershipBorrowed {
		t.Fatalf("descriptor plan=%+v", plan)
	}
}
