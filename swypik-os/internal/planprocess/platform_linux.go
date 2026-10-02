//go:build linux

package planprocess

import (
	"errors"
	"os"
	"syscall"

	"swypik-os/core/resource"
)

func killChild(process *os.Process) error {
	err := syscall.Kill(-process.Pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

func finalUsage(state *os.ProcessState) resource.ProcessUsage {
	if state == nil {
		return resource.ProcessUsage{}
	}
	usage := resource.ProcessUsage{CPUTime: state.UserTime() + state.SystemTime()}
	if stat, ok := state.SysUsage().(*syscall.Rusage); ok && stat.Maxrss > 0 {
		usage.PeakRSSBytes = uint64(stat.Maxrss) * 1024 // Linux getrusage reports KiB.
	}
	return usage
}
