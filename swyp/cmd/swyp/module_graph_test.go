package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"swyp-lang/internal/sourcefront"
)

func TestModuleGraphCommandResolvesExplicitRoot(t *testing.T) {
	root := t.TempDir()
	write := func(rel, source string) string {
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
	mainPath := write("app/main.swyp", "module app.main; use lib.math; fn main() {}")
	write("lib/math.swyp", "module lib.math; fn square() {}")
	var out bytes.Buffer
	if err := moduleGraphCommand([]string{"-root", root, mainPath}, &out); err != nil {
		t.Fatal(err)
	}
	var graph sourcefront.Graph
	if err := json.Unmarshal(out.Bytes(), &graph); err != nil {
		t.Fatal(err)
	}
	if graph.Root != "app.main" || len(graph.Nodes) != 2 {
		t.Fatalf("graph=%+v", graph)
	}
}
