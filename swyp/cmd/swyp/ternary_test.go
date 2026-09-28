package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTernaryCommand(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sum.tasm")
	source := "const r1 0\nconst r2 1\nloop: jz r0 done\nadd r1 r0\nsub r0 r2\njmp loop\ndone: halt r1\n"
	if err := os.WriteFile(path, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	if err := ternaryCommand([]string{"-steps", "1000", path, "10"}); err != nil {
		t.Fatal(err)
	}
}

func TestTernaryCommandRejectsBadInput(t *testing.T) {
	if err := ternaryCommand(nil); err == nil {
		t.Fatal("expected usage error")
	}
}
