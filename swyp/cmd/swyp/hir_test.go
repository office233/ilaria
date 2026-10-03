package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"swyp-lang/internal/hir"
)

func TestHIRCommandForProgramAndComponentSources(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name   string
		source string
		kind   string
	}{
		{"core-library", "module app.math; fn square(x: i64) -> i64 { return x * x; }", "fn"},
		{"legacy-library", "module compat.math; fn id(x: number) -> number { return x; }", "fn"},
		{"struct-library", "module domain.types; struct User { id: u64; }", "struct"},
		{"enum-library", "module domain.status; enum Lookup { Missing; Found(u64); }", "enum"},
		{"component", "module platform.protocols; record Request { field id: string; }", "record"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, tc.name+".swyp")
			if err := os.WriteFile(path, []byte(tc.source), 0o600); err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			if err := hirCommand([]string{path}, &out); err != nil {
				t.Fatal(err)
			}
			var module hir.Module
			if err := json.Unmarshal(out.Bytes(), &module); err != nil {
				t.Fatal(err)
			}
			if err := module.Validate(); err != nil {
				t.Fatal(err)
			}
			var found bool
			for _, d := range module.Declarations {
				if d.ID.Kind == tc.kind {
					found = true
					if tc.kind == "fn" && (d.Function == nil || len(d.Function.Body) == 0) {
						t.Fatalf("function body missing from HIR: %+v", d)
					}
				}
			}
			if !found {
				t.Fatalf("kind %s missing from %+v", tc.kind, module.Declarations)
			}
		})
	}
}
