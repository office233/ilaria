//go:build windows

package plancache

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func tryLockFile(file *os.File) (bool, error) {
	var overlapped windows.Overlapped
	err := windows.LockFileEx(
		windows.Handle(file.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0,
		1,
		0,
		&overlapped,
	)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return false, nil
	}
	return false, err
}

func unlockFile(file *os.File) error {
	var overlapped windows.Overlapped
	return windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, &overlapped)
}

func syncDirectory(_ *os.File) error {
	// FlushFileBuffers on directory handles is not a supported durability
	// primitive on Windows. File payloads are flushed before the atomic rename;
	// loss of the rename itself after power loss is a safe cache miss.
	return nil
}
