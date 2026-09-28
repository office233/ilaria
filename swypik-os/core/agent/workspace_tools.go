package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"swypik-os/internal/safepath"
)

// RunFunc executes a command line in dir and returns its combined output. A
// non-nil error means the command failed or could not start. The runtime
// enforces the per-tool timeout through ctx.
type RunFunc func(ctx context.Context, command, dir string) (string, error)

const (
	maxReadableFile = 4 << 20
	maxReadChars    = 9000
	maxToolOutput   = 10 * 1024
)

type pathArguments struct {
	Path string `json:"path"`
}

// validRelativePath accepts forward-slash workspace-relative paths without
// traversal or hidden components (".git", ".env").
func validRelativePath(p string) error {
	if p == "" || len(p) > 512 || strings.HasPrefix(p, "/") || strings.ContainsRune(p, 0) || filepath.IsAbs(p) || filepath.VolumeName(p) != "" || strings.ContainsAny(p, ":\\") {
		return fmt.Errorf("workspace-relative forward-slash path required")
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".." || (part != "." && strings.HasPrefix(part, ".")) {
			return fmt.Errorf("hidden paths and traversal are unavailable")
		}
	}
	return nil
}

// fitJSON marshals build(budget), halving the text budget until the encoded
// result fits the runtime's per-observation limit. Escaping can grow text.
func fitJSON(budget int, build func(int) interface{}) (json.RawMessage, error) {
	for ; budget >= 256; budget /= 2 {
		out, err := json.Marshal(build(budget))
		if err != nil {
			return nil, err
		}
		if len(out) <= maxToolOutput+1024 {
			return out, nil
		}
	}
	return nil, fmt.Errorf("tool output cannot fit the observation limit")
}

// tail keeps the last n bytes of s on a rune boundary.
func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := len(s) - n
	for cut < len(s) && !utf8.RuneStart(s[cut]) {
		cut++
	}
	return "[…truncated]\n" + s[cut:]
}

func digest(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// resolveForWrite returns the absolute target for a new or existing file. The
// parent directory is created inside the workspace; an existing target must be
// a regular file that is not a link.
func resolveForWrite(root, rel string) (string, error) {
	clean := filepath.FromSlash(rel)
	parent := filepath.Dir(clean)
	// Check the nearest existing ancestor before creating anything, so a link
	// inside the workspace cannot make us create directories elsewhere.
	existing := filepath.Join(root, parent)
	for {
		if _, err := os.Stat(existing); err == nil {
			break
		}
		next := filepath.Dir(existing)
		if next == existing {
			return "", fmt.Errorf("workspace is unavailable")
		}
		existing = next
	}
	if !safepath.WithinExisting(existing, root) {
		return "", fmt.Errorf("path is outside workspace")
	}
	if err := os.MkdirAll(filepath.Join(root, parent), 0700); err != nil {
		return "", fmt.Errorf("cannot create directory")
	}
	dir, err := safepath.ResolveRelative(root, filepath.ToSlash(parent))
	if err != nil {
		return "", err
	}
	target := filepath.Join(dir, filepath.Base(clean))
	if info, err := os.Lstat(target); err == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return "", fmt.Errorf("target is not a regular file")
	}
	return target, nil
}

func readText(root, rel string) (string, []byte, error) {
	path, err := safepath.ResolveRelative(root, rel)
	if err != nil {
		return "", nil, err
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", nil, fmt.Errorf("not a regular file")
	}
	if info.Size() > maxReadableFile {
		return "", nil, fmt.Errorf("file exceeds %d bytes", maxReadableFile)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", nil, fmt.Errorf("cannot read file")
	}
	if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
		return "", nil, fmt.Errorf("binary or non-UTF-8 file")
	}
	return path, data, nil
}

// writeAtomic replaces or creates target via a same-directory temp file.
func writeAtomic(target string, content []byte, create bool) error {
	if create {
		f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return fmt.Errorf("file already exists or cannot be created")
		}
		_, err = f.Write(content)
		if err == nil {
			err = f.Sync()
		}
		return errors.Join(err, f.Close())
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), ".swypik-edit-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.Write(content)
	if err == nil {
		err = tmp.Sync()
	}
	if err = errors.Join(err, tmp.Close()); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), target)
}

