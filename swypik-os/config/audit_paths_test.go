package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBrowserDiscoveryDoesNotInventAnInstallation(t *testing.T) {
	t.Setenv("SWYPIK_TEST_BROWSER", "")
	t.Setenv("SWYPIK_TEST_PROGRAM_FILES", filepath.Join(t.TempDir(), "missing"))
	if got := browserPath("SWYPIK_TEST_BROWSER", []string{"swypik-nonexistent-browser"},
		"SWYPIK_TEST_PROGRAM_FILES", "browser.exe"); got != "" {
		t.Fatalf("invented browser installation: %s", got)
	}
	root := t.TempDir()
	path := filepath.Join(root, "browser.exe")
	if err := os.WriteFile(path, []byte("test fixture; never executed"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SWYPIK_TEST_PROGRAM_FILES", root)
	if got := browserPath("SWYPIK_TEST_BROWSER", nil, "SWYPIK_TEST_PROGRAM_FILES", "browser.exe"); got != path {
		t.Fatalf("did not discover configured installation: %s", got)
	}
	t.Setenv("SWYPIK_TEST_BROWSER", "caller-supplied")
	if got := browserPath("SWYPIK_TEST_BROWSER", nil, "SWYPIK_TEST_PROGRAM_FILES", "browser.exe"); got != "caller-supplied" {
		t.Fatal("explicit browser configuration lost precedence")
	}
}
