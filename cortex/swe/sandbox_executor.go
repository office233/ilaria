package swe

// RunGo deliberately fails closed until an OS-isolated backend is available.
// RunTrustedGo is an explicitly unsafe host executor for operator-trusted code:
// neither a temporary directory, environment allowlist nor a timeout isolates Go.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrIsolationRequired = errors.New("Go execution disabled: no OS-isolated executor configured; RunTrustedGo grants host permissions and must be explicitly selected by the operator")
	reDiag               = regexp.MustCompile(`^(?:[\w.]+: )?(?:\.[\\/])?([\w./\\-]+\.go):(\d+)(?::(\d+))?: (.*)$`)
	rePass               = regexp.MustCompile(`^\s*--- PASS: (\S+)`)
	reFail               = regexp.MustCompile(`^\s*--- FAIL: (\S+)`)
	reGoVersion          = regexp.MustCompile(`^go(\d+\.\d+)`)
)

// RunGo never silently falls back to unrestricted execution of untrusted code.
func RunGo(ctx context.Context, files map[string]string) (ExecutionResult, error) {
	if err := ctx.Err(); err != nil {
		return ExecutionResult{}, err
	}
	return ExecutionResult{}, ErrIsolationRequired
}

// TrustedGoOptions are resource ceilings, NOT an OS security boundary.
// Zero values select bounded defaults; negative values are errors.
type TrustedGoOptions struct {
	Timeout        time.Duration
	MaxFiles       int
	MaxSourceBytes int
	MaxOutputBytes int // stdout + stderr together, per toolchain stage
}

func (o TrustedGoOptions) defaults() (TrustedGoOptions, error) {
	if o.Timeout < 0 || o.MaxFiles < 0 || o.MaxSourceBytes < 0 || o.MaxOutputBytes < 0 {
		return o, errors.New("trusted Go execution limits must be non-negative")
	}
	if o.Timeout == 0 {
		o.Timeout = 60 * time.Second
	}
	if o.MaxFiles == 0 {
		o.MaxFiles = 32
	}
	if o.MaxSourceBytes == 0 {
		o.MaxSourceBytes = 1 << 20
	}
	if o.MaxOutputBytes == 0 {
		o.MaxOutputBytes = 128 << 10
	}
	return o, nil
}

// RunTrustedGo runs source with the current user's filesystem/network permissions.
// Never expose it to arbitrary remote input or enable it through model arguments.
// Non-Unix hosts fail closed because process-group cleanup is not implemented there.
func RunTrustedGo(ctx context.Context, files map[string]string) (ExecutionResult, error) {
	return RunTrustedGoWithOptions(ctx, files, TrustedGoOptions{})
}

func RunTrustedGoWithOptions(parent context.Context, files map[string]string, opts TrustedGoOptions) (ExecutionResult, error) {
	start := time.Now()
	if err := parent.Err(); err != nil {
		return ExecutionResult{}, err
	}
	if !hostExecutionSupported {
		return ExecutionResult{}, errors.New("trusted host execution unsupported on this platform; use an isolated external executor")
	}
	opts, err := opts.defaults()
	if err != nil {
		return ExecutionResult{}, err
	}
	if err := validateSourceFiles(files, opts); err != nil {
		return ExecutionResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, opts.Timeout)
	defer cancel()
	dir, err := os.MkdirTemp("", "ilaria-trusted-go-")
	if err != nil {
		return ExecutionResult{}, err
	}
	defer os.RemoveAll(dir)
	v := reGoVersion.FindStringSubmatch(runtime.Version())
	if v == nil {
		return ExecutionResult{}, fmt.Errorf("unsupported Go runtime version %q", runtime.Version())
	}
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module sandbox\n\ngo "+v[1]+"\n"), 0600); err != nil {
		return ExecutionResult{}, err
	}
	for rel, content := range files {
		full := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
			return ExecutionResult{}, err
		}
		if err := os.WriteFile(full, []byte(content), 0600); err != nil {
			return ExecutionResult{}, err
		}
	}
	env, err := trustedEnvironment(dir)
	if err != nil {
		return ExecutionResult{}, err
	}
	res := ExecutionResult{}
	finish := func(code int, out, stderr string, exceeded bool) (ExecutionResult, error) {
		res.ExitCode, res.Stdout, res.Stderr = code, out, stderr
		res.TimedOut = errors.Is(ctx.Err(), context.DeadlineExceeded)
		res.ExecutionTimeMs = time.Since(start).Milliseconds()
		if exceeded {
			res.Stderr += "\noutput limit exceeded; execution cancelled\n"
			res.ExitCode = -1
		}
		res.Success = res.ExitCode == 0 && ctx.Err() == nil && !exceeded && len(res.Diagnostics) == 0
		return res, nil
	}
	code, out, stderr, exceeded := runTrustedGoCmd(ctx, dir, env, opts.MaxOutputBytes, "vet", "./...")
	res.Diagnostics = append(res.Diagnostics, parseDiagnostics(stderr, DiagVet)...)
	if code != 0 || ctx.Err() != nil || exceeded {
		return finish(code, out, stderr, exceeded)
	}
	code, out, stderr, exceeded = runTrustedGoCmd(ctx, dir, env, opts.MaxOutputBytes, "test", "./...", "-v", "-count=1")
	res.Diagnostics = append(res.Diagnostics, parseDiagnostics(stderr, DiagTypeMismatch)...)
	for _, line := range strings.Split(out, "\n") {
		if rePass.MatchString(line) {
			res.TestsPassed++
		} else if m := reFail.FindStringSubmatch(line); m != nil {
			res.TestsFailed++
			res.FailedTestNames = append(res.FailedTestNames, m[1])
			res.Diagnostics = append(res.Diagnostics, DiagnosticError{Kind: DiagTestFailure, Message: "test failed: " + m[1]})
		}
	}
	res.TestsTotal = res.TestsPassed + res.TestsFailed
	return finish(code, out, stderr, exceeded)
}

