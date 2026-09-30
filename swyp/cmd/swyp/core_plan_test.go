package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCorePlanCommand(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "add.swyp")
	if err := os.WriteFile(source, []byte(`
fn add(x:i64,y:i64)->i64 { return x+y; }
fn main(){}
`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := corePlanCommand([]string{"-entry", "add", "-gprs", "2", "-fps", "1", source}, &out); err != nil {
		t.Fatal(err)
	}
	text := out.String()
	for _, want := range []string{`"name": "add"`, `"gpr_used": 2`, `"spills": 0`} {
		if !strings.Contains(text, want) {
			t.Fatalf("plan missing %s:\n%s", want, text)
		}
	}
}
