package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestComponentCheckAndCompile(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "platform.swyp")
	out := filepath.Join(dir, "platform.json")
	content := `
model IMC1B {
  architecture "ilaria-microcortex-v1";
  weights ternary;
  storage tritpack20;
  compute rgba32;
}
expert Router : IMC1B { specialty cognition.routing; }
dataset Curated { require provenance; forbid secrets; }
train Router on Curated { cohort 8; optimizer isx; local_steps 32; }
verify Grounded { check evidence; }
`
	if err := os.WriteFile(src, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := componentCommand([]string{"check", src}, &buf); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "5 declarations") {
		t.Fatalf("output=%q", buf.String())
	}
	buf.Reset()
	if err := componentCommand([]string{"compile", "-o", out, src}, &buf); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b, []byte(`"kind": "model"`)) {
		t.Fatalf("manifest=%s", b)
	}
	if err := componentCommand([]string{"compile", "-o", out, src}, &buf); err == nil {
		t.Fatal("second compile unexpectedly overwrote existing manifest")
	}
}

func TestComponentGo(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "records.swyp")
	out := filepath.Join(dir, "types_gen.go")
	if err := os.WriteFile(src, []byte(`
record TrainingJob {
  field job_id: string;
  field round_id: u64;
  field shard_hashes: string_list;
}
`), 0600); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := componentCommand([]string{"go", "-package", "computefabric", "-o", out, src}, &buf); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b, []byte("type TrainingJob struct")) {
		t.Fatalf("generated=%s", b)
	}
	if err := componentCommand([]string{"go", "-package", "computefabric", "-o", out, src}, &buf); err == nil {
		t.Fatal("second Go generation unexpectedly overwrote existing output")
	}
}
