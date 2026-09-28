//go:build linux

package agent

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
)

func TestFileCheckpointRoundTripAndPrivateModes(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	store, err := OpenFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	r := pendingSavedRun(t)
	if err := store.Save(r); err != nil {
		t.Fatal(err)
	}
	got, err := store.Load()
	if err != nil || got.ID != r.ID || got.Approval.ID != r.Approval.ID {
		t.Fatal(got, err)
	}
	got.Approval.Arguments[0] = 'x'
	fresh, _ := store.Load()
	if !json.Valid(fresh.Approval.Arguments) {
		t.Fatal("mutated disk state")
	}
	for _, name := range []string{checkpointName, "writer.lock"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatal(name, info, err)
		}
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	again, err := OpenFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	restored, err := again.Load()
	if err != nil || restored.ID != r.ID {
		t.Fatal(err)
	}
}
func TestFileCheckpointExclusiveWriter(t *testing.T) {
	dir := t.TempDir()
	first, err := OpenFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := OpenFileStore(dir); err == nil {
		second.Close()
		t.Fatal("second writer acquired lock")
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestCheckpointLockHelper$")
	cmd.Env = append(os.Environ(), "SWYPIK_TEST_LOCK_DIR="+dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child lock check: %v %s", err, out)
	}
	first.Close()
	third, err := OpenFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	third.Close()
}
func TestCheckpointLockHelper(t *testing.T) {
	dir := os.Getenv("SWYPIK_TEST_LOCK_DIR")
	if dir == "" {
		return
	}
	s, err := OpenFileStore(dir)
	if err == nil {
		s.Close()
		t.Fatal("cross-process lock bypass")
	}
}
func TestCorruptCheckpointIsNeverSilentlyReplaced(t *testing.T) {
	r := pendingSavedRun(t)
	valid, _ := json.Marshal(diskCheckpoint{Version: 1, Run: r})
	wrongVersion := bytes.Replace(valid, []byte(`"version":1`), []byte(`"version":2`), 1)
	duplicates := append([]byte(`{"version":1,`), valid[1:]...)
	for _, raw := range [][]byte{[]byte("broken"), []byte(`{}`), wrongVersion, duplicates, []byte(strings.Repeat("x", checkpointLimit+1))} {
		dir := t.TempDir()
		path := filepath.Join(dir, checkpointName)
		if err := os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
		s, err := OpenFileStore(dir)
		if err != nil {
			t.Fatal(err)
		}
		var plans, tools atomic.Int32
		m, err := NewPersistent(recoveryPlanner(&plans, false), recoveryTools(&tools), Limits{}, s)
		if err == nil {
			m.Close()
			t.Fatal("accepted corrupt checkpoint")
		}
		s.Close()
		after, _ := os.ReadFile(path)
		if !bytes.Equal(raw, after) {
			t.Fatal("overwrote corrupt checkpoint")
		}
		if plans.Load() != 0 || tools.Load() != 0 {
			t.Fatal("corruption triggered execution")
		}
	}
}
func TestFileCheckpointRejectsSymlinksAndSpecialFiles(t *testing.T) {
	t.Run("directory", func(t *testing.T) {
		root := t.TempDir()
		target := t.TempDir()
		link := filepath.Join(root, "link")
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		if s, err := OpenFileStore(link); err == nil {
			s.Close()
			t.Fatal("followed directory symlink")
		}
	})
	for _, kind := range []string{"symlink", "hardlink", "fifo", "public"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(t.TempDir(), "target")
			if err := os.WriteFile(target, []byte("private"), 0600); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, checkpointName)
			var err error
			switch kind {
			case "symlink":
				err = os.Symlink(target, path)
			case "hardlink":
				err = os.Link(target, path)
			case "fifo":
				err = syscall.Mkfifo(path, 0600)
			case "public":
				err = os.WriteFile(path, []byte(`{}`), 0644)
			}
			if err != nil {
				t.Fatal(err)
			}
			s, err := OpenFileStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			if _, err := s.Load(); err == nil {
				t.Fatal("accepted", kind)
			}
		})
	}
}
func TestFileCheckpointUsesOpenDirectoryDescriptor(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "state")
	s, err := OpenFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	moved := filepath.Join(root, "original")
	if err := os.Rename(dir, moved); err != nil {
		t.Fatal(err)
	}
	replacement := t.TempDir()
	if err := os.Symlink(replacement, dir); err != nil {
		t.Fatal(err)
	}
	if err := s.Save(pendingSavedRun(t)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(moved, checkpointName)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(replacement, checkpointName)); !os.IsNotExist(err) {
		t.Fatal("write escaped opened directory")
	}
}
func TestFileCheckpointRejectsPublicDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if s, err := OpenFileStore(dir); err == nil {
		s.Close()
		t.Fatal("accepted shared checkpoint directory")
	}
}
