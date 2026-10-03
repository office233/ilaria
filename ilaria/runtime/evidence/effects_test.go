package evidence

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"strings"
	"testing"

	effects "ilaria/generated/swypeffects"
)

type testExecution struct {
	request  effects.EffectRequest
	result   effects.EffectResult
	receipt  effects.EffectReceipt
	expected ExpectedExecution
	keys     map[string]TrustedKey
	private  ed25519.PrivateKey
}

func executionFixture(t *testing.T) testExecution {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	execution := testExecution{
		request: effects.EffectRequest{ProtocolVersion: 1, RequestID: "run:1", ModuleHash: strings.Repeat("0", 64),
			Function: "main", Effect: "fs.read", Capability: "workspace_read", Path: "input.txt"},
		result: effects.EffectResult{ProtocolVersion: 1, RequestID: "run:1", Status: "succeeded", ValueType: "bytes", Value: []byte("hello")},
		expected: ExpectedExecution{TaskID: "task:1", NodeID: "node:1", AttemptID: "attempt:1", ExecutorID: "executor:1",
			GrantID: "grant:1", LeaseID: "lease:1", Fence: 7, IntentID: "intent:1"},
		keys: map[string]TrustedKey{"broker-key": {ExecutorID: "executor:1", PublicKey: public}}, private: private,
	}
	execution.receipt = effects.EffectReceipt{ProtocolVersion: 1, RequestID: "run:1", Effect: "fs.read", Capability: "workspace_read",
		TaskID: "task:1", NodeID: "node:1", AttemptID: "attempt:1", ExecutorID: "executor:1", GrantID: "grant:1", LeaseID: "lease:1",
		Fence: 7, IntentID: "intent:1", Status: "succeeded", OccurredAtUnixMS: 1_800_000_000_000,
		PrivacyClass: PrivacyLocalPrivate, SignerKeyID: "broker-key"}
	execution.sign(t)
	return execution
}

func (e *testExecution) sign(t *testing.T) {
	t.Helper()
	var err error
	e.receipt.RequestHash, err = RequestHash(e.request)
	if err != nil {
		t.Fatal(err)
	}
	e.receipt.ResultHash, err = ResultHash(e.result)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := ReceiptSigningBytes(e.receipt)
	if err != nil {
		t.Fatal(err)
	}
	e.receipt.Signature = ed25519.Sign(e.private, canonical)
}

func (e testExecution) verify(t *testing.T) (Observation, error) {
	t.Helper()
	verifier, err := NewVerifier(e.keys)
	if err != nil {
		t.Fatal(err)
	}
	return verifier.Verify(e.request, e.result, e.receipt, e.expected)
}

func TestSharedSwypCanonicalHashVectors(t *testing.T) {
	e := executionFixture(t)
	if e.receipt.RequestHash != "73f691000408f0259248ba9889af60d0ebf73b5958c5751b5d6493896d339cb5" {
		t.Fatalf("Swyp request hash mismatch: %s", e.receipt.RequestHash)
	}
	if e.receipt.ResultHash != "bb3a97c120d0eecd44b5a863ea09afaa1654944736c9157b937318e5be945572" {
		t.Fatalf("Swyp result hash mismatch: %s", e.receipt.ResultHash)
	}
	canonical, err := ReceiptSigningBytes(e.receipt)
	if err != nil || !strings.HasPrefix(string(canonical), ReceiptSignatureDomain) ||
		!strings.HasSuffix(string(canonical), `"signature":null}`) {
		t.Fatalf("canonical receipt domain/signature representation mismatch: %s %v", canonical, err)
	}
	if string(e.receipt.Signature) == "" {
		t.Fatal("canonicalization mutated the caller's signature")
	}
}

func TestVerifiedObservationDoesNotGrantAuthorityOrTrainingRights(t *testing.T) {
	e := executionFixture(t)
	observation, err := e.verify(t)
	if err != nil {
		t.Fatal(err)
	}
	if !observation.Verified || observation.TrainingEligible || observation.Purpose != "execution_evidence_only" ||
		observation.PrivacyClass != PrivacyLocalPrivate || observation.ValueBytes != 5 || observation.Fence != 7 {
		t.Fatalf("unexpected observation: %+v", observation)
	}
	raw, err := json.Marshal(observation)
	if err != nil || strings.Contains(string(raw), "hello") || strings.Contains(string(raw), "input.txt") {
		t.Fatalf("payload/path leaked into observation: %s %v", raw, err)
	}
}

