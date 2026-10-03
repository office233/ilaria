// Package effects is the SwypikOS execution boundary for explicitly granted
// effects. Requests never choose a host filesystem root or ambient authority.
package effects

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

var (
	ErrReadScope = errors.New("read resource is outside granted scope")
	ErrReadLimit = errors.New("read resource exceeds granted byte limit")
)

// Reader holds directory handles opened by trusted OS configuration. It never
// interprets a request's root name as a host path. Close requires that callers
// have stopped issuing reads.
type Reader struct {
	roots map[string]*os.Root
}

func OpenReader(roots map[string]string) (*Reader, error) {
	if runtime.GOOS != "windows" && runtime.GOOS != "linux" {
		return nil, fmt.Errorf("effect file provider supports Windows and Linux only")
	}
	r := &Reader{roots: make(map[string]*os.Root, len(roots))}
	for name, hostPath := range roots {
		if name == "" || !filepath.IsAbs(hostPath) {
			_ = r.Close()
			return nil, fmt.Errorf("read roots require aliases and absolute host paths")
		}
		root, err := os.OpenRoot(hostPath)
		if err != nil {
			_ = r.Close()
			return nil, fmt.Errorf("open configured read root %q: %w", name, err)
		}
		r.roots[name] = root
	}
	return r, nil
}

func validResource(name string) bool {
	return name != "" && name != "." && fs.ValidPath(name) && path.Clean(name) == name && !strings.ContainsAny(name, "\\:\x00")
}

// Read returns an entire regular file or no contents. Root confinement is
// enforced by os.Root even if directory entries change during the operation.
// Linux opens in nonblocking mode so a raced FIFO cannot hang before Stat.
func (r *Reader) Read(ctx context.Context, rootID, resource string, maxBytes int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if r == nil || maxBytes <= 0 || maxBytes > MaxValueBytes || !validResource(resource) {
		return nil, ErrReadScope
	}
	root, ok := r.roots[rootID]
	if !ok {
		return nil, ErrReadScope
	}
	f, err := root.OpenFile(resource, readOpenFlags(), 0)
	if err != nil {
		return nil, fmt.Errorf("open scoped read resource: %w", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, ErrReadScope
	}
	if info.Size() > maxBytes {
		return nil, ErrReadLimit
	}
	data, err := io.ReadAll(io.LimitReader(&contextReader{ctx: ctx, r: f}, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, ErrReadLimit
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return data, nil
}

func (r *Reader) Close() error {
	var result error
	if r != nil {
		for _, root := range r.roots {
			result = errors.Join(result, root.Close())
		}
	}
	return result
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}
