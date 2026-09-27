package coder

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCoderEngine(t *testing.T) {
	e := NewEngine()

	// 1. Test directory listing
	items, err := e.ListDirectory(".")
	if err != nil {
		t.Fatalf("Failed to list directory: %v", err)
	}
	if len(items) == 0 {
		t.Errorf("Expected files in current directory")
	}

	// 2. Test code generation
	fn, code := e.GenerateCode("create an http server api", "go")
	if fn != "server.go" || code == "" {
		t.Errorf("Failed to generate code, got file: %s", fn)
	}

	// 3. Test file creation and read
	tempFile := filepath.Join(os.TempDir(), "swypik_test_file.txt")
	defer os.Remove(tempFile)

	err = e.CreateFile(tempFile, "SwypikOS Native File Content")
	if err != nil {
		t.Fatalf("Failed to write file: %v", err)
	}

	content, err := e.ReadFile(tempFile)
	if err != nil {
		t.Fatalf("Failed to read file: %v", err)
	}
	if content != "SwypikOS Native File Content" {
		t.Errorf("Unexpected content read: %s", content)
	}

	// 4. Test command execution
	res := e.ExecuteCommand("echo SwypikOS Native Execution")
	if !res.Success || res.Output != "SwypikOS Native Execution" {
		t.Errorf("Command execution failed: %v, output: %s", res.Success, res.Output)
	}
}
