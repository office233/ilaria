//go:build linux

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"swypik-os/internal/planprocess"
)

func TestOpenEngineRejectsNonCgroupBeforeOpeningKernel(t *testing.T) {
	directory := t.TempDir()
	fakeRoot := filepath.Join(directory, "fake-cgroup")
	if err := os.Mkdir(fakeRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{
		"cgroup.controllers":     "cpu memory pids\n",
		"cgroup.subtree_control": "cpu memory pids\n",
	} {
		if err := os.WriteFile(filepath.Join(fakeRoot, name), []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	config := configuration{
		Version:            2,
		Journal:            filepath.Join(directory, "kernel.journal"),
		LedgerDirectory:    filepath.Join(directory, "ledgers"),
		SwypExecutable:     executable,
		VerifierExecutable: executable,
		TrustRegistry:      filepath.Join(directory, "trust.json"),
		ExecutorID:         "executor",
		ExecutorCredential: "executor-credential",
		VerifierID:         "verifier",
		VerifierCredential: "verifier-credential",
		SignerKeyID:        "ephemeral-test-key",
		PrivateKey:         private,
		Roots:              map[string]string{},
		Profile:            "performance",
		DeviceClass:        "workstation",
		CPUTimeMS:          5000,
		RSSLimitBytes:      128 << 20,
		SampleIntervalMS:   20,
		KernelCPUPercent:   25,
		KernelMemoryBytes:  512 << 20,
		KernelMaxProcesses: 16,
		LinuxCgroupRoot:    fakeRoot,
		Plans: []configuredPlan{{
			ID:               "plan",
			TaskID:           "task",
			RunID:            "run",
			Source:           filepath.Join(directory, "plan.swyp"),
			Entry:            "main",
			Deadline:         time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano),
			MaxEffects:       1,
			Fuel:             1,
			MaxReturnedBytes: 1,
			WallTimeMS:       1000,
		}},
	}
	policy, err := validateConfiguration(config)
	if err != nil {
		t.Fatalf("fixture config rejected before containment test: %v", err)
	}
	engine, err := openEngine(context.Background(), config, policy)
	if engine != nil {
		_ = engine.Close()
		t.Fatal("engine opened with a non-cgroup containment root")
	}
	if !errors.Is(err, planprocess.ErrKernelLimitsUnavailable) {
		t.Fatalf("containment failure was not surfaced: %v", err)
	}
	for _, path := range []string{config.Journal, config.LedgerDirectory} {
		if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("authority state was created before strict containment: %s: %v", path, statErr)
		}
	}
}
