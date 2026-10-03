package planprocess

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The current test binary is the trusted helper. Arguments select its mode;
// no test-only environment exception is added to the production allowlist.
func TestPlanProcessHelper(t *testing.T) {
	mode := ""
	for i, arg := range os.Args {
		if arg == "planprocess-helper" && i+1 < len(os.Args) {
			mode = os.Args[i+1]
			break
		}
	}
	if mode == "" {
		return
	}
	switch mode {
	case "env":
		_ = json.NewEncoder(os.Stdout).Encode(os.Environ())
		os.Exit(0)
	case "burst":
		for i := 0; i < 3; i++ {
			fmt.Fprintf(os.Stdout, "{\"frame\":%d}\n", i)
		}
		os.Exit(0)
	case "fail":
		fmt.Fprintln(os.Stderr, "intentional fixture error")
		os.Exit(7)
	case "stdout_limit":
		fmt.Fprintln(os.Stdout, strings.Repeat("x", MaxLineBytes+1))
		os.Exit(0)
	case "frame_stdout":
		if len(os.Args) < 3 {
			os.Exit(12)
		}
		size, err := strconv.Atoi(os.Args[len(os.Args)-2])
		if err != nil || size < 2 {
			os.Exit(13)
		}
		terminator := os.Args[len(os.Args)-1]
		if _, err := os.Stdout.Write([]byte{'"'}); err != nil {
			os.Exit(14)
		}
		chunk := strings.Repeat("x", 64<<10)
		remaining := size - 2
		for remaining > 0 {
			part := min(remaining, len(chunk))
			if _, err := io.WriteString(os.Stdout, chunk[:part]); err != nil {
				os.Exit(15)
			}
			remaining -= part
		}
		if _, err := os.Stdout.Write([]byte{'"'}); err != nil {
			os.Exit(16)
		}
		switch terminator {
		case "lf":
			_, _ = io.WriteString(os.Stdout, "\n")
		case "crlf":
			_, _ = io.WriteString(os.Stdout, "\r\n")
		case "none":
		default:
			os.Exit(17)
		}
		os.Exit(0)
	case "frame_echo":
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64<<10), MaxJSONLBytes+2)
		if !scanner.Scan() {
			os.Exit(18)
		}
		fmt.Fprintf(os.Stdout, "{\"bytes\":%d}\n", len(scanner.Bytes()))
		os.Exit(0)
	case "touch_marker":
		if len(os.Args) == 0 || os.WriteFile(os.Args[len(os.Args)-1], []byte("launched"), 0600) != nil {
			os.Exit(19)
		}
		os.Exit(0)
	case "stderr_limit":
		fmt.Fprint(os.Stderr, strings.Repeat("e", MaxStderrBytes+1))
		os.Exit(0)
	case "stdout_closed_stderr", "frame_then_stdout_closed_stderr":
		if mode == "frame_then_stdout_closed_stderr" {
			fmt.Fprintln(os.Stdout, `{"ready":true}`)
		}
		if err := os.Stdout.Close(); err != nil {
			os.Exit(20)
		}
		var request struct {
			StderrBytes int `json:"stderr_bytes"`
		}
		if err := json.NewDecoder(os.Stdin).Decode(&request); err != nil ||
			request.StderrBytes < 0 || request.StderrBytes > MaxStderrBytes+1 {
			os.Exit(21)
		}
		if _, err := io.WriteString(os.Stderr, strings.Repeat("e", request.StderrBytes)); err != nil {
			os.Exit(22)
		}
		os.Exit(0)
	case "stall":
		fmt.Fprintln(os.Stdout, `{"ready":true}`)
		time.Sleep(30 * time.Second)
		os.Exit(0)
	case "memory_hog":
		fmt.Fprintln(os.Stdout, `{"ready":true}`)
		var retained [][]byte
		for {
			block := make([]byte, 8<<20)
			for i := 0; i < len(block); i += 4096 {
				block[i] = byte(i)
			}
			retained = append(retained, block)
			time.Sleep(time.Millisecond)
		}
	case "spawn_descendant":
		executable, err := os.Executable()
		if err != nil {
			os.Exit(10)
		}
		child := exec.Command(executable, "-test.run=^TestPlanProcessHelper$", "--", "planprocess-helper", "stall")
		if err := child.Start(); err != nil {
			os.Exit(11)
		}
		fmt.Fprintf(os.Stdout, "{\"child_pid\":%d}\n", child.Process.Pid)
		_ = child.Wait()
		os.Exit(0)
	case "echo":
		fmt.Fprintln(os.Stdout, `{"ready":true}`)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64<<10), MaxLineBytes+2)
		for scanner.Scan() {
			var request struct {
				SpinMS int  `json:"spin_ms"`
				Exit   bool `json:"exit"`
			}
			_ = json.Unmarshal(scanner.Bytes(), &request)
			until := time.Now().Add(time.Duration(request.SpinMS) * time.Millisecond)
			for time.Now().Before(until) {
			}
			fmt.Fprintln(os.Stdout, scanner.Text())
			if request.Exit {
				os.Exit(0)
			}
		}
		os.Exit(0)
	default:
		os.Exit(9)
	}
}

