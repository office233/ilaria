//go:build windows

package planprocess

import (
	"os"

	"swypik-os/core/resource"
)

func killChild(process *os.Process) error { return process.Kill() }

func finalUsage(state *os.ProcessState) resource.ProcessUsage {
	if state == nil {
		return resource.ProcessUsage{}
	}
	return resource.ProcessUsage{CPUTime: state.UserTime() + state.SystemTime()}
}
