package effects

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"strings"
	"testing"
)

func fixtureRequest() EffectRequest {
	return EffectRequest{Version, "run:1", strings.Repeat("0", 64), "main", "fs.read", "workspace_read", "input.txt"}
}

func TestCanonicalReceiptBinding(t *testing.T) {
	request := fixtureRequest()
	result := EffectResult{Version, "run:1", "succeeded", "bytes", []byte("hello"), ""}
	requestHash, err := RequestHash(request)
	if err != nil {
		t.Fatal(err)
	}
	resultHash, err := ResultHash(result)
	if err != nil {
		t.Fatal(err)
	}
	// These externally computed hashes freeze field order and base64 encoding.
	if requestHash != "73f691000408f0259248ba9889af60d0ebf73b5958c5751b5d6493896d339cb5" || resultHash != "bb3a97c120d0eecd44b5a863ea09afaa1654944736c9157b937318e5be945572" {
		t.Fatalf("canonical hashes changed: %s %s", requestHash, resultHash)
	}
	receipt := EffectReceipt{ProtocolVersion: Version, RequestID: request.RequestID,
		RequestHash: requestHash, ResultHash: resultHash, Effect: request.Effect, Capability: request.Capability,
		TaskID: "task", NodeID: "node", AttemptID: "attempt", ExecutorID: "executor", GrantID: "grant",
		LeaseID: "lease", Fence: 7, IntentID: "intent", Status: "succeeded", OccurredAtUnixMS: 1,
		PrivacyClass: "local_private", SignerKeyID: "test-key"}
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x42}, ed25519.SeedSize))
	payload, err := ReceiptSigningBytes(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(payload, []byte(ReceiptDomain)) || !bytes.HasSuffix(payload, []byte(`"signature":null}`)) {
		t.Fatalf("unexpected canonical receipt: %s", payload)
	}
	receipt.Signature = ed25519.Sign(key, payload)
	same, err := ReceiptSigningBytes(receipt)
	if err != nil || !bytes.Equal(payload, same) {
		t.Fatal("signature must be excluded from canonical payload")
	}
	if !ed25519.Verify(key.Public().(ed25519.PublicKey), same, receipt.Signature) {
		t.Fatal("receipt signature failed")
	}
	receipt.Fence++
	tampered, _ := ReceiptSigningBytes(receipt)
	if ed25519.Verify(key.Public().(ed25519.PublicKey), tampered, receipt.Signature) {
		t.Fatal("signature accepted a changed execution epoch")
	}
	result.Status, result.ErrorCode, result.Value = "denied", "grant_denied", nil
	changedHash, _ := ResultHash(result)
	if changedHash == resultHash {
		t.Fatal("result hash did not bind status/error/value")
	}
}

func TestDecodeRequestRejectsAmbiguousOrUnboundedWire(t *testing.T) {
	good, _ := json.Marshal(fixtureRequest())
	if _, err := DecodeRequest(good); err != nil {
		t.Fatal(err)
	}
	cases := map[string][]byte{
		"duplicate":      bytes.Replace(good, []byte(`"path":"input.txt"`), []byte(`"path":"input.txt","path":"other.txt"`), 1),
		"alias":          bytes.Replace(good, []byte(`"request_id"`), []byte(`"REQUEST_ID"`), 1),
		"unicode_alias":  bytes.Replace(good, []byte(`"effect"`), []byte(`"eﬀect"`), 1),
		"missing":        bytes.Replace(good, []byte(`,"path":"input.txt"`), nil, 1),
		"unknown":        bytes.Replace(good, []byte(`"path":"input.txt"`), []byte(`"path":"input.txt","lease_id":"guest-token"`), 1),
		"null":           bytes.Replace(good, []byte(`"path":"input.txt"`), []byte(`"path":null`), 1),
		"high_surrogate": bytes.Replace(good, []byte(`"path":"input.txt"`), []byte(`"path":"\ud800"`), 1),
		"low_surrogate":  bytes.Replace(good, []byte(`"path":"input.txt"`), []byte(`"path":"\udc00"`), 1),
		"trailing":       append(append([]byte{}, good...), []byte(` {}`)...),
		"invalid_utf8":   append(append([]byte{}, good...), 0xff),
		"oversized":      bytes.Repeat([]byte(" "), MaxMessageBytes+1),
		"wrong_version":  bytes.Replace(good, []byte(`"protocol_version":1`), []byte(`"protocol_version":2`), 1),
		"uppercase_hash": bytes.Replace(good, []byte(strings.Repeat("0", 64)), []byte(strings.Repeat("A", 64)), 1),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodeRequest(data); err == nil {
				t.Fatal("accepted malformed request")
			}
		})
	}
}

