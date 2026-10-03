//go:build !linux && !windows

package planprocess

import (
	"fmt"
	"os/exec"
)

type platformGroup struct{}

func openPlatformGroup(Limits) (*platformGroup, string, error) {
	return nil, "", fmt.Errorf("strict process groups are unsupported on this platform")
}

func configureChild(cmd *exec.Cmd, _ *platformGroup) {}
func activateChild(*platformGroup, int) error        { return nil }
func closePlatformGroup(*platformGroup) error        { return nil }
