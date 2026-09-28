//go:build windows

package compute

import (
	"os/exec"
	"syscall"
)

// A GUI process that starts a console tool would flash a console window.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}
