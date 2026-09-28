package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSourceCommandsRejectOversizedInput(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "oversized.swyp")
	if err := os.WriteFile(input, bytes.Repeat([]byte(" "), (1<<20)+1), 0600); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"check", "run", "emit-c", "web", "build"} {
		t.Run(command, func(t *testing.T) {
			output := filepath.Join(dir, command+".output")
			args := []string{command}
			if command == "web" || command == "build" {
				args = append(args, "-o", output)
			}
			args = append(args, input)
			err := execute(args)
			if err == nil || !strings.Contains(err.Error(), "input exceeds 1048576-byte limit") {
				t.Fatalf("%s did not reject during bounded input reading: %v", command, err)
			}
			if _, err := os.Stat(output); !os.IsNotExist(err) {
				t.Fatalf("oversized input created output: %v", err)
			}
		})
	}
}

func TestSourceCommandsAcceptExactLimit(t *testing.T) {
	source := "fn main() {}"
	source += strings.Repeat(" ", (1<<20)-len(source))
	path := filepath.Join(t.TempDir(), "boundary.swyp")
	if err := os.WriteFile(path, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"check", "run"} {
		t.Run(command, func(t *testing.T) {
			if err := execute([]string{command, path}); err != nil {
				t.Fatalf("exactly 1 MiB should remain accepted: %v", err)
			}
		})
	}
}

func TestSourceCommandsPreserveReadErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.swyp")
	if err := execute([]string{"check", path}); !os.IsNotExist(err) {
		t.Fatalf("missing source error was lost: %v", err)
	}
}
