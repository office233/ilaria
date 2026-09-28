package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSettingsRoundTripAndDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	s, err := LoadSettings(path)
	if err != nil || s.IlariaURL != DefaultIlariaURL || s.Compute.Contribute {
		t.Fatalf("defaults %+v %v", s, err)
	}
	s.IlariaURL = "https://ilaria.example.azurewebsites.net"
	if err := SaveSettings(path, s); err != nil {
		t.Fatal(err)
	}
	got, err := LoadSettings(path)
	if err != nil || got.IlariaURL != s.IlariaURL {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestSettingsRejectUnsafeValues(t *testing.T) {
	dir := t.TempDir()
	for _, body := range []string{
		`{"ilaria_url":"http://ilaria.example.com"}`,
		`{"ilaria_url":"https://user:pw@x.com"}`,
		`{"ilaria_url":"https://x.com/v1?key=1"}`,
		`{"ilaria_url":"https://x.com","unknown":1}`,
		`{"ilaria_url":"https://x.com","compute":{"contribute":true,"coordinator_url":"http://c.example"}}`,
	} {
		path := filepath.Join(dir, "s.json")
		os.WriteFile(path, []byte(body), 0600)
		if _, err := LoadSettings(path); err == nil {
			t.Errorf("accepted %s", body)
		}
	}
}

func TestResolveTokenPrefersEnvironment(t *testing.T) {
	file := filepath.Join(t.TempDir(), "ilaria.token")
	os.WriteFile(file, []byte("file-token\n"), 0600)
	t.Setenv("ILARIA_API_TOKEN", "")
	if tok, err := ResolveToken(file); err != nil || tok != "file-token" {
		t.Fatalf("%q %v", tok, err)
	}
	t.Setenv("ILARIA_API_TOKEN", "env-token")
	if tok, _ := ResolveToken(file); tok != "env-token" {
		t.Fatal(tok)
	}
	t.Setenv("ILARIA_API_TOKEN", "")
	if tok, err := ResolveToken(filepath.Join(t.TempDir(), "missing")); err != nil || tok != "" {
		t.Fatal("missing token file must mean no token")
	}
}
