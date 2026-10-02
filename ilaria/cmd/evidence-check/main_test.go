package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	effects "ilaria/generated/swypeffects"
	"ilaria/runtime/evidence"
)

type cliFixture struct {
	request  effects.EffectRequest
	result   effects.EffectResult
	receipt  effects.EffectReceipt
	expected evidence.ExpectedExecution
	registry evidence.TrustRegistry
	private  ed25519.PrivateKey
}

func newFixture(t testing.TB) cliFixture {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	fixture := cliFixture{
		request: effects.EffectRequest{ProtocolVersion: 1, RequestID: "request:1", ModuleHash: strings.Repeat("0", 64),
			Function: "main", Effect: "fs.read", Capability: "workspace_read", Path: "private-input.txt"},
		result: effects.EffectResult{ProtocolVersion: 1, RequestID: "request:1", Status: "succeeded", ValueType: "bytes", Value: []byte("private payload")},
		expected: evidence.ExpectedExecution{TaskID: "task:1", NodeID: "node:1", AttemptID: "attempt:1",
			ExecutorID: "executor:1", GrantID: "grant:1", LeaseID: "lease:1", Fence: 3},
		registry: evidence.TrustRegistry{Format: evidence.TrustRegistryFormat, Keys: map[string]evidence.TrustedKey{
			"key:1": {ExecutorID: "executor:1", PublicKey: public},
		}}, private: private,
	}
	fixture.receipt = effects.EffectReceipt{ProtocolVersion: 1, RequestID: "request:1", Effect: "fs.read", Capability: "workspace_read",
		TaskID: "task:1", NodeID: "node:1", AttemptID: "attempt:1", ExecutorID: "executor:1", GrantID: "grant:1", LeaseID: "lease:1",
		Fence: 3, IntentID: "intent:1", Status: "succeeded", OccurredAtUnixMS: 1_800_000_000_000,
		PrivacyClass: evidence.PrivacyLocalPrivate, SignerKeyID: "key:1"}
	fixture.sign(t)
	return fixture
}

