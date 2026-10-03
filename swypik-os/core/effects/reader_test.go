package effects

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestReaderExactRootAndWholeFileLimit(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "allowed.txt"), []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	r, err := OpenReader(map[string]string{"fixture": dir})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	data, err := r.Read(context.Background(), "fixture", "allowed.txt", 5)
	if err != nil || string(data) != "hello" {
		t.Fatalf("read=%q err=%v", data, err)
	}
	for _, path := range []string{"", ".", "../allowed.txt", "/allowed.txt", "a/../allowed.txt", "a\\allowed.txt", "C:allowed.txt", "allowed.txt\x00"} {
		if data, err := r.Read(context.Background(), "fixture", path, 5); !errors.Is(err, ErrReadScope) || len(data) != 0 {
			t.Fatalf("resource=%q data=%q err=%v", path, data, err)
		}
	}
	if data, err := r.Read(context.Background(), "missing", "allowed.txt", 5); !errors.Is(err, ErrReadScope) || len(data) != 0 {
		t.Fatalf("unknown root: data=%q err=%v", data, err)
	}
	if data, err := r.Read(context.Background(), "fixture", "allowed.txt", 4); !errors.Is(err, ErrReadLimit) || len(data) != 0 {
		t.Fatalf("oversize: data=%q err=%v", data, err)
	}
	if data, err := r.Read(context.Background(), "fixture", "allowed.txt", 0); !errors.Is(err, ErrReadScope) || len(data) != 0 {
		t.Fatalf("zero limit: data=%q err=%v", data, err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.Read(cancelled, "fixture", "allowed.txt", 5); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled read err=%v", err)
	}
	if data, err := r.Read(context.Background(), "fixture", "subdir", 5); err == nil || len(data) != 0 {
		t.Fatalf("missing resource: data=%q err=%v", data, err)
	}
}

func TestReaderRejectsOutsideSymlink(t *testing.T) {
	dir, outside := t.TempDir(), t.TempDir()
	target := filepath.Join(outside, "outside.txt")
	if err := os.WriteFile(target, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "link")); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	r, err := OpenReader(map[string]string{"fixture": dir})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if data, err := r.Read(context.Background(), "fixture", "link", 20); err == nil || len(data) != 0 {
		t.Fatalf("escaped root: data=%q err=%v", data, err)
	}
}