func TestUntrustedRevokedOrWrongExecutorSignerFails(t *testing.T) {
	for _, kind := range []string{"unknown", "revoked", "wrong_executor"} {
		t.Run(kind, func(t *testing.T) {
			e := executionFixture(t)
			switch kind {
			case "unknown":
				e.receipt.SignerKeyID = "self-issued-key"
				e.sign(t)
			case "revoked":
				key := e.keys["broker-key"]
				key.Revoked = true
				e.keys["broker-key"] = key
			case "wrong_executor":
				key := e.keys["broker-key"]
				key.ExecutorID = "other-executor"
				e.keys["broker-key"] = key
			}
			if observation, err := e.verify(t); err == nil || observation.Verified {
				t.Fatal("untrusted signer produced positive evidence", err)
			}
		})
	}
}

func TestVerifierCopiesCallerKeyRegistry(t *testing.T) {
	e := executionFixture(t)
	verifier, err := NewVerifier(e.keys)
	if err != nil {
		t.Fatal(err)
	}
	e.keys["broker-key"].PublicKey[0] ^= 1
	delete(e.keys, "broker-key")
	if _, err := verifier.Verify(e.request, e.result, e.receipt, e.expected); err != nil {
		t.Fatalf("caller mutated immutable trust snapshot: %v", err)
	}
	if _, err := NewVerifier(e.keys); err == nil {
		t.Fatal("empty updated registry accepted")
	}
}

func TestReceiptRejectsEveryChangedExecutionBindingEvenWhenSigned(t *testing.T) {
	changes := map[string]func(*effects.EffectReceipt){
		"version":    func(r *effects.EffectReceipt) { r.ProtocolVersion++ },
		"request":    func(r *effects.EffectReceipt) { r.RequestID = "other-request" },
		"task":       func(r *effects.EffectReceipt) { r.TaskID = "other-task" },
		"node":       func(r *effects.EffectReceipt) { r.NodeID = "other-node" },
		"attempt":    func(r *effects.EffectReceipt) { r.AttemptID = "other-attempt" },
		"executor":   func(r *effects.EffectReceipt) { r.ExecutorID = "other-executor" },
		"grant":      func(r *effects.EffectReceipt) { r.GrantID = "other-grant" },
		"lease":      func(r *effects.EffectReceipt) { r.LeaseID = "other-lease" },
		"fence":      func(r *effects.EffectReceipt) { r.Fence++ },
		"intent":     func(r *effects.EffectReceipt) { r.IntentID = "other-intent" },
		"effect":     func(r *effects.EffectReceipt) { r.Effect = "clock.read" },
		"capability": func(r *effects.EffectReceipt) { r.Capability = "other_capability" },
		"privacy":    func(r *effects.EffectReceipt) { r.PrivacyClass = "public" },
		"time":       func(r *effects.EffectReceipt) { r.OccurredAtUnixMS = 0 },
		"error":      func(r *effects.EffectReceipt) { r.ErrorCode = "failed" },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			e := executionFixture(t)
			change(&e.receipt)
			e.sign(t)
			if observation, err := e.verify(t); err == nil || observation.Verified {
				t.Fatal("signed foreign/stale execution context accepted", err)
			}
		})
	}
}

func TestReceiptRejectsTamperedRequestResultSignatureAndHashes(t *testing.T) {
	for _, kind := range []string{"request", "module", "result", "signature", "short_signature", "request_hash", "result_hash"} {
		t.Run(kind, func(t *testing.T) {
			e := executionFixture(t)
			switch kind {
			case "request":
				e.request.Path = "different.txt"
			case "module":
				e.request.ModuleHash = strings.Repeat("1", 64)
			case "result":
				e.result.Value[0] ^= 1
			case "signature":
				e.receipt.Signature[0] ^= 1
			case "short_signature":
				e.receipt.Signature = e.receipt.Signature[:63]
			case "request_hash":
				e.receipt.RequestHash = strings.Repeat("a", 64)
			case "result_hash":
				e.receipt.ResultHash = strings.Repeat("B", 64)
			}
			if observation, err := e.verify(t); err == nil || observation.Verified {
				t.Fatal("tampering produced positive evidence", err)
			}
		})
	}
}

