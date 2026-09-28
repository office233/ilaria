//go:build !windows

package coder

import (
	"context"
	"fmt"
	"io"
	"strings"
)

func runShell(context.Context, string, string, io.Writer) error {
	return fmt.Errorf("local command execution requires Windows")
}

func decodeConsole(b []byte) string { return strings.ToValidUTF8(string(b), "�") }
