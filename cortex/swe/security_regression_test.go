package swe

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRunGoFailsClosed(t *testing.T) {
	res, err := RunGo(context.Background(), map[string]string{"main.go": "package main; func main() {}"})
	if !errors.Is(err, ErrIsolationRequired) || res.Success {
		t.Fatalf("unexpected result: %+v %v", res, err)
	}
}

func TestCancelledRunDoesNotStart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := RunGo(ctx, nil); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := RunTrustedGo(ctx, nil); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestSourceFileLimits(t *testing.T) {
	opts, _ := (TrustedGoOptions{MaxFiles: 1, MaxSourceBytes: 20}).defaults()
	for _, files := range []map[string]string{
		nil, {"../x.go": "x"}, {"/x.go": "x"}, {"go.mod": "module evil"},
		{"a/../b.go": "x"}, {"C:\\x.go": "x"}, {"a.go": strings.Repeat("x", 21)},
		{"a.go": "x", "b.go": "x"},
		{"sub//a.go": "x"}, {"sub/./a.go": "x"}, {"sub\\a.go": "x"},
	} {
		if err := validateSourceFiles(files, opts); err == nil {
			t.Fatalf("accepted %v", files)
		}
	}
	if err := validateSourceFiles(map[string]string{"sub/a.go": "package x"}, opts); err != nil {
		t.Fatal(err)
	}
	if _, err := (TrustedGoOptions{Timeout: -1}).defaults(); err == nil {
		t.Fatal("negative timeout accepted")
	}
}

func TestOutputBudgetIsShared(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &limitedCapture{remaining: 4, cancel: cancel}
	_, _ = (captureWriter{c, false}).Write([]byte("abc"))
	_, _ = (captureWriter{c, true}).Write([]byte("def"))
	if c.out.String() != "abc" || c.err.String() != "d" || !c.exceeded || ctx.Err() == nil {
		t.Fatal("unbounded output")
	}
}

func TestTrustedEnvironmentOmitsApplicationSecrets(t *testing.T) {
	t.Setenv("ILARIA_TEST_SYNTHETIC_SECRET", "not-a-real-secret")
	env, err := trustedEnvironment(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(env, "\n"), "ILARIA_TEST_SYNTHETIC_SECRET") {
		t.Fatal("environment leaked")
	}
}

func TestTrustedExecutionAndBoundedOutput(t *testing.T) {
	if !hostExecutionSupported {
		t.Skip("trusted executor unavailable on this platform")
	}
	files := map[string]string{
		"x.go":      "package sandbox\nfunc X() int { return 2 }\n",
		"x_test.go": "package sandbox\nimport (\"testing\"; \"os\")\nfunc TestX(t *testing.T) { if X()!=2 {t.Fatal(\"wrong\")}; if os.Getenv(\"ILARIA_TEST_SYNTHETIC_SECRET\")!=\"\" {t.Fatal(\"leak\")} }\n",
	}
	t.Setenv("ILARIA_TEST_SYNTHETIC_SECRET", "synthetic")
	res, err := RunTrustedGo(context.Background(), files)
	if err != nil || !res.Success || res.TestsPassed != 1 {
		t.Fatalf("%+v %v", res, err)
	}
	files["x_test.go"] = "package sandbox\nimport (\"testing\"; \"fmt\"; \"strings\")\nfunc TestX(t *testing.T) { fmt.Print(strings.Repeat(\"x\", 100000)) }\n"
	res, err = RunTrustedGoWithOptions(context.Background(), files, TrustedGoOptions{MaxOutputBytes: 1024})
	if err != nil || res.Success || len(res.Stdout)+len(res.Stderr) > 1200 || !strings.Contains(res.Stderr, "output limit") {
		t.Fatalf("output cap failed: stdout=%d stderr=%q err=%v", len(res.Stdout), res.Stderr, err)
	}
}

func TestProcessGroupCancellation(t *testing.T) {
	if !hostExecutionSupported {
		t.Skip("process groups unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	marker := filepath.Join(t.TempDir(), "child-finished")
	// Harmless child would write only this test's own temporary marker.
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", `(sleep 1; echo alive > "$1") & wait`, "sh", marker)
	cmd.WaitDelay = 100 * time.Millisecond
	configureProcessGroup(cmd)
	_ = cmd.Run()
	cleanupProcessGroup(cmd)
	time.Sleep(1100 * time.Millisecond)
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("descendant survived cancellation", err)
	}
}
