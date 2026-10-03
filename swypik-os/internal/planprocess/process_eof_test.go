package planprocess

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"
)

func awaitStdoutClosed(t *testing.T, p *Process, ctx context.Context) {
	t.Helper()
	select {
	case <-p.stdoutDone:
	case <-ctx.Done():
		t.Fatal("child did not close stdout:", ctx.Err())
	}
}

func TestStdoutEOFWaitsForPendingStderrAndRemainsCancellable(t *testing.T) {
	p, lifetime := helperProcess(t, "stdout_closed_stderr")
	awaitStdoutClosed(t, p, lifetime)
	select {
	case <-p.stderrDone:
		t.Fatal("fixture must keep stderr open until it receives input")
	default:
	}

	ctx, cancel := context.WithTimeout(lifetime, 50*time.Millisecond)
	defer cancel()
	if line, err := p.ReadLine(ctx); line != nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("stdout closed with stderr pending: line=%q err=%v, want deadline error", line, err)
	}
	if err := p.Wait(lifetime); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("pending-stderr cancellation not retained by Wait: %v", err)
	}
	if p.cmd.ProcessState == nil {
		t.Fatal("pending-stderr cancellation did not reap the owned child")
	}
}

func TestStdoutEOFIncludesFinalStderrValidation(t *testing.T) {
	for _, test := range []struct {
		name  string
		bytes int
		want  error
	}{
		{"empty", 0, io.EOF},
		{"exact_limit", MaxStderrBytes, io.EOF},
		{"overflow", MaxStderrBytes + 1, ErrStderrLimit},
	} {
		t.Run(test.name, func(t *testing.T) {
			p, ctx := helperProcess(t, "stdout_closed_stderr")
			awaitStdoutClosed(t, p, ctx)
			if err := p.SendJSON(ctx, map[string]int{"stderr_bytes": test.bytes}); err != nil {
				t.Fatal("release final stderr:", err)
			}
			if line, err := p.ReadLine(ctx); line != nil || err != test.want {
				t.Fatalf("terminal line=%q err=%v, want exact %v", line, err, test.want)
			}
			err := p.Wait(ctx)
			if test.want == io.EOF {
				if err != nil {
					t.Fatal("normal stderr drain failed:", err)
				}
			} else if !errors.Is(err, test.want) {
				t.Fatalf("stderr overflow not retained by Wait: %v", err)
			}
			p.mu.Lock()
			retained := len(p.stderrBytes)
			p.mu.Unlock()
			if want := min(test.bytes, MaxStderrBytes); retained != want {
				t.Fatalf("retained stderr=%d want=%d", retained, want)
			}
		})
	}
}

func TestStdoutFrameDoesNotWaitForStderrDrain(t *testing.T) {
	p, ctx := helperProcess(t, "frame_then_stdout_closed_stderr")
	awaitStdoutClosed(t, p, ctx)
	awaitReady(t, p, ctx)
	select {
	case <-p.stderrDone:
		t.Fatal("frame read must not require the pending stderr pipe to close")
	default:
	}
	if err := p.SendJSON(ctx, map[string]int{"stderr_bytes": 0}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.ReadLine(ctx); err != io.EOF {
		t.Fatalf("terminal read=%v, want exact io.EOF", err)
	}
	if err := p.Wait(ctx); err != nil {
		t.Fatal(err)
	}
}
