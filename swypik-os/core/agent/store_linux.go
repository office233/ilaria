//go:build linux

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
)

const checkpointLimit = 1 << 20
const checkpointName = "current-run.json"

type diskCheckpoint struct {
	Version int `json:"version"`
	Run     Run `json:"run"`
}
type fileStore struct {
	mu     sync.Mutex
	dir    *os.File
	lock   *os.File
	closed bool
}

// OpenFileStore is Linux-only. Use a private local filesystem directory, not a
// shared/remote/Windows mount. Parents must be trusted. Operations after open
// are relative to the directory descriptor; symlinks and special files fail.
// The lock is advisory between cooperating processes, not a hostile-code sandbox.
func OpenFileStore(path string) (DurableStore, error) {
	if path == "" || !filepath.IsAbs(path) {
		return nil, fmt.Errorf("checkpoint directory must be absolute")
	}
	if err := os.MkdirAll(path, 0700); err != nil {
		return nil, err
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	s := &fileStore{dir: os.NewFile(uintptr(fd), path)}
	info, err := s.dir.Stat()
	if err != nil {
		s.dir.Close()
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0077 != 0 {
		s.dir.Close()
		return nil, fmt.Errorf("checkpoint directory must be owner-only and owned by this user")
	}
	s.lock, err = s.openRegular("writer.lock", syscall.O_RDWR|syscall.O_CREAT, 0600)
	if err != nil {
		s.dir.Close()
		return nil, err
	}
	if err = syscall.Flock(int(s.lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		s.lock.Close()
		s.dir.Close()
		return nil, fmt.Errorf("checkpoint store already in use: %w", err)
	}
	return s, nil
}

// openRegular also rejects hard links and files accessible by other users.
func (s *fileStore) openRegular(name string, flags int, mode uint32) (*os.File, error) {
	fd, err := syscall.Openat(int(s.dir.Fd()), name, flags|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, mode)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || stat.Nlink != 1 || stat.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0077 != 0 {
		f.Close()
		return nil, fmt.Errorf("checkpoint files must be private, owner-controlled regular files")
	}
	return f, nil
}
func (s *fileStore) Load() (*Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, ErrClosed
	}
	f, err := s.openRegular(checkpointName, syscall.O_RDONLY, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > checkpointLimit {
		return nil, fmt.Errorf("%w: checkpoint exceeds size limit", ErrInvalidCheckpoint)
	}
	raw, err := io.ReadAll(io.LimitReader(f, checkpointLimit+1))
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

// Save uses file sync -> same-directory rename -> directory sync. A failure at
// ANY step is returned. This does not promise durability on unsupported storage
// or persistence across reboot when the live image stores /var in tmpfs.
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
	temporary := ".run-" + id + ".tmp"
	f, err := s.openRegular(temporary, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer syscall.Unlinkat(int(s.dir.Fd()), temporary)
	n, err := f.Write(raw)
	if err == nil && n != len(raw) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := syscall.Renameat(int(s.dir.Fd()), temporary, int(s.dir.Fd()), checkpointName); err != nil {
		return err
	}
	return s.dir.Sync()
}

// Quarantine renames an invalid checkpoint to a unique name in the same private
// directory so it remains available for inspection. It never deletes data.
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
	if err := syscall.Renameat(int(s.dir.Fd()), checkpointName, int(s.dir.Fd()), name); err != nil {
		return "", err
	}
	return name, s.dir.Sync()
}

func (s *fileStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	// Never unlink writer.lock: removing it permits a second lock inode/writer.
	return errors.Join(s.lock.Close(), s.dir.Close())
}