func TestRequestUnicodeHasLosslessCanonicalEncoding(t *testing.T) {
	request := fixtureRequest()
	request.Path = "資料/<&>😀.txt"
	raw, _ := json.Marshal(request)
	decoded, err := DecodeRequest(raw)
	if err != nil || decoded != request {
		t.Fatalf("Unicode roundtrip failed: %+v %v", decoded, err)
	}
	paired := bytes.Replace(raw, []byte("😀"), []byte(`\ud83d\ude00`), 1)
	decoded, err = DecodeRequest(paired)
	if err != nil || decoded != request {
		t.Fatalf("valid surrogate pair rejected: %+v %v", decoded, err)
	}
	request.Path = `literal\ud800.txt`
	raw, _ = json.Marshal(request)
	decoded, err = DecodeRequest(raw)
	if err != nil || decoded != request {
		t.Fatal("literal backslash-u text must not be treated as a surrogate")
	}
}

func TestResultCorrelationAndType(t *testing.T) {
	r := fixtureRequest()
	good := EffectResult{Version, r.RequestID, "succeeded", "bytes", []byte("hello"), ""}
	if err := ValidateResult(good, r); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*EffectResult){
		func(v *EffectResult) { v.RequestID = "run:2" },
		func(v *EffectResult) { v.ProtocolVersion++ },
		func(v *EffectResult) { v.ValueType = "i64" },
		func(v *EffectResult) { v.Status = "pending" },
		func(v *EffectResult) { v.ErrorCode = "unexpected_error" },
		func(v *EffectResult) { v.Value = nil },
		func(v *EffectResult) { v.Value = make([]byte, MaxValueBytes+1) },
		func(v *EffectResult) { v.Status = "denied" },
	} {
		bad := good
		mutate(&bad)
		if err := ValidateResult(bad, r); err == nil {
			t.Fatalf("accepted invalid result: %+v", bad)
		}
	}
	for _, status := range []string{"denied", "failed", "uncertain", "blocked"} {
		bad := EffectResult{Version, r.RequestID, status, "bytes", nil, "grant_denied"}
		if err := ValidateResult(bad, r); err != nil {
			t.Fatal(err)
		}
	}
	r.Effect, r.Capability, r.Path = "clock.read", "clock_read", ""
	for _, value := range []string{"0", "1700000000000"} {
		if err := ValidateResult(EffectResult{Version, r.RequestID, "succeeded", "i64", []byte(value), ""}, r); err != nil {
			t.Fatal(err)
		}
	}
	for _, value := range []string{"-1", "+1", "01", "1.0", " 1", "9223372036854775808"} {
		if err := ValidateResult(EffectResult{Version, r.RequestID, "succeeded", "i64", []byte(value), ""}, r); err == nil {
			t.Fatalf("accepted noncanonical clock %q", value)
		}
	}
	encoded, _ := json.Marshal(good)
	if _, err := DecodeResult(encoded); err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeResult(bytes.Replace(encoded, []byte(`"value_type"`), []byte(`"Value_Type"`), 1)); err == nil {
		t.Fatal("accepted a result field alias")
	}
	for _, malformed := range []string{`[104,101,108,108,111]`, `"aGVs\nbG8="`, `"aGVsbG9="`} {
		if _, err := DecodeResult(bytes.Replace(encoded, []byte(`"aGVsbG8="`), []byte(malformed), 1)); err == nil {
			t.Fatalf("accepted noncanonical base64 value %s", malformed)
		}
	}
}