func helperConfig(t *testing.T, mode string) Config {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return Config{Executable: executable, Args: []string{"-test.run=^TestPlanProcessHelper$", "--", "planprocess-helper", mode},
		Directory: t.TempDir(), MaxThreads: 2, MemoryLimitBytes: 128 << 20, GCPercent: 100}
}

func helperProcess(t *testing.T, mode string) (*Process, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	p, err := Start(ctx, helperConfig(t, mode))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p, ctx
}

func awaitReady(t *testing.T, p *Process, ctx context.Context) {
	t.Helper()
	line, err := p.ReadLine(ctx)
	if err != nil || string(line) != `{"ready":true}` {
		t.Fatalf("ready=%s err=%v", line, err)
	}
}

func TestExplicitChildConfigurationAndScrubbedEnvironment(t *testing.T) {
	t.Setenv("PLANPROCESS_TEST_PRIVATE", "must-not-inherit")
	t.Setenv("PATH", "untrusted-parent-path")
	t.Setenv("GODEBUG", "http2debug=0")
	p, ctx := helperProcess(t, "env")
	line, err := p.ReadLine(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var env []string
	if err := json.Unmarshal(line, &env); err != nil {
		t.Fatal(err)
	}
	allowed := map[string]bool{"systemroot": true, "systemdrive": true, "temp": true, "tmp": true, "tmpdir": true,
		"gomaxprocs": true, "gomemlimit": true, "gogc": true,
		"omp_num_threads": true, "openblas_num_threads": true, "mkl_num_threads": true}
	actual := make(map[string]string)
	for _, item := range env {
		name, value, _ := strings.Cut(item, "=")
		name = strings.ToLower(name)
		if !allowed[name] {
			t.Fatalf("unexpected inherited environment name %q", name)
		}
		actual[name] = value
	}
	if actual["gomaxprocs"] != "2" || actual["omp_num_threads"] != "2" || actual["openblas_num_threads"] != "2" || actual["mkl_num_threads"] != "2" ||
		actual["gomemlimit"] != "134217728" || actual["gogc"] != "100" || strings.Contains(string(line), "must-not-inherit") {
		t.Fatalf("runtime limits/env scrub incorrect: %s", line)
	}
	if err := p.Wait(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestStartRejectsAmbientExecutableAndInvalidLimits(t *testing.T) {
	config := helperConfig(t, "echo")
	for name, mutate := range map[string]func(*Config){
		"relative_executable":  func(c *Config) { c.Executable = "go" },
		"relative_directory":   func(c *Config) { c.Directory = "." },
		"directory_executable": func(c *Config) { c.Executable = c.Directory },
		"zero_threads":         func(c *Config) { c.MaxThreads = 0 },
		"zero_memory":          func(c *Config) { c.MemoryLimitBytes = 0 },
		"negative_gc":          func(c *Config) { c.GCPercent = -1 },
	} {
		t.Run(name, func(t *testing.T) {
			invalid := config
			mutate(&invalid)
			if p, err := Start(context.Background(), invalid); err == nil {
				_ = p.Close()
				t.Fatal("invalid process configuration accepted")
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Start(ctx, config); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled start accepted", err)
	}
}

func TestWaitDoesNotTruncateUnreadStdoutAndEOFIsExact(t *testing.T) {
	p, ctx := helperProcess(t, "burst")
	if err := p.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		line, err := p.ReadLine(ctx)
		if err != nil || string(line) != fmt.Sprintf(`{"frame":%d}`, i) {
			t.Fatalf("frame %d=%s err=%v", i, line, err)
		}
	}
	if line, err := p.ReadLine(ctx); err != io.EOF || line != nil {
		t.Fatalf("final read=%s err=%v, want exact io.EOF", line, err)
	}
	usage, err := p.Usage()
	if err != nil || usage.CPUTime < 0 || usage.RSSBytes != 0 {
		t.Fatalf("final usage=%+v err=%v", usage, err)
	}
}

func TestChildExitStatusAndBoundedDiagnosticsAreReported(t *testing.T) {
	p, ctx := helperProcess(t, "fail")
	err := p.Wait(ctx)
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 7 || !strings.Contains(err.Error(), "intentional fixture error") {
		t.Fatal("child failure was lost", err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err != nil {
		t.Fatal("Close is not idempotent", err)
	}
}

func TestOutputAndInputBoundsTerminateChild(t *testing.T) {
	for _, test := range []struct {
		mode string
		want error
	}{{"stdout_limit", ErrLineLimit}, {"stderr_limit", ErrStderrLimit}} {
		t.Run(test.mode, func(t *testing.T) {
			p, ctx := helperProcess(t, test.mode)
			if _, err := p.ReadLine(ctx); !errors.Is(err, test.want) {
				t.Fatalf("output limit error=%v wanted=%v", err, test.want)
			}
			if err := p.Wait(ctx); !errors.Is(err, test.want) {
				t.Fatalf("limit not retained by Wait: %v", err)
			}
			p.mu.Lock()
			stderrLength := len(p.stderrBytes)
			p.mu.Unlock()
			if stderrLength > MaxStderrBytes {
				t.Fatal("stderr retention exceeded limit")
			}
		})
	}
	p, ctx := helperProcess(t, "echo")
	awaitReady(t, p, ctx)
	if err := p.SendJSON(ctx, strings.Repeat("x", MaxLineBytes)); !errors.Is(err, ErrLineLimit) {
		t.Fatal("oversized JSON input accepted", err)
	}
	if err := p.Wait(ctx); !errors.Is(err, ErrLineLimit) {
		t.Fatal("input limit did not terminate child", err)
	}
}

func TestReadAndWriteCancellationDoNotLeaveBlockedTransport(t *testing.T) {
	for _, operation := range []string{"read", "write", "wait"} {
		t.Run(operation, func(t *testing.T) {
			p, lifetime := helperProcess(t, "stall")
			awaitReady(t, p, lifetime)
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			started := time.Now()
			var err error
			switch operation {
			case "read":
				_, err = p.ReadLine(ctx)
			case "write":
				err = p.SendJSON(ctx, strings.Repeat("x", MaxLineBytes-100))
			case "wait":
				err = p.Wait(ctx)
			}
			if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > 2*time.Second {
				t.Fatalf("operation=%s err=%v elapsed=%s", operation, err, time.Since(started))
			}
			if err := p.Wait(lifetime); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("cancellation did not terminate child", err)
			}
		})
	}
}

func TestActivityCPUUsesBaselineAndSurvivesChildExit(t *testing.T) {
	p, ctx := helperProcess(t, "echo")
	awaitReady(t, p, ctx)
	first := p.Monitor(ctx, time.Second, 128<<20, 10*time.Millisecond)
	if err := p.SendJSON(ctx, map[string]any{"spin_ms": 100}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.ReadLine(ctx); err != nil {
		t.Fatal(err)
	}
	if err := first(); err != nil {
		t.Fatal(err)
	}
	second := p.Monitor(ctx, 80*time.Millisecond, 128<<20, 10*time.Millisecond)
	if err := p.SendJSON(ctx, map[string]any{"spin_ms": 20, "exit": true}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.ReadLine(ctx); err != nil {
		t.Fatal(err)
	}
	if err := p.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	if err := second(); err != nil {
		t.Fatal("activity charged previous CPU or failed after exit", err)
	}
	if err := second(); err != nil {
		t.Fatal("monitor stop is not idempotent", err)
	}
	usage, err := p.Usage()
	if err != nil || usage.CPUTime <= 0 || (runtime.GOOS == "linux" && usage.PeakRSSBytes == 0) {
		t.Fatalf("final CPU/peak RSS lost: %+v %v", usage, err)
	}
}

func TestMonitorCPUResidentMemoryAndContextBounds(t *testing.T) {
	for _, kind := range []string{"cpu", "rss", "context"} {
		t.Run(kind, func(t *testing.T) {
			p, lifetime := helperProcess(t, "echo")
			awaitReady(t, p, lifetime)
			ctx, cancel := context.WithCancel(lifetime)
			defer cancel()
			cpuLimit, rssLimit, want := time.Duration(0), uint64(0), error(context.Canceled)
			if kind == "cpu" {
				cpuLimit, want = 10*time.Millisecond, ErrCPULimit
			} else if kind == "rss" {
				rssLimit, want = 1, ErrRSSLimit
			}
			stop := p.Monitor(ctx, cpuLimit, rssLimit, 5*time.Millisecond)
			if kind == "context" {
				cancel()
			} else if kind == "cpu" {
				if err := p.SendJSON(lifetime, map[string]any{"spin_ms": 500}); err != nil {
					t.Fatal(err)
				}
			}
			_, _ = p.ReadLine(lifetime)
			if err := stop(); !errors.Is(err, want) {
				t.Fatalf("monitor=%s err=%v wanted=%v", kind, err, want)
			}
			if err := p.Wait(lifetime); !errors.Is(err, want) {
				t.Fatalf("monitor did not terminate process: %v", err)
			}
		})
	}
}

func TestStoppedMonitorLeavesPersistentChildUsable(t *testing.T) {
	p, ctx := helperProcess(t, "echo")
	awaitReady(t, p, ctx)
	stop := p.Monitor(ctx, 0, 0, time.Hour)
	if err := p.Monitor(ctx, 0, 0, time.Hour)(); !errors.Is(err, ErrMonitorBusy) {
		t.Fatal("overlapping monitors accepted", err)
	}
	if err := stop(); err != nil {
		t.Fatal(err)
	}
	p.mu.Lock()
	active := p.monitorActive
	p.mu.Unlock()
	if active {
		t.Fatal("stopped monitor left idle sampling active")
	}
	if err := p.SendJSON(ctx, map[string]bool{"exit": true}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.ReadLine(ctx); err != nil {
		t.Fatal(err)
	}
	if err := p.Wait(ctx); err != nil {
		t.Fatal(err)
	}
}