func (fixture *cliFixture) sign(t testing.TB) {
	t.Helper()
	var err error
	fixture.receipt.RequestHash, err = evidence.RequestHash(fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	fixture.receipt.ResultHash, err = evidence.ResultHash(fixture.result)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := evidence.ReceiptSigningBytes(fixture.receipt)
	if err != nil {
		t.Fatal(err)
	}
	fixture.receipt.Signature = ed25519.Sign(fixture.private, canonical)
}

func (fixture cliFixture) write(t testing.TB) ([]string, map[string]string) {
	t.Helper()
	directory := t.TempDir()
	paths := make(map[string]string)
	var args []string
	for _, input := range []struct {
		name  string
		value any
	}{
		{"request", fixture.request}, {"result", fixture.result}, {"receipt", fixture.receipt},
		{"expected", fixture.expected}, {"keys", fixture.registry},
	} {
		raw, err := json.Marshal(input.value)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(directory, input.name+".json")
		if err := os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
		paths[input.name] = path
		args = append(args, "--"+input.name, path)
	}
	return args, paths // Only public configuration and signed envelopes reach disk.
}

func replaceEnvelope(t *testing.T, path, old, new string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	modified := strings.Replace(string(raw), old, new, 1)
	if modified == string(raw) {
		t.Fatalf("replacement did not match %q", old)
	}
	if err := os.WriteFile(path, []byte(modified), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestCLIProducesOnlyVerifiedBoundedExecutionObservation(t *testing.T) {
	args, _ := newFixture(t).write(t)
	var output bytes.Buffer
	if err := run(args, &output); err != nil {
		t.Fatal(err)
	}
	var observation evidence.Observation
	if err := evidence.DecodeStrict(output.Bytes(), &observation); err != nil {
		t.Fatal(err)
	}
	if !observation.Verified || observation.TrainingEligible || observation.Fence != 3 || observation.ValueBytes != len("private payload") {
		t.Fatalf("unexpected observation %+v", observation)
	}
	if strings.Contains(output.String(), "private-input") || strings.Contains(output.String(), "private payload") {
		t.Fatal("observation leaked private input path or result")
	}
}

func TestCLIRejectsUntrustedOrTamperedEvidenceWithoutOutput(t *testing.T) {
	cases := map[string]func(*cliFixture){
		"unknown_signer": func(f *cliFixture) { f.receipt.SignerKeyID = "self-issued"; f.sign(t) },
		"revoked": func(f *cliFixture) {
			key := f.registry.Keys["key:1"]
			key.Revoked = true
			f.registry.Keys["key:1"] = key
		},
		"wrong_executor": func(f *cliFixture) {
			key := f.registry.Keys["key:1"]
			key.ExecutorID = "different"
			f.registry.Keys["key:1"] = key
		},
		"wrong_fence":       func(f *cliFixture) { f.expected.Fence++ },
		"wrong_lease":       func(f *cliFixture) { f.expected.LeaseID = "previous-lease" },
		"altered_result":    func(f *cliFixture) { f.result.Value = []byte("tampered") },
		"altered_signature": func(f *cliFixture) { f.receipt.Signature[0] ^= 1 },
		"nonterminal":       func(f *cliFixture) { f.result.Status = "started"; f.receipt.Status = "started"; f.sign(t) },
		"denied":            func(f *cliFixture) { f.result.Status = "denied"; f.receipt.Status = "denied"; f.sign(t) },
		"wrong_registry":    func(f *cliFixture) { f.registry.Format = "unversioned" },
		"nil_success_value": func(f *cliFixture) { f.result.Value = nil; f.sign(t) },
		"oversized_decoded": func(f *cliFixture) { f.result.Value = make([]byte, evidence.MaxValueBytes+1); f.sign(t) },
		"no_expected_fence": func(f *cliFixture) { f.expected.Fence = 0 },
		"no_expected_task":  func(f *cliFixture) { f.expected.TaskID = "" },
	}
	for name, modify := range cases {
		t.Run(name, func(t *testing.T) {
			fixture := newFixture(t)
			modify(&fixture)
			args, _ := fixture.write(t)
			var output bytes.Buffer
			if err := run(args, &output); err == nil || output.Len() != 0 {
				t.Fatalf("invalid evidence accepted or produced output: %v %s", err, output.String())
			}
		})
	}
}

func TestCLIRejectsAmbiguousJSONAndNonregularInputs(t *testing.T) {
	cases := map[string]func(map[string]string){
		"request_alias": func(paths map[string]string) {
			replaceEnvelope(t, paths["request"], `"request_id"`, `"Request_ID"`)
		},
		"duplicate_expected_fence": func(paths map[string]string) {
			replaceEnvelope(t, paths["expected"], `"fence":3`, `"fence":3,"fence":3`)
		},
		"missing_required_path": func(paths map[string]string) {
			replaceEnvelope(t, paths["request"], `,"path":"private-input.txt"`, "")
		},
		"null_expected_fence": func(paths map[string]string) {
			replaceEnvelope(t, paths["expected"], `"fence":3`, `"fence":null`)
		},
		"null_empty_error_code": func(paths map[string]string) {
			replaceEnvelope(t, paths["receipt"], `"error_code":""`, `"error_code":null`)
		},
		"lossy_unicode": func(paths map[string]string) {
			replaceEnvelope(t, paths["request"], `"private-input.txt"`, `"\ud800"`)
		},
		"numeric_byte_array": func(paths map[string]string) {
			replaceEnvelope(t, paths["result"], `"value":"cHJpdmF0ZSBwYXlsb2Fk"`, `"value":[1,2,3]`)
		},
		"trailing_document": func(paths map[string]string) {
			file, err := os.OpenFile(paths["receipt"], os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			if _, err := file.WriteString("{}"); err != nil {
				t.Fatal(err)
			}
		},
		"small_envelope_bound": func(paths map[string]string) {
			if err := os.WriteFile(paths["expected"], bytes.Repeat([]byte{' '}, maxSmallEnvelopeBytes+1), 0600); err != nil {
				t.Fatal(err)
			}
		},
		"nonregular": func(paths map[string]string) {
			if err := os.Remove(paths["expected"]); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(paths["expected"], 0700); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, modify := range cases {
		t.Run(name, func(t *testing.T) {
			args, paths := newFixture(t).write(t)
			modify(paths)
			var output bytes.Buffer
			if err := run(args, &output); err == nil || output.Len() != 0 {
				t.Fatalf("ambiguous/nonregular envelope accepted: %v %s", err, output.String())
			}
		})
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("output unavailable") }

func TestCLIRequiresAllIndependentInputsAndPropagatesOutputErrors(t *testing.T) {
	args, _ := newFixture(t).write(t)
	for _, invalid := range [][]string{nil, args[:len(args)-2], append(append([]string{}, args...), "extra"), {"--unknown"}} {
		if err := run(invalid, &bytes.Buffer{}); err == nil {
			t.Fatal("missing or invalid CLI arguments accepted")
		}
	}
	if err := run(args, failingWriter{}); err == nil || !strings.Contains(err.Error(), "output unavailable") {
		t.Fatal("output error was swallowed", err)
	}
}
