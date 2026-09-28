package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnvFilePreservesExplicitEmptyValues(t *testing.T) {
	t.Setenv("SWYPIK_TEST_EXPLICIT", "")
	p := filepath.Join(t.TempDir(), "config.env")
	if err := os.WriteFile(p, []byte("SWYPIK_TEST_EXPLICIT=should-not-replace\n"), 0600); err != nil {
		t.Fatal(err)
	}
	loadEnvFile(p)
	if os.Getenv("SWYPIK_TEST_EXPLICIT") != "" {
		t.Fatal("explicit environment was overwritten")
	}
}

func TestNonFiniteFloatFallsBack(t *testing.T) {
	for _, value := range []string{"NaN", "+Inf", "-Inf", "invalid"} {
		t.Setenv("SWYPIK_TEST_FLOAT", value)
		if got := GetFloat("SWYPIK_TEST_FLOAT", 0.25); got != 0.25 {
			t.Fatalf("accepted %q", value)
		}
	}
}
