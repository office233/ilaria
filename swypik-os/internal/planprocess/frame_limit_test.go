package planprocess

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type exactPayload struct {
	P string `json:"p"`
}

func payloadForJSONBytes(t *testing.T, size int) exactPayload {
	t.Helper()
	if size < 8 {
		t.Fatalf("fixture JSON size %d is below object overhead", size)
	}
	value := exactPayload{P: strings.Repeat("x", size-8)}
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != size {
		t.Fatalf("fixture JSON bytes=%d want=%d", len(raw), size)
	}
	return value
}

func startFrameFixture(t *testing.T, mode string, limit int, extra ...string) (*Process, context.Context) {
	t.Helper()
	config := helperConfig(t, mode)
	config.JSONLMaxBytes = limit
	config.Args = append(config.Args, extra...)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	p, err := Start(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p, ctx
}

func TestJSONLFramePayloadLimitLFAndCRLF(t *testing.T) {
	const limit = 257
	for _, terminator := range []string{"lf", "crlf"} {
		t.Run(terminator+"_exact", func(t *testing.T) {
			p, ctx := startFrameFixture(t, "frame_stdout", limit, strconv.Itoa(limit), terminator)
			line, err := p.ReadLine(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if len(line) != limit || line[0] != '"' || line[len(line)-1] != '"' || strings.ContainsRune(string(line), '') {
				t.Fatalf("payload framing mismatch: len=%d first=%q last=%q", len(line), line[0], line[len(line)-1])
			}
			if cap(line) > limit+1 {
				t.Fatalf("frame buffer capacity escaped bound: cap=%d limit=%d", cap(line), limit)
			}
			if err := p.Wait(ctx); err != nil {
				t.Fatal(err)
			}
		})
		t.Run(terminator+"_plus_one", func(t *testing.T) {
			p, ctx := startFrameFixture(t, "frame_stdout", limit, strconv.Itoa(limit+1), terminator)
			if _, err := p.ReadLine(ctx); !errors.Is(err, ErrLineLimit) {
				t.Fatalf("limit+1 output error=%v", err)
			}
			if err := p.Wait(ctx); !errors.Is(err, ErrLineLimit) {
				t.Fatalf("limit+1 output was not retained/reaped: %v", err)
			}
		})
	}
}

func TestJSONLRejectsUnterminatedStdoutFrame(t *testing.T) {
	p, ctx := startFrameFixture(t, "frame_stdout", 128, "64", "none")
	if _, err := p.ReadLine(ctx); !errors.Is(err, ErrJSONLFrame) {
		t.Fatalf("unterminated frame error=%v", err)
	}
	if err := p.Wait(ctx); !errors.Is(err, ErrJSONLFrame) {
		t.Fatalf("unterminated frame was not retained by Wait: %v", err)
	}
}

func TestJSONLCRLFSplitAtReaderBufferBoundaryDoesNotWidenPayload(t *testing.T) {
	// readStdout uses a 64 KiB bufio.Reader. With this payload size the CR is
	// the final byte of one internal buffer and LF arrives in the next read.
	const limit = (64 << 10) - 1
	p, ctx := startFrameFixture(t, "frame_stdout", limit, strconv.Itoa(limit), "crlf")
	line, err := p.ReadLine(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(line) != limit || cap(line) > limit+1 {
		t.Fatalf("split CRLF payload len=%d cap=%d want=%d", len(line), cap(line), limit)
	}
	if err := p.Wait(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestJSONLDefaultTwoMiBRejectsAndExplicitNineMiBAcceptsBothDirections(t *testing.T) {
	t.Run("default_stdout_rejects", func(t *testing.T) {
		p, ctx := startFrameFixture(t, "frame_stdout", 0, strconv.Itoa(MaxLineBytes+1), "lf")
		if _, err := p.ReadLine(ctx); !errors.Is(err, ErrLineLimit) {
			t.Fatalf("default stdout accepted >2 MiB: %v", err)
		}
		if err := p.Wait(ctx); !errors.Is(err, ErrLineLimit) {
			t.Fatalf("default stdout overflow not retained: %v", err)
		}
	})

	t.Run("default_stdin_rejects", func(t *testing.T) {
		p, ctx := startFrameFixture(t, "frame_echo", 0)
		payload := payloadForJSONBytes(t, MaxLineBytes+1)
		if err := p.SendJSON(ctx, payload); !errors.Is(err, ErrLineLimit) {
			t.Fatalf("default stdin accepted >2 MiB: %v", err)
		}
		if err := p.Wait(ctx); !errors.Is(err, ErrLineLimit) {
			t.Fatalf("default stdin overflow did not terminate/reap child: %v", err)
		}
	})

	t.Run("nine_mib_stdout_exact", func(t *testing.T) {
		p, ctx := startFrameFixture(t, "frame_stdout", MaxJSONLBytes, strconv.Itoa(MaxJSONLBytes), "crlf")
		line, err := p.ReadLine(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(line) != MaxJSONLBytes || cap(line) > MaxJSONLBytes+1 {
			t.Fatalf("9 MiB stdout payload len=%d cap=%d", len(line), cap(line))
		}
		if err := p.Wait(ctx); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("nine_mib_stdin_exact", func(t *testing.T) {
		p, ctx := startFrameFixture(t, "frame_echo", MaxJSONLBytes)
		payload := payloadForJSONBytes(t, MaxJSONLBytes)
		if err := p.SendJSON(ctx, payload); err != nil {
			t.Fatal(err)
		}
		line, err := p.ReadLine(ctx)
		if err != nil {
			t.Fatal(err)
		}
		want := fmt.Sprintf(`{"bytes":%d}`, MaxJSONLBytes)
		if string(line) != want {
			t.Fatalf("9 MiB stdin observed=%s want=%s", line, want)
		}
		if err := p.Wait(ctx); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("nine_mib_stdout_plus_one_rejects", func(t *testing.T) {
		p, ctx := startFrameFixture(t, "frame_stdout", MaxJSONLBytes, strconv.Itoa(MaxJSONLBytes+1), "lf")
		if _, err := p.ReadLine(ctx); !errors.Is(err, ErrLineLimit) {
			t.Fatalf("9 MiB+1 stdout accepted: %v", err)
		}
		if err := p.Wait(ctx); !errors.Is(err, ErrLineLimit) {
			t.Fatalf("9 MiB+1 stdout overflow not retained: %v", err)
		}
	})

	t.Run("nine_mib_stdin_plus_one_rejects", func(t *testing.T) {
		p, ctx := startFrameFixture(t, "frame_echo", MaxJSONLBytes)
		payload := payloadForJSONBytes(t, MaxJSONLBytes+1)
		if err := p.SendJSON(ctx, payload); !errors.Is(err, ErrLineLimit) {
			t.Fatalf("9 MiB+1 stdin accepted: %v", err)
		}
		if err := p.Wait(ctx); !errors.Is(err, ErrLineLimit) {
			t.Fatalf("9 MiB+1 stdin overflow did not terminate/reap child: %v", err)
		}
	})
}

func TestInvalidJSONLLimitRejectedBeforeChildLaunch(t *testing.T) {
	for _, limit := range []int{-1, MaxJSONLBytes + 1} {
		t.Run(strconv.Itoa(limit), func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "launched.marker")
			config := helperConfig(t, "touch_marker")
			config.Args = append(config.Args, marker)
			config.JSONLMaxBytes = limit
			p, err := Start(context.Background(), config)
			if p != nil {
				_ = p.Close()
				t.Fatal("invalid JSONL limit returned a process")
			}
			if !errors.Is(err, ErrJSONLLimit) {
				t.Fatalf("invalid limit error=%v", err)
			}
			if _, statErr := os.Stat(marker); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("child launched before JSONL limit validation: stat=%v", statErr)
			}
		})
	}
}

func TestLargeBlockedWriteCancellationTerminatesAndReapsChild(t *testing.T) {
	config := helperConfig(t, "stall")
	config.JSONLMaxBytes = MaxJSONLBytes
	lifetime, cancelLifetime := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelLifetime()
	p, err := Start(lifetime, config)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	awaitReady(t, p, lifetime)

	payload := payloadForJSONBytes(t, MaxJSONLBytes)
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	started := time.Now()
	err = p.SendJSON(ctx, payload)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocked large write error=%v", err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("blocked large write cancellation took %s", elapsed)
	}
	if err := p.Wait(lifetime); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cancelled large write did not reap owned child: %v", err)
	}
	if p.cmd.ProcessState == nil {
		t.Fatal("cancelled child has no reaped ProcessState")
	}
}

func TestOutputOverflowReapsOwnedChildWithoutTerminatingUnrelatedProcess(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	unrelated := exec.Command(executable, "-test.run=^TestPlanProcessHelper$", "--", "planprocess-helper", "stall")
	if err := unrelated.Start(); err != nil {
		t.Fatal(err)
	}
	unrelatedDone := make(chan error, 1)
	go func() { unrelatedDone <- unrelated.Wait() }()
	t.Cleanup(func() {
		if unrelated.ProcessState == nil {
			_ = unrelated.Process.Kill()
			<-unrelatedDone
		}
	})

	p, ctx := startFrameFixture(t, "frame_stdout", 128, "129", "lf")
	if _, err := p.ReadLine(ctx); !errors.Is(err, ErrLineLimit) {
		t.Fatalf("overflow read error=%v", err)
	}
	if err := p.Wait(ctx); !errors.Is(err, ErrLineLimit) {
		t.Fatalf("overflow child was not reaped: %v", err)
	}
	if p.cmd.ProcessState == nil {
		t.Fatal("overflow child has no reaped ProcessState")
	}

	select {
	case err := <-unrelatedDone:
		t.Fatalf("output overflow terminated unrelated process: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	if err := unrelated.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := <-unrelatedDone; err == nil {
		t.Fatal("fixture cleanup expected killed unrelated process exit")
	}
}
