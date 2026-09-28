package config

import (
	"os"
	"path/filepath"
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
