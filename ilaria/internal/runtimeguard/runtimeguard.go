// Package runtimeguard holds small, dependency-free runtime safety primitives.
package runtimeguard

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// ApplyExplicit invokes only the setters whose flags were explicitly provided.
// In particular, -flag=false and -seed=0 are real overrides, not absent flags.
func ApplyExplicit(fs *flag.FlagSet, setters map[string]func()) {
	fs.Visit(func(f *flag.Flag) {
		if set := setters[f.Name]; set != nil {
			set()
		}
	})
}

// EmptyStateDir is true only for an absent directory or a genuinely empty one.
// A partial checkpoint, unexpected file, permission error, or regular file is
// never interpreted as permission to overwrite the previous organism.
func EmptyStateDir(path string) (bool, error) {
	if strings.TrimSpace(path) == "" {
		return false, errors.New("empty state directory")
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect state directory: %w", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return false, err
	}
	if !info.IsDir() {
		return false, fmt.Errorf("state path %q is not a directory", path)
	}
	_, err = f.Readdirnames(1)
	if errors.Is(err, io.EOF) {
		return true, nil
	}
	return false, err
}

// TruncateRunes limits human-readable text by Unicode characters, not bytes.
func TruncateRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	count := 0
	for i := range s {
		if count == n {
			return s[:i] + "…"
		}
		count++
	}
	return s
}

// TruncateBytes respects a byte budget for the prefix without splitting UTF-8.
// The marker is additional to that budget, preserving the existing tool contract.
func TruncateBytes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) <= n {
		return s
	}
	cut := 0
	for i := range s {
		if i > n {
			break
		}
		cut = i
	}
	return s[:cut] + "…(truncated)"
}
