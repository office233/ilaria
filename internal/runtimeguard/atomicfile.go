package runtimeguard

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// atomicWriteMu serializes this process's config publications. Concurrent
// replacement of one target can fail with Access Denied on Windows.
// A single bounded lock also avoids path-alias and lock-map lifetime issues.
var atomicWriteMu sync.Mutex

// AtomicWriteFile avoids truncating the previous file on a failed write.
// In-process writers are serialized. Other processes must coordinate separately.
// This is not a multi-file snapshot or a power-loss guarantee; os.Rename
// is not guaranteed atomic on non-Unix platforms, including Windows.
func AtomicWriteFile(path string, data []byte, mode os.FileMode) error {
	atomicWriteMu.Lock()
	defer atomicWriteMu.Unlock()
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*.tmp")
	if err != nil {
		return err
	}
	temporary := f.Name()
	defer os.Remove(temporary)
	defer f.Close()
	if err := f.Chmod(mode); err != nil {
		return err
	}
	if n, err := f.Write(data); err != nil {
		return err
	} else if n != len(data) {
		return io.ErrShortWrite
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		return fmt.Errorf("publish %s: %w", path, err)
	}
	return nil
}
