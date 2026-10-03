package runtimeguard

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestAtomicWriteAndPrivatePermissions(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(p, []byte("old"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWriteFile(p, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(p)
	if err != nil || string(b) != "new" {
		t.Fatal(string(b), err)
	}
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0600 {
		t.Fatal("config not private")
	}
}

func TestAtomicFailedPublicationLeavesTarget(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "existing")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(target, "keep")
	if err := os.WriteFile(marker, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWriteFile(target, []byte("new"), 0600); err == nil {
		t.Fatal("replaced nonempty directory")
	}
	b, err := os.ReadFile(marker)
	if err != nil || string(b) != "old" {
		t.Fatal("target was lost")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatal("temporary file leaked", err)
	}
}

func TestAtomicReadersSeeWholeWrites(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config")
	a, b := strings.Repeat("a", 10000), strings.Repeat("b", 10000)
	if err := AtomicWriteFile(p, []byte(a), 0600); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s := a
			if i%2 != 0 {
				s = b
			}
			if err := AtomicWriteFile(p, []byte(s), 0600); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	data, err := os.ReadFile(p)
	if err != nil || (string(data) != a && string(data) != b) {
		t.Fatal("partial file visible", err)
	}
}
