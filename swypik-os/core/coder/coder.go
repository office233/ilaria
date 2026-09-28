// Package coder runs command lines for the desktop and the agent's
// process.run tool. Commands run with the user's permissions inside a Windows
// Job Object, so cancellation also stops their child processes. This is
// lifecycle control, not a sandbox: the approval shown to the user is the
// control point, and nothing here pretends to filter "dangerous" commands.
package coder

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Run executes one command line in dir and returns the combined stdout and
// stderr (bounded to 256 KiB). A non-zero exit status is returned as an error
// together with the output.
func Run(ctx context.Context, command, dir string) (string, error) {
	command = strings.TrimSpace(command)
	if command == "" || strings.ContainsAny(command, "\x00\r\n") {
		return "", fmt.Errorf("one non-empty command line required")
	}
	out := &commandOutput{}
	err := runShell(ctx, command, dir, out)
	text := out.String()
	if !utf8.ValidString(text) {
		text = decodeConsole([]byte(text))
	}
	if cerr := ctx.Err(); cerr != nil {
		return text, fmt.Errorf("command interrupted: %w", cerr)
	}
	return text, err
}
