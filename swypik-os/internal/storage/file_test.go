package storage

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReplaceState(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "nested", "state.json")
	for _, value := range []string{"first", "second"} {
		if err := WriteFile(p, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(p)
		if err != nil || string(got) != value {
			t.Fatalf("readback: %q %v", got, err)
		}
	}
	entries, err := os.ReadDir(filepath.Dir(p))
	if err != nil || len(entries) != 1 {
		t.Fatalf("temporary files leaked: %v %v", entries, err)
	}
}