func TestContinuationCheckpointAndAckAreStrictlyCorrelated(t *testing.T) {
	continuation := []byte("{\"version\":1,\"frames\":[{\"function\":\"main\"}]}")
	hash, err := ContinuationHash(continuation)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint := ContinuationCheckpoint{
		ProtocolVersion:  Version,
		RunID:            "run-1",
		ModuleHash:       strings.Repeat("a", 64),
		EffectSequence:   3,
		ContinuationHash: hash,
		Continuation:     continuation,
	}
	if err := ValidateContinuationCheckpoint(checkpoint); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeContinuationCheckpoint(raw)
	if err != nil || !bytes.Equal(decoded.Continuation, continuation) || decoded.ContinuationHash != hash {
		t.Fatalf("checkpoint roundtrip=%+v err=%v", decoded, err)
	}
	ack := ContinuationAck{
		ProtocolVersion: Version,
		RunID:           checkpoint.RunID, ModuleHash: checkpoint.ModuleHash,
		EffectSequence: checkpoint.EffectSequence, ContinuationHash: checkpoint.ContinuationHash,
		Status: "accepted",
	}
	if err := ValidateContinuationAck(ack, checkpoint); err != nil {
		t.Fatal(err)
	}
	ackRaw, _ := json.Marshal(ack)
	if _, err := DecodeContinuationAck(ackRaw); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*ContinuationAck){
		"run":      func(a *ContinuationAck) { a.RunID = "run-2" },
		"module":   func(a *ContinuationAck) { a.ModuleHash = strings.Repeat("b", 64) },
		"sequence": func(a *ContinuationAck) { a.EffectSequence++ },
		"hash":     func(a *ContinuationAck) { a.ContinuationHash = strings.Repeat("c", 64) },
	} {
		t.Run(name, func(t *testing.T) {
			bad := ack
			mutate(&bad)
			if err := ValidateContinuationAck(bad, checkpoint); err == nil {
				t.Fatal("mismatched acknowledgement accepted")
			}
		})
	}
}

func TestContinuationCheckpointRejectsTamperingAndAmbiguousWire(t *testing.T) {
	continuation := []byte("checkpoint-state")
	hash, _ := ContinuationHash(continuation)
	checkpoint := ContinuationCheckpoint{
		ProtocolVersion: Version, RunID: "run:checkpoint", ModuleHash: strings.Repeat("0", 64),
		EffectSequence: 1, ContinuationHash: hash, Continuation: continuation,
	}
	good, _ := json.Marshal(checkpoint)
	for name, data := range map[string][]byte{
		"duplicate": bytes.Replace(good, []byte("\"effect_sequence\":1"), []byte("\"effect_sequence\":1,\"effect_sequence\":2"), 1),
		"unknown":   bytes.Replace(good, []byte("\"run_id\":\"run:checkpoint\""), []byte("\"run_id\":\"run:checkpoint\",\"lease_id\":\"forged\""), 1),
		"null":      bytes.Replace(good, []byte("\"continuation\":\"Y2hlY2twb2ludC1zdGF0ZQ==\""), []byte("\"continuation\":null"), 1),
		"trailing":  append(append([]byte(nil), good...), []byte(" {}")...),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodeContinuationCheckpoint(data); err == nil {
				t.Fatal("malformed checkpoint accepted")
			}
		})
	}
	badHash := checkpoint
	badHash.ContinuationHash = strings.Repeat("f", 64)
	if err := ValidateContinuationCheckpoint(badHash); err == nil {
		t.Fatal("tampered continuation hash accepted")
	}
	oversized := checkpoint
	oversized.Continuation = make([]byte, MaxContinuationBytes+1)
	if err := ValidateContinuationCheckpoint(oversized); err == nil {
		t.Fatal("oversized continuation accepted")
	}
	if _, err := DecodeContinuationCheckpoint(bytes.Repeat([]byte(" "), MaxContinuationMessageBytes+1)); err == nil {
		t.Fatal("oversized continuation message accepted")
	}
	rejected := ContinuationAck{
		ProtocolVersion: Version, RunID: checkpoint.RunID, ModuleHash: checkpoint.ModuleHash,
		EffectSequence: checkpoint.EffectSequence, ContinuationHash: checkpoint.ContinuationHash,
		Status: "rejected", ErrorCode: "durability_failed",
	}
	if err := ValidateContinuationAck(rejected, checkpoint); err != nil {
		t.Fatal(err)
	}
	rejected.ErrorCode = ""
	if err := ValidateContinuationAck(rejected, checkpoint); err == nil {
		t.Fatal("rejected acknowledgement without error accepted")
	}
}
