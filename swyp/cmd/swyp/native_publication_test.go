package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// A subprocess of the test binary stands in for a compiler. This covers failed
// and racing builds even on machines without GCC.
func TestNativePublicationCompilerHelper(t *testing.T) {
	mode := os.Getenv("SWYP_PUBLICATION_COMPILER_HELPER")
	if mode == "" {
		return
	}
	output := os.Args[len(os.Args)-1]
	if err := os.WriteFile(output, []byte("compiled executable"), 0o700); err != nil {
		os.Exit(4)
	}
	if mode == "fail" {
		os.Exit(3)
	}
	if mode == "race" {
		if err := os.WriteFile(os.Getenv("SWYP_PUBLICATION_DESTINATION"), []byte("user file"), 0o600); err != nil {
			os.Exit(5)
		}
	}
	os.Exit(0)
}

func TestNativeCompilerPublishesExclusively(t *testing.T) {
	for _, mode := range []string{"success", "fail", "race", "exists"} {
		t.Run(mode, func(t *testing.T) {
			destination := filepath.Join(t.TempDir(), "program.exe")
			t.Setenv("SWYP_PUBLICATION_COMPILER_HELPER", mode)
			t.Setenv("SWYP_PUBLICATION_DESTINATION", destination)
			if mode == "exists" {
				if err := os.WriteFile(destination, []byte("user file"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			_, err := runNativeCompilerExclusive(os.Args[0], destination, "-test.run=^TestNativePublicationCompilerHelper$", "--")
			if (err == nil) != (mode == "success") {
				t.Fatalf("mode=%s err=%v", mode, err)
			}
			got, readErr := os.ReadFile(destination)
			switch mode {
			case "fail":
				if !os.IsNotExist(readErr) {
					t.Fatalf("failed compiler left destination: content=%q err=%v", got, readErr)
				}
			case "race", "exists":
				if readErr != nil || !bytes.Equal(got, []byte("user file")) {
					t.Fatalf("existing destination modified: content=%q err=%v", got, readErr)
				}
			case "success":
				if readErr != nil || !bytes.Equal(got, []byte("compiled executable")) {
					t.Fatalf("compiled destination missing: content=%q err=%v", got, readErr)
				}
			}
		})
	}
}
