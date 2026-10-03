package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"swypik-os/core/effects"
	wire "swypik-os/generated/swypeffects"
)

func writeFixtureConfig(t *testing.T, dir string, requests []wire.EffectRequest) (string, hostConfig) {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	config := hostConfig{Journal: filepath.Join(dir, "journal.jsonl"), ExecutorID: "fixture-executor", ExecutorCredential: "temporary-fixture-credential",
		SignerKeyID: "fixture-key", SignerPrivateKey: key, Roots: map[string]string{"fixture": dir}}
	for index, request := range requests {
		hash, err := effects.RequestHash(request)
		if err != nil {
			t.Fatal(err)
		}
		config.Grants = append(config.Grants, hostGrant{GrantID: request.RequestID + ":grant", RequestID: request.RequestID, RequestHash: hash,
			Effect: request.Effect, Capability: request.Capability, TaskID: "fixture-task", NodeID: request.RequestID + ":node",
			RootID: "fixture", MaxBytes: int64(100 + index), ExpiresAtUnixMS: time.Now().Add(time.Hour).UnixMilli()})
	}
	path := filepath.Join(dir, "host-config.json")
	writeConfig(t, path, config)
	return path, config
}

func writeConfig(t *testing.T, path string, config hostConfig) {
	t.Helper()
	raw, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestJSONLAdapterTwoNodesSignedEvidenceAndRestartBlock(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "input.txt"), []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	requests := []wire.EffectRequest{
		{ProtocolVersion: 1, RequestID: "read:1", ModuleHash: strings.Repeat("0", 64), Function: "main", Effect: "fs.read", Capability: "workspace_read", Path: "input.txt"},
		{ProtocolVersion: 1, RequestID: "clock:1", ModuleHash: strings.Repeat("0", 64), Function: "main", Effect: "clock.read", Capability: "clock_read", Path: ""},
	}
	configPath, config := writeFixtureConfig(t, dir, requests)
	var input bytes.Buffer
	for _, request := range requests {
		if err := json.NewEncoder(&input).Encode(request); err != nil {
			t.Fatal(err)
		}
	}
	for runIndex := 0; runIndex < 2; runIndex++ {
		var output bytes.Buffer
		if err := run(configPath, bytes.NewReader(input.Bytes()), &output); err != nil {
			t.Fatal(err)
		}
		lines := bytes.Split(bytes.TrimSpace(output.Bytes()), []byte("\n"))
		if len(lines) != len(requests) {
			t.Fatalf("output envelope count=%d", len(lines))
		}
		for index, line := range lines {
			var result envelope
			if err := effects.DecodeStrict(line, &result); err != nil {
				t.Fatal(err)
			}
			status := "succeeded"
			if runIndex > 0 {
				status = "blocked"
			}
			if result.Result.Status != status || result.Expected.NodeID != config.Grants[index].NodeID || result.Expected.ExecutorID != config.ExecutorID || result.Expected.Fence == 0 {
				t.Fatalf("run=%d result=%+v", runIndex, result)
			}
			if runIndex == 0 && index == 0 && string(result.Result.Value) != "hello" {
				t.Fatalf("read value=%q", result.Result.Value)
			}
			signed, _ := effects.ReceiptSigningBytes(result.Receipt)
			key := ed25519.PrivateKey(config.SignerPrivateKey).Public().(ed25519.PublicKey)
			if !ed25519.Verify(key, signed, result.Receipt.Signature) {
				t.Fatal("CLI receipt signature invalid")
			}
		}
	}
}

func TestInvalidHostConfigCannotCreateJournal(t *testing.T) {
	request := wire.EffectRequest{ProtocolVersion: 1, RequestID: "read:1", ModuleHash: strings.Repeat("0", 64), Function: "main", Effect: "fs.read", Capability: "workspace_read", Path: "input.txt"}
	for _, invalid := range []string{"oversize", "identity", "duplicate", "signature", "expired", "hash"} {
		t.Run(invalid, func(t *testing.T) {
			dir := t.TempDir()
			path, config := writeFixtureConfig(t, dir, []wire.EffectRequest{request})
			switch invalid {
			case "oversize":
				config.Grants[0].MaxBytes = effects.MaxValueBytes + 1
			case "identity":
				config.ExecutorID = "invalid executor"
			case "duplicate":
				config.Grants = append(config.Grants, config.Grants[0])
			case "signature":
				config.SignerPrivateKey[63] ^= 1
			case "expired":
				config.Grants[0].ExpiresAtUnixMS = time.Now().Add(-time.Second).UnixMilli()
			case "hash":
				config.Grants[0].RequestHash = "invalid"
			}
			writeConfig(t, path, config)
			if err := run(path, strings.NewReader(""), &bytes.Buffer{}); err == nil {
				t.Fatal("invalid host configuration accepted")
			}
			if _, err := os.Stat(config.Journal); !os.IsNotExist(err) {
				t.Fatalf("invalid host configuration wrote journal: %v", err)
			}
		})
	}
}

func TestJSONLAdapterRejectsAmbiguousGuestFields(t *testing.T) {
	request := wire.EffectRequest{ProtocolVersion: 1, RequestID: "clock:1", ModuleHash: strings.Repeat("0", 64), Function: "main", Effect: "clock.read", Capability: "clock_read", Path: ""}
	path, _ := writeFixtureConfig(t, t.TempDir(), []wire.EffectRequest{request})
	raw, _ := json.Marshal(request)
	for _, invalid := range []string{
		strings.Replace(string(raw), `"path":""`, `"path":"","path":""`, 1),
		strings.Replace(string(raw), `"path":""`, `"Path":""`, 1),
		strings.Replace(string(raw), `,"path":""`, ``, 1),
	} {
		var output bytes.Buffer
		if err := run(path, strings.NewReader(invalid+"\n"), &output); err == nil || output.Len() != 0 {
			t.Fatalf("ambiguous input emitted evidence: len=%d err=%v", output.Len(), err)
		}
	}
}