func TestNegativeAndNonterminalEvidenceNeverBecomesPositiveObservation(t *testing.T) {
	for _, status := range []string{"denied", "failed", "uncertain", "blocked", "started", "prepared", "", "SUCCEEDED"} {
		t.Run(status, func(t *testing.T) {
			e := executionFixture(t)
			e.result.Status, e.receipt.Status = status, status
			e.sign(t)
			if observation, err := e.verify(t); err == nil || observation.Verified {
				t.Fatal("negative/nonterminal receipt became positive evidence", err)
			}
		})
	}
}

func TestRequestAndResultContractBounds(t *testing.T) {
	changes := map[string]func(*testExecution){
		"unicode_id":           func(e *testExecution) { e.request.RequestID = "ș" },
		"oversize_id":          func(e *testExecution) { e.request.RequestID = strings.Repeat("a", MaxIdentifierBytes+1) },
		"oversize_path":        func(e *testExecution) { e.request.Path = strings.Repeat("a", MaxPathBytes+1) },
		"invalid_utf8_path":    func(e *testExecution) { e.request.Path = string([]byte{0xff}) },
		"nul_path":             func(e *testExecution) { e.request.Path = "input\x00.txt" },
		"unsupported_effect":   func(e *testExecution) { e.request.Effect = "fs.write" },
		"invalid_function":     func(e *testExecution) { e.request.Function = "1main" },
		"punctuation_function": func(e *testExecution) { e.request.Function = "main.foo" },
		"invalid_capability":   func(e *testExecution) { e.request.Capability = "Workspace.Read" },
		"invalid_module_hash":  func(e *testExecution) { e.request.ModuleHash = strings.Repeat("A", 64) },
		"oversize_payload":     func(e *testExecution) { e.result.Value = make([]byte, MaxValueBytes+1) },
		"nil_success_payload":  func(e *testExecution) { e.result.Value = nil },
		"wrong_value_type":     func(e *testExecution) { e.result.ValueType = "i64" },
		"result_error":         func(e *testExecution) { e.result.ErrorCode = "not-success" },
		"result_version":       func(e *testExecution) { e.result.ProtocolVersion++ },
		"result_request":       func(e *testExecution) { e.result.RequestID = "other-request" },
		"no_expected_fence":    func(e *testExecution) { e.expected.Fence = 0 },
		"no_expected_task":     func(e *testExecution) { e.expected.TaskID = "" },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			e := executionFixture(t)
			change(&e)
			e.sign(t)
			if observation, err := e.verify(t); err == nil || observation.Verified {
				t.Fatal("invalid wire contract accepted", err)
			}
		})
	}
}

func TestClockResultsMustBeCanonicalNonnegativeI64(t *testing.T) {
	for _, value := range []string{"0", "1800000000000", "00", "+1", "-1", " 1", "1 ", "1.0", "9223372036854775808"} {
		t.Run(value, func(t *testing.T) {
			e := executionFixture(t)
			e.request.Effect, e.receipt.Effect = "clock.read", "clock.read"
			e.request.Path = ""
			e.result.ValueType, e.result.Value = "i64", []byte(value)
			e.sign(t)
			observation, err := e.verify(t)
			valid := value == "0" || value == "1800000000000"
			if (err == nil) != valid || observation.Verified != valid {
				t.Fatalf("clock result %q validity=%v, err=%v", value, valid, err)
			}
		})
	}
}

func TestEmptyFilesystemResultAndOptionalIntentExpectation(t *testing.T) {
	e := executionFixture(t)
	e.result.Value = []byte{}
	e.expected.IntentID = ""
	e.sign(t)
	if observation, err := e.verify(t); err != nil || observation.ValueBytes != 0 || !observation.Verified {
		t.Fatal("empty file result rejected", err)
	}
}

func TestNoTrustAndMalformedPublicKeyFailClosed(t *testing.T) {
	e := executionFixture(t)
	key := e.keys["broker-key"]
	key.PublicKey = key.PublicKey[:31]
	if _, err := NewVerifier(map[string]TrustedKey{"broker-key": key}); err == nil {
		t.Fatal("malformed public key accepted")
	}
	var absent *Verifier
	if observation, err := absent.Verify(e.request, e.result, e.receipt, e.expected); err == nil || observation.Verified {
		t.Fatal("missing trust accepted")
	}
}
