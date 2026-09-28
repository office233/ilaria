package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSynthesisRejectsIncompleteNumbers(t *testing.T) {
	for i, input := range []string{
		`{"examples":[{"x":1}]}`,
		`{"examples":[{"y":1}]}`,
		`{"examples":[{"x":null,"y":0}]}`,
		`{"examples":[{"x":0,"y":null}]}`,
		`{"examples":[{"x":0,"y":0}],"constants":[null]}`,
		`{"examples":[{"x":0,"y":0}],"validation":[{"x":2}]}`,
		`{"examples":[{"x":0,"y":0}],"validation":[{"x":0,"y":1}]}`,
	} {
		dir := t.TempDir()
		spec := filepath.Join(dir, "spec.json")
		out := filepath.Join(dir, "out.swyp")
		if err := os.WriteFile(spec, []byte(input), 0600); err != nil {
			t.Fatal(err)
		}
		if err := synthCommand([]string{"-o", out, spec}); err == nil {
			t.Fatalf("case %d accepted", i)
		}
		if _, err := os.Stat(out); !os.IsNotExist(err) {
			t.Fatalf("case %d wrote output", i)
		}
	}
}

func TestRefinementCLI(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "refined.swyp")
	if err := synthCommand([]string{"-o", out, "../../examples/swyp/synthesis-refine.json"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(out); err != nil {
		t.Fatal(err)
	}
}
