//go:build !windows

package controlkernel

import (
	"fmt"
	"os"
	"syscall"
)

func acquireJournalLock(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("control-kernel journal already in use: %w", err)
	}
	return f, nil
}
