//go:build linux

package planprocess

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

type platformGroup struct {
	directory string
	dir       *os.File
}

func wordSet(raw []byte) map[string]bool {
	set := make(map[string]bool)
	for _, word := range strings.Fields(string(raw)) {
		set[strings.TrimPrefix(word, "+")] = true
	}
	return set
}

func writeControl(directory, name, value string) error {
	return os.WriteFile(filepath.Join(directory, name), []byte(value), 0600)
}

func openPlatformGroup(limits Limits) (*platformGroup, string, error) {
	root := filepath.Clean(limits.LinuxDelegatedRoot)
	if root == "." || !filepath.IsAbs(root) || root == "/sys/fs/cgroup" {
		return nil, "", fmt.Errorf("explicit delegated cgroup v2 root below /sys/fs/cgroup is required")
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, "", fmt.Errorf("delegated cgroup root is not a real directory")
	}
	var filesystem unix.Statfs_t
	if err := unix.Statfs(root, &filesystem); err != nil {
		return nil, "", fmt.Errorf("inspect delegated cgroup filesystem: %w", err)
	}
	if filesystem.Type != unix.CGROUP2_SUPER_MAGIC {
		return nil, "", fmt.Errorf("delegated root is not on a cgroup v2 filesystem")
	}
	controllers, err := os.ReadFile(filepath.Join(root, "cgroup.controllers"))
	if err != nil {
		return nil, "", fmt.Errorf("cgroup v2 controllers unavailable: %w", err)
	}
	available := wordSet(controllers)
	for _, controller := range []string{"cpu", "memory", "pids"} {
		if !available[controller] {
			return nil, "", fmt.Errorf("delegated cgroup does not expose %s controller", controller)
		}
	}
	subtree, err := os.ReadFile(filepath.Join(root, "cgroup.subtree_control"))
	if err != nil {
		return nil, "", fmt.Errorf("read delegated subtree controls: %w", err)
	}
	enabled := wordSet(subtree)
	var missing []string
	for _, controller := range []string{"cpu", "memory", "pids"} {
		if !enabled[controller] {
			missing = append(missing, "+"+controller)
		}
	}
	if len(missing) != 0 {
		// This write is permitted only inside the explicitly delegated root.
		// A correctly prepared delegation keeps host processes in a child leaf
		// so cgroup v2's no-internal-process rule is satisfied.
		if err := writeControl(root, "cgroup.subtree_control", strings.Join(missing, " ")+"\n"); err != nil {
			return nil, "", fmt.Errorf("enable controllers in delegated cgroup: %w", err)
		}
		subtree, err = os.ReadFile(filepath.Join(root, "cgroup.subtree_control"))
		if err != nil {
			return nil, "", fmt.Errorf("re-read delegated subtree controls: %w", err)
		}
		enabled = wordSet(subtree)
		for _, controller := range []string{"cpu", "memory", "pids"} {
			if !enabled[controller] {
				return nil, "", fmt.Errorf("delegated cgroup did not enable %s controller", controller)
			}
		}
	}
	directory, err := os.MkdirTemp(root, "nexus-supervisor-")
	if err != nil {
		return nil, "", fmt.Errorf("delegated cgroup is not writable: %w", err)
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(directory)
		}
	}()
	period := uint64(100000) // microseconds; conventional cgroup v2 period.
	// Windows Job Object CPU rate control expresses a fraction of total host
	// processor cycles. Scale the cgroup quota by the logical CPUs available to
	// this process so CPUPercent has the same host-capacity meaning on Linux.
	availableCPUs := max(1, runtime.NumCPU())
	quota := max(uint64(1000), period*uint64(limits.CPUPercent)*uint64(availableCPUs)/100)
	for name, value := range map[string]string{
		"cpu.max":    strconv.FormatUint(quota, 10) + " " + strconv.FormatUint(period, 10) + "\n",
		"memory.max": strconv.FormatUint(limits.MemoryBytes, 10) + "\n",
		"pids.max":   strconv.FormatUint(uint64(limits.MaxProcesses), 10) + "\n",
	} {
		if err := writeControl(directory, name, value); err != nil {
			return nil, "", fmt.Errorf("configure %s: %w", name, err)
		}
	}
	dir, err := os.Open(directory)
	if err != nil {
		return nil, "", err
	}
	cleanup = false
	return &platformGroup{directory: directory, dir: dir}, "linux_cgroup_v2", nil
}

func configureChild(cmd *exec.Cmd, group *platformGroup) {
	attr := &syscall.SysProcAttr{Setpgid: true}
	if group != nil {
		// Go uses clone3(CLONE_INTO_CGROUP), so the child cannot execute or
		// fork outside the delegated cgroup between Start and attachment.
		attr.UseCgroupFD = true
		attr.CgroupFD = int(group.dir.Fd())
	}
	cmd.SysProcAttr = attr
}

func activateChild(*platformGroup, int) error { return nil }

func cgroupEmpty(directory string) bool {
	raw, err := os.ReadFile(filepath.Join(directory, "cgroup.events"))
	return err == nil && strings.Contains(string(raw), "populated 0")
}

func killCgroupFallback(directory string) error {
	raw, err := os.ReadFile(filepath.Join(directory, "cgroup.procs"))
	if err != nil {
		return err
	}
	var result error
	for _, field := range strings.Fields(string(raw)) {
		pid, parseErr := strconv.Atoi(field)
		if parseErr == nil {
			if killErr := syscall.Kill(pid, syscall.SIGKILL); killErr != nil && !errors.Is(killErr, syscall.ESRCH) {
				result = errors.Join(result, killErr)
			}
		}
	}
	return result
}

func closePlatformGroup(group *platformGroup) error {
	if group == nil {
		return nil
	}
	var result error
	if group.dir != nil {
		result = errors.Join(result, group.dir.Close())
		group.dir = nil
	}
	if !cgroupEmpty(group.directory) {
		deadline := time.Now().Add(2 * time.Second)
		if err := writeControl(group.directory, "cgroup.kill", "1\n"); err != nil {
			// Older cgroup v2 kernels may not expose cgroup.kill. Re-read
			// cgroup.procs until the group is empty so descendants that race a
			// one-shot PID snapshot cannot survive cleanup.
			for !cgroupEmpty(group.directory) && time.Now().Before(deadline) {
				result = errors.Join(result, killCgroupFallback(group.directory))
				if !cgroupEmpty(group.directory) {
					time.Sleep(10 * time.Millisecond) // cleanup only; never an idle poller.
				}
			}
		} else {
			for !cgroupEmpty(group.directory) && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond) // cleanup only; never an idle poller.
			}
		}
		if !cgroupEmpty(group.directory) {
			result = errors.Join(result, fmt.Errorf("cgroup remained populated during cleanup"))
		}
	}
	result = errors.Join(result, os.Remove(group.directory))
	return result
}
