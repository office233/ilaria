package coder

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"swypik-os/config"
	"sync"
	"time"
)

// FileItem represents a directory entry.
type FileItem struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	ModTime string `json:"mod_time"`
}

// ExecutionResult captures the output of a system command or code action.
type ExecutionResult struct {
	Command   string `json:"command"`
	Output    string `json:"output"`
	Success   bool   `json:"success"`
	LatencyMs int64  `json:"latency_ms"`
}

// Engine provides autonomous coding, file operations, and terminal execution.
type Engine struct {
	mu          sync.RWMutex
	currentDir  string
	recentExecs []ExecutionResult
}

// NewEngine initializes the autonomous coding and execution engine.
func NewEngine() *Engine {
	cwd := config.Get().WorkspaceDir
	return &Engine{
		currentDir:  cwd,
		recentExecs: make([]ExecutionResult, 0),
	}
}

// ListDirectory lists files and folders in a specified path.
func (e *Engine) ListDirectory(targetPath string) ([]FileItem, error) {
	if targetPath == "" {
		targetPath = e.currentDir
	}

	entries, err := os.ReadDir(targetPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read directory '%s': %w", targetPath, err)
	}

	items := make([]FileItem, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		var size int64 = 0
		var modTime string = ""
		if err == nil {
			size = info.Size()
			modTime = info.ModTime().Format("15:04 02/01/2006")
		}

		items = append(items, FileItem{
			Name:    entry.Name(),
			Path:    filepath.Join(targetPath, entry.Name()),
			IsDir:   entry.IsDir(),
			Size:    size,
			ModTime: modTime,
		})
	}
	return items, nil
}

// CreateFile writes code or content to a specific file path.
func (e *Engine) CreateFile(filePath, content string) error {
	dir := filepath.Dir(filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create directory structure '%s': %w", dir, err)
	}
	return os.WriteFile(filePath, []byte(content), 0644)
}

// ReadFile reads the text content of a file.
func (e *Engine) ReadFile(filePath string) (string, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ExecuteCommand executes a shell or system command and captures output.
func (e *Engine) ExecuteCommand(cmdStr string) ExecutionResult {
	return e.ExecuteCommandContext(context.Background(), cmdStr)
}

// ExecuteCommandContext ties command execution to the caller's lifetime.
func (e *Engine) ExecuteCommandContext(parent context.Context, cmdStr string) ExecutionResult {
	start := time.Now()
	cmdStr = strings.TrimSpace(cmdStr)
	lower := strings.ToLower(cmdStr)

	// Security Check: metacharacter injection
	for _, meta := range []string{"&", "|", ";", ">", "<", "`", "$", "\r", "\n"} {
		if strings.Contains(cmdStr, meta) {
			return ExecutionResult{
				Command:   cmdStr,
				Output:    "[SECURITY REJECTED] Shell metacharacters are not supported by the command filter.",
				Success:   false,
				LatencyMs: time.Since(start).Milliseconds(),
			}
		}
	}

	// Security Check: destructive command
	for _, blocked := range []string{"del", "format", "erase", "rd", "rmdir", "shutdown"} {
		fields := strings.Fields(lower)
		if len(fields) > 0 && fields[0] == blocked {
			return ExecutionResult{
				Command:   cmdStr,
				Output:    "[SECURITY REJECTED] Destructive command blocked by the command filter.",
				Success:   false,
				LatencyMs: time.Since(start).Milliseconds(),
			}
		}
	}

	// Run via Windows cmd.exe
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	out := &commandOutput{}
	err := runShell(ctx, cmdStr, e.currentDir, out)
	success := (err == nil)
	outStr := out.String()
	if ctx.Err() != nil {
		success = false
		outStr += "\nCommand interrupted: " + ctx.Err().Error()
	}
	if !success && outStr == "" {
		outStr = err.Error()
	}

	res := ExecutionResult{
		Command:   cmdStr,
		Output:    strings.TrimSpace(outStr),
		Success:   success,
		LatencyMs: time.Since(start).Milliseconds(),
	}

	e.mu.Lock()
	e.recentExecs = append(e.recentExecs, res)
	if len(e.recentExecs) > 50 {
		e.recentExecs = e.recentExecs[len(e.recentExecs)-50:]
	}
	e.mu.Unlock()

	return res
}

// GenerateCode synthesizes code templates based on natural prompts (Claude Code / Codex style).
func (e *Engine) GenerateCode(prompt string, lang string) (string, string) {
	lower := strings.ToLower(prompt)
	var filename string
	var code string

	switch {
	case strings.Contains(lower, "api") || strings.Contains(lower, "server") || strings.Contains(lower, "http"):
		filename = "server.go"
		code = `package main

import (
	"fmt"
	"net/http"
)

func main() {
	http.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "{\"status\":\"healthy\",\"engine\":\"SwypikOS Native\"}")
	})
	fmt.Println("Swypik API Server listening on :8080...")
	http.ListenAndServe(":8080", nil)
}`

	case strings.Contains(lower, "script") || strings.Contains(lower, "python"):
		filename = "task.py"
		code = `# SwypikOS Cognitive Script
import sys

def main():
    print("Executing automated Swypik data pipeline...")

if __name__ == "__main__":
    main()`

	default:
		filename = "module.go"
		code = `package main

import "fmt"

func main() {
	fmt.Println("SwypikOS Native Agent Execution Verified.")
}`
	}

	return filename, code
}
