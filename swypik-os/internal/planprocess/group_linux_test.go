//go:build linux

package planprocess

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestLinuxCgroupRequiresExplicitDelegatedRoot(t *testing.T) {
	if _, err := OpenGroup(Limits{CPUPercent: 50, MemoryBytes: 128 << 20, MaxProcesses: 8}); !errors.Is(err, ErrKernelLimitsUnavailable) {
		t.Fatalf("missing delegated root accepted: %v", err)
	}
}

func TestLinuxCgroupRejectsOrdinaryFilesystemBeforeCreatingControls(t *testing.T) {
	root := t.TempDir()
	for name, value := range map[string]string{
		"cgroup.controllers":     "cpu memory pids\n",
		"cgroup.subtree_control": "cpu memory pids\n",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := OpenGroup(Limits{CPUPercent: 50, MemoryBytes: 128 << 20, MaxProcesses: 8, LinuxDelegatedRoot: root}); !errors.Is(err, ErrKernelLimitsUnavailable) {
		t.Fatalf("ordinary filesystem accepted as delegated cgroup v2 root: %v", err)
	}
	for _, name := range []string{"cpu.max", "memory.max", "pids.max"} {
		if _, err := os.Stat(filepath.Join(root, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s was created before cgroup v2 validation: %v", name, err)
		}
	}
}

func TestLinuxDelegatedCgroupV2EnforcesConfiguredControllers(t *testing.T) {
	root := os.Getenv("NEXUS_TEST_CGROUP_ROOT")
	if root == "" {
		t.Skip("real cgroup integration requires explicitly delegated NEXUS_TEST_CGROUP_ROOT")
	}
	limits := Limits{CPUPercent: 23, MemoryBytes: 128 << 20, MaxProcesses: 9, LinuxDelegatedRoot: root}
	g, err := OpenGroup(limits)
	if err != nil {
		t.Fatal(err)
	}
	if g.Mechanism() != "linux_cgroup_v2" {
		t.Fatalf("mechanism=%q", g.Mechanism())
	}
	period := uint64(100000)
	quota := max(uint64(1000), period*uint64(limits.CPUPercent)*uint64(max(1, runtime.NumCPU()))/100)
	for name, want := range map[string]string{
		"cpu.max": strconv.FormatUint(quota, 10) + " 100000", "memory.max": "134217728", "pids.max": "9",
	} {
		raw, err := os.ReadFile(filepath.Join(g.platform.directory, name))
		if err != nil || strings.TrimSpace(string(raw)) != want {
			t.Fatalf("%s=%q err=%v want=%q", name, raw, err, want)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p, err := g.Start(ctx, helperConfig(t, "stall"))
	if err != nil {
		_ = g.Close()
		t.Fatal(err)
	}
	awaitReady(t, p, ctx)
	if err := g.Close(); err != nil {
		t.Fatal(err)
	}
	if err := p.Wait(ctx); err == nil {
		t.Fatal("cgroup close did not terminate active child")
	}
}

func TestLinuxDelegatedCgroupMemoryAndDescendantCleanup(t *testing.T) {
	root := os.Getenv("NEXUS_TEST_CGROUP_ROOT")
	if root == "" {
		t.Skip("real cgroup integration requires explicitly delegated NEXUS_TEST_CGROUP_ROOT")
	}
	t.Run("memory", func(t *testing.T) {
		g, err := OpenGroup(Limits{CPUPercent: 100, MemoryBytes: 64 << 20, MaxProcesses: 8, LinuxDelegatedRoot: root})
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
		if err := p.Wait(ctx); err == nil {
			t.Fatal("memory-hog process exited cleanly despite memory.max")
		}
		if err := g.Close(); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("descendant", func(t *testing.T) {
		g, err := OpenGroup(Limits{CPUPercent: 100, MemoryBytes: 256 << 20, MaxProcesses: 8, LinuxDelegatedRoot: root})
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
			ChildPID int `json:"child_pid"`
		}
		if err := json.Unmarshal(line, &frame); err != nil || frame.ChildPID < 1 {
			t.Fatalf("descendant frame=%s err=%v", line, err)
		}
		if err := g.Close(); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) && syscall.Kill(frame.ChildPID, 0) == nil {
			time.Sleep(10 * time.Millisecond)
		}
		if err := syscall.Kill(frame.ChildPID, 0); err == nil || !errors.Is(err, syscall.ESRCH) {
			t.Fatalf("descendant %d remained alive after cgroup kill: %v", frame.ChildPID, err)
		}
		_ = p.Wait(ctx)
	})
}
