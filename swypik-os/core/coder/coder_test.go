package coder

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestRunCapturesOutputAndExitStatus(t *testing.T) {
	dir := t.TempDir()
	out, err := Run(context.Background(), "echo SwypikOS Native Execution", dir)
	if runtime.GOOS != "windows" {
		if err == nil || !strings.Contains(err.Error(), "requires Windows") {
			t.Fatal("command execution must be unavailable off Windows")
		}
		return
	}
	if err != nil || strings.TrimSpace(out) != "SwypikOS Native Execution" {
		t.Fatalf("%q %v", out, err)
	}
	if _, err := Run(context.Background(), "exit /b 3", dir); err == nil || !strings.Contains(err.Error(), "code 3") {
		t.Fatalf("exit status hidden: %v", err)
	}
	for _, bad := range []string{"", "a\nb", "a\x00"} {
		if _, err := Run(context.Background(), bad, dir); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestCanceledCommandDoesNotRun(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out, err := Run(ctx, "echo SHOULD_NOT_RUN", t.TempDir())
	if err == nil || strings.Contains(out, "SHOULD_NOT_RUN") {
		t.Fatalf("canceled command ran: %q %v", out, err)
	}
}

func TestRunningCommandDeadline(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows job-object lifecycle test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	out, err := Run(ctx, "for /L %i in (1,1,100000000) do @echo working", t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "deadline exceeded") {
		t.Fatalf("deadline not reported: %v", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("command did not stop promptly")
	}
	if len(out) > maxCommandOutput+200 {
		t.Fatal("command output exceeds bound")
	}
}

func TestOutputIsBoundedWhileAllWritesAreConsumed(t *testing.T) {
	out := &commandOutput{}
	chunk := []byte(strings.Repeat("x", 4096))
	for i := 0; i < 1000; i++ {
		if n, err := out.Write(chunk); err != nil || n != len(chunk) {
			t.Fatalf("write: %d %v", n, err)
		}
	}
	if out.buffer.Len() != maxCommandOutput || !strings.HasSuffix(out.String(), "[Output truncated at 256 KiB]") {
		t.Fatal("output was not bounded and labeled")
	}
}
