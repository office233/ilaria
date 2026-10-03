package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCompilerIdentityChangesWhenExecutableChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "compiler")
	if err := os.WriteFile(path, []byte("v1"), 0600); err != nil {
		t.Fatal(err)
	}
	before := compilerIdentity(path)
	if err := os.WriteFile(path, []byte("version-two"), 0600); err != nil {
		t.Fatal(err)
	}
	if after := compilerIdentity(path); after == before {
		t.Fatalf("compiler identity did not change after executable replacement: %q", after)
	}
}
