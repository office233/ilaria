package effects

import (
	"context"
	"errors"
	"path/filepath"
	"syscall"
	"testing"
)

func TestReaderRejectsFIFOWithoutBlocking(t *testing.T) {
	dir := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(dir, "fifo"), 0600); err != nil {
		t.Fatal(err)
	}
	r, err := OpenReader(map[string]string{"fixture": dir})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if data, err := r.Read(context.Background(), "fixture", "fifo", 20); !errors.Is(err, ErrReadScope) || len(data) != 0 {
		t.Fatalf("fifo data=%q err=%v", data, err)
	}
}