func validateSourceFiles(files map[string]string, opts TrustedGoOptions) error {
	if len(files) == 0 || len(files) > opts.MaxFiles {
		return errors.New("invalid source file count")
	}
	total := 0
	for rel, content := range files {
		// Source keys use portable forward slashes on every host.
		clean := path.Clean(rel)
		if !filepath.IsLocal(rel) || clean != rel || filepath.Ext(rel) != ".go" || strings.ContainsAny(rel, "\\:\x00") {
			return fmt.Errorf("invalid relative Go source path %q", rel)
		}
		if len(content) > opts.MaxSourceBytes-total {
			return errors.New("source byte limit exceeded")
		}
		total += len(content)
	}
	return nil
}

// No application environment is inherited. Build cache is separate from source.
// This reduces accidental leakage, but trusted code can still read host files.
func trustedEnvironment(dir string) ([]string, error) {
	cacheBase, err := os.UserCacheDir()
	if err != nil {
		return nil, err
	}
	cache := filepath.Join(cacheBase, "ilaria-trusted-go-build")
	if err := os.MkdirAll(cache, 0700); err != nil {
		return nil, err
	}
	tmp := filepath.Join(dir, ".tmp")
	if err := os.MkdirAll(tmp, 0700); err != nil {
		return nil, err
	}
	return []string{
		"PATH=" + filepath.Join(runtime.GOROOT(), "bin") + string(os.PathListSeparator) + "/usr/bin:/bin",
		"GOROOT=" + runtime.GOROOT(), "HOME=" + dir, "TMPDIR=" + tmp,
		"GOCACHE=" + cache, "GOMODCACHE=" + filepath.Join(dir, ".modules"),
		"GOWORK=off", "GOENV=off", "GOFLAGS=-mod=readonly", "GO111MODULE=on",
		"GOPROXY=off", "GOSUMDB=off", "GOTOOLCHAIN=local", "CGO_ENABLED=0",
	}, nil
}

type limitedCapture struct {
	mu        sync.Mutex
	out, err  bytes.Buffer
	remaining int
	exceeded  bool
	cancel    context.CancelFunc
}
type captureWriter struct {
	capture *limitedCapture
	stderr  bool
}

func (w captureWriter) Write(p []byte) (int, error) {
	c := w.capture
	c.mu.Lock()
	defer c.mu.Unlock()
	n := len(p)
	if n > c.remaining {
		n = c.remaining
		c.exceeded = true
		c.cancel()
	}
	if w.stderr {
		_, _ = c.err.Write(p[:n])
	} else {
		_, _ = c.out.Write(p[:n])
	}
	c.remaining -= n
	if n != len(p) {
		return n, io.ErrShortWrite
	}
	return n, nil
}

func runTrustedGoCmd(parent context.Context, dir string, env []string, limit int, args ...string) (int, string, string, bool) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	capture := &limitedCapture{remaining: limit, cancel: cancel}
	cmd := exec.CommandContext(ctx, filepath.Join(runtime.GOROOT(), "bin", "go"), args...)
	cmd.Dir, cmd.Env = dir, env
	cmd.Stdout, cmd.Stderr = captureWriter{capture, false}, captureWriter{capture, true}
	cmd.WaitDelay = 2 * time.Second
	configureProcessGroup(cmd)
	err := cmd.Run()
	cleanupProcessGroup(cmd)
	code := 0
	if err != nil {
		code = -1
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		}
	}
	stderr := capture.err.String()
	if err != nil && stderr == "" {
		stderr = "trusted Go execution: " + err.Error()
	}
	return code, capture.out.String(), stderr, capture.exceeded
}

func parseDiagnostics(out string, fallback DiagnosticKind) []DiagnosticError {
	var diags []DiagnosticError
	for _, line := range strings.Split(out, "\n") {
		m := reDiag.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		ln, _ := strconv.Atoi(m[2])
		col, _ := strconv.Atoi(m[3])
		msg := m[4]
		kind := fallback
		switch {
		case strings.Contains(msg, "syntax error"):
			kind = DiagSyntaxError
		case strings.Contains(msg, "undefined:"):
			kind = DiagUndefinedSymbol
		case strings.Contains(msg, "cannot use") || strings.Contains(msg, "mismatched") || strings.Contains(msg, "cannot convert") || strings.Contains(msg, "type "):
			kind = DiagTypeMismatch
		}
		diags = append(diags, DiagnosticError{Kind: kind, FilePath: filepath.ToSlash(m[1]), Line: ln, Column: col, Message: msg})
	}
	return diags
}
