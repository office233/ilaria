//go:build windows

package controlkernel

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

var (
	kernel32Journal = syscall.NewLazyDLL("kernel32.dll")
	procLockJournal = kernel32Journal.NewProc("LockFileEx")
)

func acquireJournalLock(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, err
	}
	var overlapped syscall.Overlapped
	// LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY.
	if ok, _, callErr := procLockJournal.Call(f.Fd(), 0x2|0x1, 0, 1, 0, uintptr(unsafe.Pointer(&overlapped))); ok == 0 {
		_ = f.Close()
		return nil, fmt.Errorf("control-kernel journal already in use: %v", callErr)
	}
	return f, nil
}
