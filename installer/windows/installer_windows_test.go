package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLauncherUsesBinAndProjectWorkingDirectory(t *testing.T) {
	root := filepath.Join(t.TempDir(), "project with spaces")
	if err := os.MkdirAll(filepath.Join(root, "bin"), 0755); err != nil {
		t.Fatal(err)
	}
	installer := &SwypikInstaller{InstallDir: root}
	if err := installer.CreateLauncherShortcut(); err == nil {
		t.Fatal("missing binary accepted")
	}
	if err := os.WriteFile(filepath.Join(root, "bin", "swypik-os.exe"), []byte("test"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := installer.CreateLauncherShortcut(); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(root, "Start-SwypikOS.bat"))
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{`cd /d "%~dp0"`, `"%~dp0bin\swypik-os.exe" %*`} {
		if !strings.Contains(string(body), required) {
			t.Fatalf("missing %q in launcher", required)
		}
	}
}
