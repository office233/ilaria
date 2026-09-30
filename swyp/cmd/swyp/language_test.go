package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"swyp-lang/internal/swyplang"
)

func TestLanguageManifestAndAIPromptStayAligned(t *testing.T) {
	m := currentLanguageManifest()
	if m.Version != swypLanguageVersion {
		t.Fatalf("manifest version %q != compiler version %q", m.Version, swypLanguageVersion)
	}
	prompt := draftInstructions()
	if !strings.Contains(prompt, swypLanguageVersion) {
		t.Fatalf("AI prompt does not contain current compiler version %q", swypLanguageVersion)
	}
	if strings.Contains(prompt, "Swyp Lang 0.2") {
		t.Fatal("AI prompt still advertises obsolete Swyp 0.2")
	}
	var out bytes.Buffer
	if err := languageManifestCommand(&out); err != nil {
		t.Fatal(err)
	}
	var decoded languageManifest
	if err := json.Unmarshal(out.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Version != swypLanguageVersion || decoded.DraftSurface != "legacy-scalar" {
		t.Fatalf("unexpected manifest: %+v", decoded)
	}
	if decoded.DiagnosticSchemaVersion != swyplang.DiagnosticSchemaVersion {
		t.Fatalf("diagnostic schema version=%d want=%d", decoded.DiagnosticSchemaVersion, swyplang.DiagnosticSchemaVersion)
	}
	wantCodes := swyplang.CanonicalDiagnosticCodes()
	if len(decoded.DiagnosticCodes) != len(wantCodes) {
		t.Fatalf("diagnostic codes=%v want=%v", decoded.DiagnosticCodes, wantCodes)
	}
	for i := range wantCodes {
		if decoded.DiagnosticCodes[i] != wantCodes[i] {
			t.Fatalf("diagnostic code[%d]=%q want=%q", i, decoded.DiagnosticCodes[i], wantCodes[i])
		}
	}
}

func TestConfiguredIlariaBackendUsesEnvironment(t *testing.T) {
	t.Setenv("SWYP_ILARIA_ENDPOINT", "http://127.0.0.1:18091")
	t.Setenv("SWYP_ILARIA_TOKEN", "")
	backend, name := configuredIlariaBackend()
	if backend == nil || !strings.Contains(name, "configured endpoint") {
		t.Fatalf("backend=%T name=%q", backend, name)
	}
}
