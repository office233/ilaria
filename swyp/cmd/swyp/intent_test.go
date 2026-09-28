package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExpansionResponse(t *testing.T) {
	source := `fn main(){#natural: "print 7";}`
	for _, reply := range []string{`{"replacements":[{"id":0,"code":"print(7);"}]}`, `{"replacements":[]}`, `{"replacements":[{"id":0,"code":"print(x);"}]}`, `{"replacements":[{"id":0,"code":"print(7);","extra":true}]}`, `{"replacements":[]} {}`, `UNSUPPORTED: email`} {
		expanded, err := expandedIntent(context.Background(), replayBackend{reply}, "test", source)
		valid := strings.Contains(reply, `"print(7);"`) && !strings.Contains(reply, "extra")
		if (err == nil) != valid {
			t.Fatalf("%s: %s %v", reply, expanded, err)
		}
	}
}
func TestGenerationExclusive(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "new.swyp")
	record := generationRecord{Backend: "fixture", OutputSHA256: digest("abc")}
	if err := saveGeneration(out, "abc", record); err != nil {
		t.Fatal(err)
	}
	if err := saveGeneration(out, "overwrite", record); err == nil {
		t.Fatal("overwrote source")
	}
	data, _ := os.ReadFile(out)
	if string(data) != "abc" {
		t.Fatal("source changed")
	}
	manifest, _ := os.ReadFile(out + ".lock.json")
	var got generationRecord
	if err := json.Unmarshal(manifest, &got); err != nil {
		t.Fatal(err)
	}
	if got.OutputSHA256 != digest(string(data)) {
		t.Fatal("bad provenance")
	}
	blocked := filepath.Join(dir, "blocked.swyp")
	if err := os.WriteFile(blocked+".lock.json", []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := saveGeneration(blocked, "abc", record); err == nil {
		t.Fatal("overwrote lock")
	}
	if _, err := os.Stat(blocked); !os.IsNotExist(err) {
		t.Fatal("left partial output")
	}
}
func TestRepairReplay(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "broken.swyp")
	response := filepath.Join(dir, "response.swyp")
	out := filepath.Join(dir, "fixed.swyp")
	for path, text := range map[string]string{input: `fn main(){print(totla);}`, response: `fn main(){print(385);}`} {
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := intentCommand("repair", []string{"-o", out, "-response", response, input}); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(input)
	if string(data) != `fn main(){print(totla);}` {
		t.Fatal("changed original")
	}
	data, _ = os.ReadFile(out)
	if !strings.Contains(string(data), "OFFLINE FIXTURE REPLAY") {
		t.Fatal("misrepresented backend")
	}
}
