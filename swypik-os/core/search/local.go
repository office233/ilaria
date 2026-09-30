package search

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	resourcepolicy "swypik-os/core/resource"
)

// LocalReport summarizes one IndexDirectory pass.
type LocalReport struct {
	Root    string   `json:"root"`
	Scanned int      `json:"scanned"`
	Indexed int      `json:"indexed"`
	Removed int      `json:"removed"`
	Skipped int      `json:"skipped"`
	Errors  []string `json:"errors"`
}

const maxLocalFileBytes = 1 << 20

// Text formats indexed by content. Binary formats (PDF, DOCX) need dedicated
// extractors and are skipped rather than indexed as noise.
var textExtensions = map[string]bool{
	".txt": true, ".md": true, ".markdown": true, ".rst": true, ".csv": true, ".tsv": true, ".log": true,
	".json": true, ".yaml": true, ".yml": true, ".toml": true, ".ini": true, ".xml": true, ".html": true, ".htm": true, ".css": true,
	".go": true, ".py": true, ".js": true, ".mjs": true, ".ts": true, ".tsx": true, ".jsx": true, ".java": true, ".kt": true,
	".c": true, ".h": true, ".cpp": true, ".hpp": true, ".cs": true, ".rs": true, ".rb": true, ".php": true, ".swift": true,
	".sh": true, ".ps1": true, ".bat": true, ".sql": true, ".lua": true, ".dart": true, ".vue": true, ".svelte": true,
}

// Directories that hold generated or third-party content.
var skippedDirs = map[string]bool{"node_modules": true, "vendor": true, "bin": true, "obj": true, "out": true, "dist": true, "build": true, "target": true, "__pycache__": true}

// FileURL is the index identity of a local file.
func FileURL(path string) string {
	p := filepath.ToSlash(path)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p // Windows drive paths: /D:/dir/file
	}
	return (&url.URL{Scheme: "file", Path: p}).String()
}

// FilePath converts a file URL produced by FileURL back to a local path.
func FilePath(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "file" {
		return "", false
	}
	p := u.Path
	if len(p) > 2 && p[0] == '/' && p[2] == ':' {
		p = p[1:]
	}
	return filepath.FromSlash(p), true
}

// IndexDirectory indexes text files under root (hidden and generated
// directories and symlinks are skipped) and removes index entries for files
// under root that no longer exist. Unchanged files are not rewritten.
func (e *Engine) IndexDirectory(ctx context.Context, root string, maxFiles int) (LocalReport, error) {
	abs, err := filepath.Abs(root)
	report := LocalReport{Root: abs, Errors: []string{}}
	if err != nil {
		return report, err
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return report, fmt.Errorf("not a directory: %s", abs)
	}
	if maxFiles <= 0 {
		maxFiles = resourcepolicy.Default().SearchMaxFiles
	}
	if maxFiles > e.activeDocumentLimit() {
		maxFiles = e.activeDocumentLimit()
	} else if maxFiles > MaxDocuments {
		maxFiles = MaxDocuments
	}
	seen := make(map[string]bool, min(maxFiles, 1024))
	batch := make([]Document, 0, 100)
	flush := func() error {
		n, err := e.UpsertMany(batch)
		report.Indexed += n
		batch = batch[:0]
		return err
	}
	walkErr := filepath.WalkDir(abs, func(path string, d fs.DirEntry, err error) error {
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		if err != nil {
			report.Errors = append(report.Errors, err.Error())
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if path != abs && (strings.HasPrefix(name, ".") || skippedDirs[strings.ToLower(name)]) {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 || !d.Type().IsRegular() || strings.HasPrefix(name, ".") || !textExtensions[strings.ToLower(filepath.Ext(name))] {
			return nil
		}
		report.Scanned++
		if report.Scanned > maxFiles {
			return fs.SkipAll
		}
		u := FileURL(path)
		fi, err := d.Info()
		if err != nil || fi.Size() > maxLocalFileBytes || fi.Size() == 0 {
			report.Skipped++
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			report.Errors = append(report.Errors, err.Error())
			return nil
		}
		data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
		head := data
		if len(head) > 8192 {
			head = head[:8192]
		}
		if bytes.IndexByte(head, 0) >= 0 || !utf8.Valid(data) {
			report.Skipped++
			return nil
		}
		text := compactLocalText(data, e.activeTextLimit())
		if text == "" {
			report.Skipped++
			return nil
		}
		seen[u] = true // files that became unreadable or binary are removed below
		rel, _ := filepath.Rel(abs, path)
		digest := sha256.Sum256(data)
		batch = append(batch, Document{URL: u, Title: clip(filepath.ToSlash(rel), 512), Text: text, FetchedAt: fi.ModTime().UTC().Truncate(time.Second), SHA256: hex.EncodeToString(digest[:])})
		if len(batch) >= 100 {
			return flush()
		}
		return nil
	})
	if err := flush(); err != nil {
		return report, err
	}
	if walkErr != nil && walkErr != fs.SkipAll {
		return report, walkErr
	}
	prefix := FileURL(abs)
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	// Removal is only safe after a complete walk.
	if report.Scanned <= maxFiles {
		for _, u := range e.URLs(prefix) {
			if !seen[u] {
				if err := e.Delete(u); err != nil {
					return report, err
				}
				report.Removed++
			}
		}
	}
	return report, nil
}

// compactLocalText collapses Unicode whitespace in one pass directly from the
// validated UTF-8 byte slice and stops once the index text budget is full. This
// avoids materializing string(data), []string fields and a second joined copy
// for every indexed file.
func compactLocalText(data []byte, limit int) string {
	if limit <= 0 || len(data) == 0 {
		return ""
	}
	var b strings.Builder
	if len(data) < limit {
		b.Grow(len(data))
	} else {
		b.Grow(limit)
	}
	pendingSpace := false
	started := false
	for len(data) > 0 {
		r, n := utf8.DecodeRune(data)
		if r == utf8.RuneError && n == 1 {
			break // caller validates UTF-8; fail closed if reused independently.
		}
		data = data[n:]
		if unicode.IsSpace(r) {
			if started {
				pendingSpace = true
			}
			continue
		}
		runeBytes := utf8.RuneLen(r)
		needed := runeBytes
		if pendingSpace {
			needed++
		}
		if b.Len()+needed > limit {
			break
		}
		if pendingSpace {
			b.WriteByte(' ')
			pendingSpace = false
		}
		b.WriteRune(r)
		started = true
	}
	return b.String()
}
