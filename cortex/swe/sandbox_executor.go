package swe

// sandbox_executor.go — runs untrusted Go source through the REAL toolchain.
//
// RunGo writes the given files into a fresh temporary module, then executes
// `go vet ./...` and `go test ./... -v -count=1` with the caller's context
// (deadline = kill switch). Everything reported comes from parsing the actual
// compiler / vet / test output; nothing is simulated. There is deliberately no
// "auto-repair": deciding how to fix code is the brain's job, the sandbox only
// tells the truth about whether the code builds and the tests pass.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	// [vet.exe: ][./ or .\]file.go:LINE[:COL]: message  (nested dirs allowed)
	reDiag = regexp.MustCompile(`^(?:[\w.]+: )?(?:\.[\\/])?([\w./\\-]+\.go):(\d+)(?::(\d+))?: (.*)$`)
	rePass = regexp.MustCompile(`^\s*--- PASS: (\S+)`)
	reFail = regexp.MustCompile(`^\s*--- FAIL: (\S+)`)
)

// RunGo vets, builds and tests the given files inside a throwaway module named
// "sandbox". Keys are paths relative to the module root; they may not escape it.
func RunGo(ctx context.Context, files map[string]string) (ExecutionResult, error) {
	start := time.Now()
	dir, err := os.MkdirTemp("", "nexus-sandbox-")
	if err != nil {
		return ExecutionResult{}, fmt.Errorf("sandbox: temp dir: %w", err)
	}
	defer os.RemoveAll(dir)

	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module sandbox\n\ngo 1.26\n"), 0o644); err != nil {
		return ExecutionResult{}, fmt.Errorf("sandbox: write go.mod: %w", err)
	}
	for rel, content := range files {
		clean := filepath.Clean(rel)
		if filepath.IsAbs(clean) || clean == "." || strings.HasPrefix(clean, "..") {
			return ExecutionResult{}, fmt.Errorf("sandbox: path %q escapes the sandbox", rel)
		}
		full := filepath.Join(dir, clean)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return ExecutionResult{}, fmt.Errorf("sandbox: mkdir for %s: %w", rel, err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			return ExecutionResult{}, fmt.Errorf("sandbox: write %s: %w", rel, err)
		}
	}

	res := ExecutionResult{}
	var stdout, stderr bytes.Buffer

	// Stage 1: vet (also compiles). Stop here on failure — tests cannot run.
	code, timedOut := runGoCmd(ctx, dir, &stdout, &stderr, "vet", "./...")
	res.Diagnostics = append(res.Diagnostics, parseDiagnostics(stderr.String(), DiagVet)...)
	if code != 0 || timedOut {
		return finish(res, code, timedOut, stdout, stderr, start), nil
	}

	// Stage 2: test.
	stdout.Reset()
	stderr.Reset()
	code, timedOut = runGoCmd(ctx, dir, &stdout, &stderr, "test", "./...", "-v", "-count=1")
	// Only stderr carries toolchain diagnostics here; stdout is test logging
	// ("x_test.go:7: expected 2" from t.Fatal looks like a diagnostic but is not).
	res.Diagnostics = append(res.Diagnostics, parseDiagnostics(stderr.String(), DiagTypeMismatch)...)
	for _, line := range strings.Split(stdout.String(), "\n") {
		if rePass.MatchString(line) {
			res.TestsPassed++
		} else if m := reFail.FindStringSubmatch(line); m != nil {
			res.TestsFailed++
			res.FailedTestNames = append(res.FailedTestNames, m[1])
			res.Diagnostics = append(res.Diagnostics, DiagnosticError{
				Kind:    DiagTestFailure,
				Message: "test failed: " + m[1],
			})
		}
	}
	res.TestsTotal = res.TestsPassed + res.TestsFailed
	return finish(res, code, timedOut, stdout, stderr, start), nil
}

func finish(res ExecutionResult, code int, timedOut bool, stdout, stderr bytes.Buffer, start time.Time) ExecutionResult {
	res.ExitCode = code
	res.TimedOut = timedOut
	res.Stdout = stdout.String()
	res.Stderr = stderr.String()
	res.ExecutionTimeMs = time.Since(start).Milliseconds()
	res.Success = code == 0 && !timedOut && len(res.Diagnostics) == 0
	return res
}

// runGoCmd executes `go <args>` in dir. It returns the exit code and whether
// the context deadline killed the process.
func runGoCmd(ctx context.Context, dir string, stdout, stderr *bytes.Buffer, args ...string) (int, bool) {
	cmd := exec.CommandContext(ctx, "go", args...)
	cmd.Dir = dir
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Env = append(os.Environ(), "GOWORK=off", "GOFLAGS=-mod=mod", "GO111MODULE=on")
	err := cmd.Run()
	if ctx.Err() != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return -1, true
	}
	if err == nil {
		return 0, false
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), false
	}
	stderr.WriteString("\nsandbox: " + err.Error() + "\n")
	return -1, false
}

// parseDiagnostics turns "file.go:line:col: message" lines into structured
// diagnostics. The kind is refined from the message text; fallback is the
// stage's default kind.
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
		case strings.HasPrefix(msg, "undefined:") || strings.Contains(msg, "undefined:"):
			kind = DiagUndefinedSymbol
		case strings.Contains(msg, "cannot use") || strings.Contains(msg, "mismatched") ||
			strings.Contains(msg, "cannot convert") || strings.Contains(msg, "type "):
			kind = DiagTypeMismatch
		}
		diags = append(diags, DiagnosticError{
			Kind:     kind,
			FilePath: filepath.ToSlash(m[1]),
			Line:     ln,
			Column:   col,
			Message:  msg,
		})
	}
	return diags
}
