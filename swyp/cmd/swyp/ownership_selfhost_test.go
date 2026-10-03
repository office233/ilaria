package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"
)

func TestSelfhostHIRGateRejectsDuplicateExclusiveCall(t *testing.T) {
	root := t.TempDir()
	source := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn f(a: mutref<u64>, b: mutref<u64>) -> u64 { return *a + *b; }
fn run() -> u64 {
    let x: u64 = 7;
    let r = &mut x;
    let result: u64 = f(r, r);
    drop(r);
    return result;
}`)
	var log bytes.Buffer
	err := hirCoreCommand([]string{"-root", root, "-entry", "run", "-o", filepath.Join(root, "rejected.json"), source}, &log)
	if err == nil || !strings.Contains(err.Error(), "HIR ownership gate exclusive_call_alias") {
		t.Fatalf("duplicate loan bypassed mandatory HIR ownership gate: %v\n%s", err, log.String())
	}
}
