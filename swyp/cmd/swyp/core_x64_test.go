package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreX64CommandCreatesAssembly(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "add.swyp")
	outPath := filepath.Join(dir, "add.s")
	if err := os.WriteFile(source, []byte(`fn add(x:i64,y:i64)->i64{return x+y;} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64Command([]string{"-entry", "add", "-o", outPath, source}, &out); err != nil {
		t.Fatal(err)
	}
	assembly, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(assembly), "swyp_core_add") || !strings.Contains(out.String(), coreX64LeafMarker()) {
		t.Fatalf("stdout=%q assembly=%s", out.String(), assembly)
	}
	if err := coreX64Command([]string{"-entry", "add", "-o", outPath, source}, &out); err == nil {
		t.Fatal("core-x64 overwrote existing output")
	}
}

func coreX64LeafMarker() string { return "swyp-x64-cfg-win64-v1" }
