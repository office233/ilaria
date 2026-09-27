//go:build !windows

package coder

import (
	"context"
	"fmt"
	"io"
)

func runShell(context.Context, string, string, io.Writer) error {
	return fmt.Errorf("local command execution requires Windows")
}
