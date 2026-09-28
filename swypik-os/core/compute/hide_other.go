//go:build !windows

package compute

import "os/exec"

func hideWindow(*exec.Cmd) {}
