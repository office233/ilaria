//go:build !unix

package swe

import "os/exec"

const hostExecutionSupported = false

func configureProcessGroup(cmd *exec.Cmd) {}
func cleanupProcessGroup(cmd *exec.Cmd)   {}
