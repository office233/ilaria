//go:build windows

package planprocess

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestWindowsJobObjectAppliesAndReportsHardGroupLimits(t *testing.T) {
	limits := Limits{CPUPercent: 37, MemoryBytes: 256 << 20, MaxProcesses: 7}
	g, err := OpenGroup(limits)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	if g.Mechanism() != "windows_job_object" {
		t.Fatalf("mechanism=%q", g.Mechanism())
	}
	extended := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	if err := windows.QueryInformationJobObject(g.platform.job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&extended)), uint32(unsafe.Sizeof(extended)), nil); err != nil {
		t.Fatal(err)
	}
	wantFlags := uint32(windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_JOB_MEMORY | windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS)
	if extended.BasicLimitInformation.LimitFlags&wantFlags != wantFlags || extended.BasicLimitInformation.ActiveProcessLimit != limits.MaxProcesses || uint64(extended.JobMemoryLimit) != limits.MemoryBytes {
		t.Fatalf("job limits=%+v", extended)
	}
	cpu := jobObjectCPURateControlInformation{}
	if err := windows.QueryInformationJobObject(g.platform.job, windows.JobObjectCpuRateControlInformation,
		uintptr(unsafe.Pointer(&cpu)), uint32(unsafe.Sizeof(cpu)), nil); err != nil {
		t.Fatal(err)
	}
	if cpu.ControlFlags != jobObjectCPURateEnable|jobObjectCPUHardCap || cpu.CPURate != limits.CPUPercent*100 {
		t.Fatalf("CPU rate control=%+v", cpu)
	}
}

func TestWindowsJobObjectMemoryLimitAndCloseTerminateChildren(t *testing.T) {
	g, err := OpenGroup(Limits{CPUPercent: 100, MemoryBytes: 64 << 20, MaxProcesses: 8})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p, err := g.Start(ctx, helperConfig(t, "memory_hog"))
	if err != nil {
		_ = g.Close()
		t.Fatal(err)
	}
	awaitReady(t, p, ctx)
	done := make(chan error, 1)
	go func() { done <- p.Wait(ctx) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("memory-hog process exited cleanly despite hard Job memory limit")
		}
	case <-time.After(5 * time.Second):
		if err := g.Close(); err != nil {
			t.Fatal(err)
		}
		if err := <-done; err == nil {
			t.Fatal("Job close did not terminate active child")
		}
		return
	}
	if err := g.Close(); err != nil && !errors.Is(err, windows.ERROR_INVALID_HANDLE) {
		t.Fatal(err)
	}
}

func TestWindowsJobObjectCloseKillsDescendantProcessTree(t *testing.T) {
	g, err := OpenGroup(Limits{CPUPercent: 100, MemoryBytes: 256 << 20, MaxProcesses: 8})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p, err := g.Start(ctx, helperConfig(t, "spawn_descendant"))
	if err != nil {
		_ = g.Close()
		t.Fatal(err)
	}
	line, err := p.ReadLine(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var frame struct {
		ChildPID uint32 `json:"child_pid"`
	}
	if err := json.Unmarshal(line, &frame); err != nil || frame.ChildPID == 0 {
		t.Fatalf("descendant frame=%s err=%v", line, err)
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, frame.ChildPID)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	if err := g.Close(); err != nil {
		t.Fatal(err)
	}
	if status, err := windows.WaitForSingleObject(handle, 2000); err != nil || status != windows.WAIT_OBJECT_0 {
		t.Fatalf("descendant remained alive after Job close: status=%d err=%v", status, err)
	}
	_ = p.Wait(ctx)
}
