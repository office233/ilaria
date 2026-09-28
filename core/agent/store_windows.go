//go:build windows

package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"unsafe"
)

const checkpointLimit = 1 << 20
const checkpointName = "current-run.json"

var (
	kernel32Store   = syscall.NewLazyDLL("kernel32.dll")
	procLockFileEx  = kernel32Store.NewProc("LockFileEx")
	procMoveFileExW = kernel32Store.NewProc("MoveFileExW")
)

type diskCheckpoint struct {
	Version int `json:"version"`
	Run     Run `json:"run"`
}

type fileStore struct {
	mu     sync.Mutex
	dir    string
	lock   *os.File
	closed bool
}

// OpenFileStore keeps checkpoints in a per-user directory (use one under
// %LOCALAPPDATA%, whose ACL is private to the user). An exclusive LockFileEx
// on writer.lock admits one writer process; a second desktop fails to open.
func OpenFileStore(path string) (DurableStore, error) {
	if path == "" || !filepath.IsAbs(path) {
		return nil, fmt.Errorf("checkpoint directory must be absolute")
	}
	if err := os.MkdirAll(path, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("checkpoint directory must be a real directory")
	}
	lock, err := os.OpenFile(filepath.Join(path, "writer.lock"), os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, err
	}
	var overlapped syscall.Overlapped
	// LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY
	if ok, _, callErr := procLockFileEx.Call(lock.Fd(), 0x2|0x1, 0, 1, 0, uintptr(unsafe.Pointer(&overlapped))); ok == 0 {
		lock.Close()
		return nil, fmt.Errorf("checkpoint store already in use: %v", callErr)
	}
	return &fileStore{dir: path, lock: lock}, nil
}

func (s *fileStore) file(name string) string { return filepath.Join(s.dir, name) }

func (s *fileStore) Load() (*Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, ErrClosed
	}
	info, err := os.Lstat(s.file(checkpointName))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("checkpoint is not a regular file")
	}
	if info.Size() > checkpointLimit {
		return nil, fmt.Errorf("%w: checkpoint exceeds size limit", ErrInvalidCheckpoint)
	}
	f, err := os.Open(s.file(checkpointName))
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(io.LimitReader(f, checkpointLimit+1))
	f.Close()
	if err != nil {
		return nil, err
	}
	var state diskCheckpoint
	if err := DecodeObject(raw, &state, checkpointLimit); err != nil {
		return nil, fmt.Errorf("%w: JSON: %v", ErrInvalidCheckpoint, err)
	}
	if state.Version != 1 {
		return nil, fmt.Errorf("%w: unsupported version %d", ErrInvalidCheckpoint, state.Version)
	}
	if err := validateRun(state.Run); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidCheckpoint, err)
	}
	r := copyRun(state.Run)
	return &r, nil
}

// moveReplace is MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH): the rename is
// flushed before it returns, the Windows analogue of rename + directory fsync.
func moveReplace(from, to string) error {
	f, err := syscall.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	t, err := syscall.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	if ok, _, callErr := procMoveFileExW.Call(uintptr(unsafe.Pointer(f)), uintptr(unsafe.Pointer(t)), 0x1|0x8); ok == 0 {
		return fmt.Errorf("replace checkpoint: %v", callErr)
	}
	return nil
}

// Save writes a temp file, flushes it and atomically replaces the checkpoint.
// Any failure is returned; the runtime then blocks further work.
func (s *fileStore) Save(r Run) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	if err := validateRun(r); err != nil {
		return err
	}
	raw, err := json.Marshal(diskCheckpoint{Version: 1, Run: r})
	if err != nil {
		return err
	}
	if len(raw) > checkpointLimit {
		return fmt.Errorf("checkpoint exceeds size limit")
	}
	id, err := randomID()
	if err != nil {
		return err
	}
	temporary := s.file(".run-" + id[:16] + ".tmp")
	f, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer os.Remove(temporary)
	n, err := f.Write(raw)
	if err == nil && n != len(raw) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = f.Sync()
	}
	if err = errors.Join(err, f.Close()); err != nil {
		return err
	}
	return moveReplace(temporary, s.file(checkpointName))
}

// Quarantine renames an invalid checkpoint for inspection; it never deletes.
func (s *fileStore) Quarantine() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return "", ErrClosed
	}
	id, err := randomID()
	if err != nil {
		return "", err
	}
	name := "invalid-run-" + id[:16] + ".json"
	return name, os.Rename(s.file(checkpointName), s.file(name))
}

func (s *fileStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	// Closing the handle releases the lock. Never delete writer.lock.
	return s.lock.Close()
}
