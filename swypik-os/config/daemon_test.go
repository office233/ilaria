package config

import (
	"path/filepath"
	"testing"
)

func TestDaemonUsesExplicitDirectoriesAndWorkspace(t *testing.T) {
	root := t.TempDir()
	t.Setenv("SWYPIK_DAEMON_DATA_DIR", filepath.Join(root, "data"))
	t.Setenv("SWYPIK_DAEMON_RUNTIME_DIR", filepath.Join(root, "runtime"))
	t.Setenv("SWYPIK_WORKSPACE_DIR", "")
	t.Setenv("SWYPIK_ILARIA_URL", "https://inference.example")
	config, err := DefaultDaemonConfig()
	if err != nil {
		t.Fatal(err)
	}
	if config.Socket != filepath.Join(root, "runtime", "control.sock") ||
		config.Index != filepath.Join(root, "data", "index.jsonl") ||
		config.StateDir != filepath.Join(root, "data", "agent") || config.Workspace != "" {
		t.Fatalf("daemon ignored explicit directories: %+v", config)
	}
	if err := config.Validate(); err == nil {
		t.Fatal("daemon inferred workspace authority")
	}
	config.Workspace = filepath.Join(root, "workspace")
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestDaemonRejectsRelativeDirectoryOverrides(t *testing.T) {
	t.Setenv("SWYPIK_DAEMON_DATA_DIR", "relative/data")
	t.Setenv("SWYPIK_DAEMON_RUNTIME_DIR", t.TempDir())
	if _, err := DefaultDaemonConfig(); err == nil {
		t.Fatal("relative daemon directory accepted")
	}
}
