package config

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestConfigLoading(t *testing.T) {
	tempEnv := filepath.Join(t.TempDir(), "test_swypik.env")
	for _, key := range []string{"SWYPIK_PORT", "SWYPIK_BIND_HOST", "SWYPIK_SWARM_ENABLED", "SWYPIK_SWARM_REWARD_PER_TFLOP", "SWYPIK_DEFAULT_URL"} {
		t.Setenv(key, "")
		if err := os.Unsetenv(key); err != nil {
			t.Fatal(err)
		}
	}

	content := `
# Swypik Test Config
SWYPIK_PORT=9999
SWYPIK_BIND_HOST=0.0.0.0
SWYPIK_SWARM_ENABLED=false
SWYPIK_SWARM_REWARD_PER_TFLOP=0.25
SWYPIK_DEFAULT_URL="https://test.swypik.com"
`
	if err := os.WriteFile(tempEnv, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write test env: %v", err)
	}

	loadEnvFile(tempEnv)

	if GetInt("SWYPIK_PORT", 8080) != 9999 {
		t.Errorf("expected port 9999, got %d", GetInt("SWYPIK_PORT", 8080))
	}
	if GetString("SWYPIK_BIND_HOST", "127.0.0.1") != "0.0.0.0" {
		t.Errorf("expected 0.0.0.0, got %s", GetString("SWYPIK_BIND_HOST", "127.0.0.1"))
	}
	if GetBool("SWYPIK_SWARM_ENABLED", true) != false {
		t.Errorf("expected swarm disabled")
	}
	if GetFloat("SWYPIK_SWARM_REWARD_PER_TFLOP", 0.1) != 0.25 {
		t.Errorf("expected reward 0.25")
	}
	if GetString("SWYPIK_DEFAULT_URL", "") != "https://test.swypik.com" {
		t.Errorf("expected stripped quotes URL")
	}
}

func TestLoadFromEnvFileVar(t *testing.T) {
	tempDir := t.TempDir()
	envPath := filepath.Join(tempDir, "custom.env")
	content := "SWYPIK_PORT=7777\nSWYPIK_EDGE_PATH=test_edge_path\n"
	if err := os.WriteFile(envPath, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}

	t.Setenv(EnvFileVar, envPath)
	t.Setenv("SWYPIK_PORT", "")
	_ = os.Unsetenv("SWYPIK_PORT")
	t.Setenv("SWYPIK_EDGE_PATH", "")
	_ = os.Unsetenv("SWYPIK_EDGE_PATH")

	resetForTesting()
	t.Cleanup(resetForTesting)

	cfg := Load()
	if cfg.ServerPort != 7777 {
		t.Fatalf("expected port 7777 from EnvFileVar, got %d", cfg.ServerPort)
	}
	if cfg.EdgePath != "test_edge_path" {
		t.Fatalf("expected edge path 'test_edge_path', got %s", cfg.EdgePath)
	}
}

func TestLoadDoesNotReadCWDEnv(t *testing.T) {
	tempDir := t.TempDir()
	cwdEnv := filepath.Join(tempDir, ".env")
	content := "SWYPIK_PORT=6666\nSWYPIK_EDGE_PATH=untrusted_cwd_edge\n"
	if err := os.WriteFile(cwdEnv, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}

	origDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(tempDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(origDir)
		resetForTesting()
	})

	t.Setenv(EnvFileVar, "")
	_ = os.Unsetenv(EnvFileVar)
	t.Setenv("SWYPIK_PORT", "")
	_ = os.Unsetenv("SWYPIK_PORT")
	t.Setenv("SWYPIK_EDGE_PATH", "")
	_ = os.Unsetenv("SWYPIK_EDGE_PATH")

	resetForTesting()
	cfg := Load()

	if cfg.ServerPort == 6666 {
		t.Fatalf("Load() must not read .env from CWD; got port 6666")
	}
	if cfg.EdgePath == "untrusted_cwd_edge" {
		t.Fatalf("Load() must not read .env from CWD; got untrusted EdgePath")
	}
}

func TestLoadPrecedenceAlreadySetEnvWins(t *testing.T) {
	tempDir := t.TempDir()
	envPath := filepath.Join(tempDir, "test.env")
	content := "SWYPIK_PORT=4444\n"
	if err := os.WriteFile(envPath, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}

	t.Setenv(EnvFileVar, envPath)
	t.Setenv("SWYPIK_PORT", "5555")

	resetForTesting()
	t.Cleanup(resetForTesting)

	cfg := Load()
	if cfg.ServerPort != 5555 {
		t.Fatalf("expected already-set environment variable to win (5555), got %d", cfg.ServerPort)
	}
}

// resetForTesting clears globalConfig and configOnce so Load can run again.
func resetForTesting() {
	globalConfig = nil
	configOnce = sync.Once{}
}
