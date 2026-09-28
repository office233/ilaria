//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"go/parser"
	"go/token"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestNativeLaunchDefaults(t *testing.T) {
	t.Setenv("SWYPIK_STATE_DIR", "")
	t.Setenv("SWYPIK_WORKSPACE_DIR", "")
	opts, err := parseLaunchOptions(nil, io.Discard)
	if err != nil || opts.version || opts.check || opts.workspace != "" || opts.dataDir != "" {
		t.Fatalf("unexpected native launch defaults: %+v, %v", opts, err)
	}
	if opts.ilariaURL != "http://127.0.0.1:8091" {
		t.Fatalf("unexpected endpoint: %s", opts.ilariaURL)
	}
}

func TestRejectUnsupportedAndUnsafeOptions(t *testing.T) {
	for _, args := range [][]string{
		{"-headless"}, {"-port", "9876"}, {"unexpected"}, {"-version", "-check"},
		{"-ilaria-url", "http://example.com"}, {"-ilaria-url", "file:///tmp/model"},
		{"-ilaria-url", "https://user:secret@example.com"},
		{"-ilaria-url", "https://example.com/path"},
		{"-ilaria-url", "https://example.com?token=secret"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			if _, err := parseLaunchOptions(args, io.Discard); err == nil {
				t.Fatalf("accepted %v", args)
			}
		})
	}
}

func TestDirectoryResolutionDoesNotWrite(t *testing.T) {
	root := filepath.Join(t.TempDir(), "not-created")
	workspace, dataDir, err := resolveDirectories(launchOptions{dataDir: root})
	if err != nil {
		t.Fatal(err)
	}
	if dataDir != root || workspace != filepath.Join(root, "workspace") {
		t.Fatalf("unexpected paths: %q %q", workspace, dataDir)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("resolution wrote to disk: %v", err)
	}
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := resolveDirectories(launchOptions{dataDir: file}); err == nil {
		t.Fatal("accepted a file as a directory")
	}
}

func TestCheckDoesNotStartRuntimeOrWrite(t *testing.T) {
	root := filepath.Join(t.TempDir(), "not-created")
	var output bytes.Buffer
	if err := run([]string{"-check", "-data-dir", root, "-workspace", filepath.Join(root, "workspace")}, &output); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Runtime  string `json:"runtime"`
		Browser  bool   `json:"browser_required"`
		Listener bool   `json:"http_listener"`
		DataDir  string `json:"data_dir"`
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Runtime != "win32" || result.Browser || result.Listener || result.DataDir != root {
		t.Fatalf("unexpected configuration: %+v", result)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("check mode wrote to disk: %v", err)
	}
}

func TestVersionAndHelpDoNotStartRuntime(t *testing.T) {
	for _, args := range [][]string{{"-version"}, {"-help"}} {
		var output bytes.Buffer
		if err := run(args, &output); err != nil {
			t.Fatal(err)
		}
		if output.Len() == 0 {
			t.Fatalf("no output for %v", args)
		}
	}
}

func TestDesktopLogPersistsAndIsUnique(t *testing.T) {
	root := t.TempDir()
	first, err := openDesktopLog(root)
	if err != nil {
		t.Fatal(err)
	}
	name := first.Name()
	if _, err := first.WriteString("native startup evidence\n"); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := openDesktopLog(root)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if name == second.Name() {
		t.Fatal("log collision")
	}
	content, err := os.ReadFile(name)
	if err != nil || string(content) != "native startup evidence\n" {
		t.Fatalf("missing persistent log: %q, %v", content, err)
	}
}

func TestEntrypointHasNoBrowserOrWebServerFallback(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "main_windows.go", nil, parser.ImportsOnly)
	if err != nil {
		t.Fatal(err)
	}
	for _, imp := range file.Imports {
		name, err := strconv.Unquote(imp.Path.Value)
		if err != nil {
			t.Fatal(err)
		}
		if name == "os/exec" || name == "net/http" || name == "swypik-os/ui/web" || strings.Contains(strings.ToLower(name), "electron") {
			t.Fatalf("forbidden hosted-runtime dependency in desktop entrypoint: %s", name)
		}
	}
}