// WorkspaceTools returns the full development tool set scoped to root. run may
// be nil, which omits process.run. Every call still requires user approval.
func WorkspaceTools(root string, run RunFunc) []Tool {
	tools := ReadOnlyTools(root)
	tools = append(tools, Tool{
		Spec: Spec{Name: "workspace.read", Description: "Read a UTF-8 text file in the workspace. Returns numbered lines and the file sha256 needed to modify it.", Arguments: `{"path":"dir/file.go","start_line":1,"max_lines":200}; start_line and max_lines optional`},
		Validate: func(raw json.RawMessage) error {
			var a struct {
				Path      string `json:"path"`
				StartLine int    `json:"start_line"`
				MaxLines  int    `json:"max_lines"`
			}
			if err := DecodeObject(raw, &a, 4096); err != nil {
				return err
			}
			if a.StartLine < 0 || a.MaxLines < 0 || a.MaxLines > 400 {
				return fmt.Errorf("invalid line range")
			}
			return validRelativePath(a.Path)
		},
		Execute: func(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
			var a struct {
				Path      string `json:"path"`
				StartLine int    `json:"start_line"`
				MaxLines  int    `json:"max_lines"`
			}
			_ = json.Unmarshal(raw, &a)
			_, data, err := readText(root, a.Path)
			if err != nil {
				return nil, err
			}
			lines := strings.Split(string(data), "\n")
			start := a.StartLine
			if start < 1 {
				start = 1
			}
			limit := a.MaxLines
			if limit == 0 {
				limit = 200
			}
			sum := digest(data)
			return fitJSON(maxReadChars, func(budget int) interface{} {
				var b strings.Builder
				end := start - 1
				for i := start - 1; i < len(lines) && i < start-1+limit; i++ {
					line := fmt.Sprintf("%d\t%s\n", i+1, strings.TrimRight(lines[i], "\r"))
					if b.Len()+len(line) > budget {
						break
					}
					b.WriteString(line)
					end = i + 1
				}
				return struct {
					Path       string `json:"path"`
					SHA256     string `json:"sha256"`
					TotalLines int    `json:"total_lines"`
					FirstLine  int    `json:"first_line"`
					LastLine   int    `json:"last_line"`
					Content    string `json:"content"`
				}{a.Path, sum, len(lines), start, end, b.String()}
			})
		},
	})
	type writeArgs struct {
		Path           string `json:"path"`
		Content        string `json:"content"`
		ExpectedSHA256 string `json:"expected_sha256"`
	}
	tools = append(tools, Tool{
		Spec: Spec{Name: "workspace.write", Description: "Create a new file, or replace an existing file whose current sha256 you pass (from workspace.read). Rejects stale content.", Arguments: `{"path":"dir/file.go","content":"...","expected_sha256":""}; expected_sha256 empty only for new files`},
		Validate: func(raw json.RawMessage) error {
			var a writeArgs
			if err := DecodeObject(raw, &a, MaxArgumentBytes); err != nil {
				return err
			}
			if !utf8.ValidString(a.Content) || strings.ContainsRune(a.Content, 0) {
				return fmt.Errorf("content must be UTF-8 text")
			}
			return validRelativePath(a.Path)
		},
		Execute: func(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
			var a writeArgs
			_ = json.Unmarshal(raw, &a)
			target, err := resolveForWrite(root, a.Path)
			if err != nil {
				return nil, err
			}
			current, readErr := os.ReadFile(target)
			exists := readErr == nil
			switch {
			case exists && a.ExpectedSHA256 == "":
				return nil, fmt.Errorf("file exists; read it and pass expected_sha256")
			case exists && digest(current) != a.ExpectedSHA256:
				return nil, fmt.Errorf("file changed since it was read (sha256 mismatch)")
			case !exists && a.ExpectedSHA256 != "":
				return nil, fmt.Errorf("file no longer exists")
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if err := writeAtomic(target, []byte(a.Content), !exists); err != nil {
				return nil, err
			}
			return json.Marshal(struct {
				Path    string `json:"path"`
				Created bool   `json:"created"`
				Bytes   int    `json:"bytes"`
				SHA256  string `json:"sha256"`
			}{a.Path, !exists, len(a.Content), digest([]byte(a.Content))})
		},
	})
	type editArgs struct {
		Path           string `json:"path"`
		Old            string `json:"old"`
		New            string `json:"new"`
		ExpectedSHA256 string `json:"expected_sha256"`
	}
	tools = append(tools, Tool{
		Spec: Spec{Name: "workspace.edit", Description: "Replace exactly one occurrence of old text with new text in an existing file. Pass the sha256 from workspace.read.", Arguments: `{"path":"dir/file.go","old":"exact existing text","new":"replacement","expected_sha256":"..."}`},
		Validate: func(raw json.RawMessage) error {
			var a editArgs
			if err := DecodeObject(raw, &a, MaxArgumentBytes); err != nil {
				return err
			}
			if a.Old == "" || a.Old == a.New || len(a.ExpectedSHA256) != 64 || !utf8.ValidString(a.New) || strings.ContainsRune(a.New, 0) {
				return fmt.Errorf("old must be non-empty and differ from new; expected_sha256 is required")
			}
			return validRelativePath(a.Path)
		},
		Execute: func(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
			var a editArgs
			_ = json.Unmarshal(raw, &a)
			target, data, err := readText(root, a.Path)
			if err != nil {
				return nil, err
			}
			if digest(data) != a.ExpectedSHA256 {
				return nil, fmt.Errorf("file changed since it was read (sha256 mismatch)")
			}
			text := string(data)
			old := a.Old
			if !strings.Contains(text, old) && strings.Contains(text, "\r\n") {
				// Models usually send LF; match CRLF files transparently.
				old = strings.ReplaceAll(old, "\n", "\r\n")
				a.New = strings.ReplaceAll(a.New, "\n", "\r\n")
			}
			switch n := strings.Count(text, old); n {
			case 0:
				return nil, fmt.Errorf("old text not found")
			case 1:
			default:
				return nil, fmt.Errorf("old text occurs %d times; include more context", n)
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			updated := strings.Replace(text, old, a.New, 1)
			if err := writeAtomic(target, []byte(updated), false); err != nil {
				return nil, err
			}
			line := strings.Count(text[:strings.Index(text, old)], "\n") + 1
			return json.Marshal(struct {
				Path   string `json:"path"`
				Line   int    `json:"line"`
				SHA256 string `json:"sha256"`
			}{a.Path, line, digest([]byte(updated))})
		},
	})
	if run != nil {
		type runArgs struct {
			Command string `json:"command"`
		}
		tools = append(tools, Tool{
			Spec: Spec{Name: "process.run", Description: "Run one command line in the workspace directory with the user's permissions and a scrubbed allowlisted environment (for example: go test ./...). This is process hardening, not a filesystem/network sandbox. Output is truncated to the last 10 KiB.", Arguments: `{"command":"go test ./..."}`},
			Validate: func(raw json.RawMessage) error {
				var a runArgs
				if err := DecodeObject(raw, &a, 4096); err != nil {
					return err
				}
				if strings.TrimSpace(a.Command) == "" || len(a.Command) > 2048 || strings.ContainsAny(a.Command, "\x00\r\n") {
					return fmt.Errorf("one non-empty command line required")
				}
				return nil
			},
			Execute: func(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
				var a runArgs
				_ = json.Unmarshal(raw, &a)
				out, err := run(ctx, a.Command, root)
				if cerr := ctx.Err(); cerr != nil {
					return nil, cerr
				}
				status := "succeeded"
				if err != nil {
					status = "failed: " + err.Error()
				}
				out = strings.ToValidUTF8(out, "�")
				return fitJSON(maxToolOutput-1024, func(budget int) interface{} {
					return struct {
						Command string `json:"command"`
						Status  string `json:"status"`
						Output  string `json:"output"`
					}{a.Command, status, tail(out, budget)}
				})
			},
		})
	}
	return tools
}
