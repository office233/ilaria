package coder

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// Only the test binary accepts these flags; production has no helper entrypoint.
func TestShellProcessHelper(t *testing.T) {
	if len(os.Args) < 2 {
		return
	}
	mode := os.Args[len(os.Args)-1]
	if mode == "--swypik-probe-handle" {
		handle, _ := strconv.ParseUint(os.Getenv("SWYPIK_TEST_HANDLE"), 10, 64)
		kernel32.NewProc("SetEvent").Call(uintptr(handle))
		os.Exit(0)
	}
	if mode == "--swypik-child" {
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
	if mode != "--swypik-parent" && mode != "--swypik-parent-exit" {
		return
	}
	child := exec.Command(os.Args[0], "-test.run=^TestShellProcessHelper$", "--", "--swypik-child")
	child.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := child.Start(); err != nil {
		os.Exit(2)
	}
	if err := os.WriteFile(os.Getenv("SWYPIK_TEST_CHILD_PID"), []byte(strconv.Itoa(child.Process.Pid)), 0600); err != nil {
		os.Exit(3)
	}
	if mode == "--swypik-parent-exit" {
		// Keep parent alive until the test has opened a handle to the child.
		for i := 0; i < 1000; i++ {
			if _, err := os.Stat(os.Getenv("SWYPIK_TEST_CHILD_PID") + ".release"); err == nil {
				os.Exit(0)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	child.Wait()
	os.Exit(0)
}

func TestShellReapsChildProcesses(t *testing.T) {
	for _, mode := range []string{"--swypik-parent", "--swypik-parent-exit"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			pidFile := filepath.Join(root, "child.pid")
			t.Setenv("SWYPIK_TEST_CHILD_PID", pidFile)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			done := make(chan error, 1)
			command := `"` + os.Args[0] + `" -test.run=^TestShellProcessHelper$ -- ` + mode
			go func() { done <- runShell(ctx, command, root, io.Discard) }()
			var pid int
			for pid == 0 && ctx.Err() == nil {
				if data, err := os.ReadFile(pidFile); err == nil {
					pid, _ = strconv.Atoi(string(data))
				}
				if pid == 0 {
					time.Sleep(10 * time.Millisecond)
				}
			}
			if pid == 0 {
				cancel()
				err := <-done
				t.Fatalf("child never started: %v", err)
			}
			handle, err := syscall.OpenProcess(syscall.SYNCHRONIZE|syscall.PROCESS_TERMINATE, false, uint32(pid))
			if err != nil {
				t.Fatal(err)
			}
			defer syscall.CloseHandle(handle)
			defer syscall.TerminateProcess(handle, 1) // Own test child only, if regression leaves it alive.
			if mode == "--swypik-parent" {
				cancel()
			} else {
				if err := os.WriteFile(pidFile+".release", nil, 0600); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err := <-done:
				if mode == "--swypik-parent-exit" && err != nil {
					t.Fatal(err)
				}
				if mode == "--swypik-parent" && err == nil {
					t.Fatal("cancellation reported success")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("command tree did not stop")
			}
			status, err := syscall.WaitForSingleObject(handle, 1000)
			if err != nil || status != syscall.WAIT_OBJECT_0 {
				t.Fatalf("child survived: status=%d err=%v", status, err)
			}
		})
	}
}

func TestShellQuotingWorkingDirectoryAndExitCode(t *testing.T) {
	root := filepath.Join(t.TempDir(), "with spaces")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		command, want string
		fail          bool
	}{
		{`echo "hello world"`, `"hello world"`, false},
		{`cd`, root, false},
		{`exit /b 7`, "", true},
	} {
		out := &commandOutput{}
		err := runShell(context.Background(), tc.command, root, out)
		if (err != nil) != tc.fail {
			t.Fatalf("%s: %v", tc.command, err)
		}
		if strings.TrimSpace(out.String()) != tc.want {
			t.Fatalf("%s: %q", tc.command, out.String())
		}
	}
}

func TestConcurrentShellsKeepOutputSeparate(t *testing.T) {
	root := t.TempDir()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			out := &commandOutput{}
			want := "concurrent-" + strconv.Itoa(i)
			if err := runShell(ctx, "echo "+want, root, out); err != nil {
				t.Error(err)
				return
			}
			if strings.TrimSpace(out.String()) != want {
				t.Errorf("mixed output: %q", out.String())
			}
		}(i)
	}
	wg.Wait()
}

func TestShellDoesNotInheritUnrelatedHandles(t *testing.T) {
	sa := syscall.SecurityAttributes{InheritHandle: 1}
	sa.Length = uint32(unsafe.Sizeof(sa))
	event, _, err := kernel32.NewProc("CreateEventW").Call(uintptr(unsafe.Pointer(&sa)), 1, 0, 0)
	if event == 0 {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(syscall.Handle(event))
	t.Setenv("SWYPIK_TEST_HANDLE", strconv.FormatUint(uint64(event), 10))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := `"` + os.Args[0] + `" -test.run=^TestShellProcessHelper$ -- --swypik-probe-handle`
	if err := runShell(ctx, command, t.TempDir(), io.Discard); err != nil {
		t.Fatal(err)
	}
	status, err := syscall.WaitForSingleObject(syscall.Handle(event), 0)
	if err != nil || status != syscall.WAIT_TIMEOUT {
		t.Fatalf("child inherited unrelated handle: status=%d err=%v", status, err)
	}
}
