package effects

import (
	"crypto/ed25519"
	"encoding/json"
	"strings"
	"testing"

	wire "swypik-os/generated/swypeffects"
)

func TestCanonicalWireGoldenHashes(t *testing.T) {
	request := wire.EffectRequest{ProtocolVersion: 1, RequestID: "run:1", ModuleHash: strings.Repeat("0", 64), Function: "main", Effect: "fs.read", Capability: "workspace_read", Path: "input.txt"}
	result := wire.EffectResult{ProtocolVersion: 1, RequestID: "run:1", Status: "succeeded", ValueType: "bytes", Value: []byte("hello"), ErrorCode: ""}
	requestHash, _ := RequestHash(request)
	resultHash, _ := ResultHash(result)
	if requestHash != "73f691000408f0259248ba9889af60d0ebf73b5958c5751b5d6493896d339cb5" || resultHash != "bb3a97c120d0eecd44b5a863ea09afaa1654944736c9157b937318e5be945572" {
		t.Fatalf("request=%s result=%s", requestHash, resultHash)
	}
}

func TestDecodeStrictBytesRequireCanonicalBase64(t *testing.T) {
	for _, raw := range []string{`[]`, `[102]`, `null`, `"Zg==\n"`, `"Zg==\r\n"`, `"Zh=="`, `"Zm9="`, `"Zg"`, `"Zg==="`, `"_w=="`} {
		var bytes []byte
		var namedBytes ed25519.PublicKey
		for _, destination := range []any{&bytes, &namedBytes} {
			if err := DecodeStrict([]byte(raw), destination); err == nil {
				t.Fatalf("accepted noncanonical byte encoding %s into %T", raw, destination)
			}
		}
	}
	for _, raw := range []string{`""`, `"Zg=="`, `"Zm9v"`, `"/w=="`} {
		var bytes []byte
		var namedBytes ed25519.PublicKey
		for _, destination := range []any{&bytes, &namedBytes} {
			if err := DecodeStrict([]byte(raw), destination); err != nil {
				t.Fatalf("rejected canonical byte encoding %s into %T: %v", raw, destination, err)
			}
		}
		if bytes == nil || namedBytes == nil {
			t.Fatal("empty base64 must produce an empty byte slice rather than null")
		}
	}
}

func TestDecodeStrictWireResultRejectsArrayAndNoncanonicalBase64(t *testing.T) {
	result := wire.EffectResult{ProtocolVersion: 1, RequestID: "run:1", Status: "succeeded", ValueType: "bytes", Value: []byte("hello"), ErrorCode: ""}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{`[]`, `[104,101,108,108,111]`, `null`, `"aGVsbG8=\n"`, `"aGVsbG9="`} {
		invalid := strings.Replace(string(raw), `"value":"aGVsbG8="`, `"value":`+value, 1)
		var decoded wire.EffectResult
		if err := DecodeStrict([]byte(invalid), &decoded); err == nil {
			t.Fatalf("accepted ambiguous result bytes: %s", invalid)
		}
	}
	validEmpty := strings.Replace(string(raw), `"value":"aGVsbG8="`, `"value":""`, 1)
	var decoded wire.EffectResult
	if err := DecodeStrict([]byte(validEmpty), &decoded); err != nil || decoded.Value == nil || len(decoded.Value) != 0 {
		t.Fatalf("canonical empty result: value=%v err=%v", decoded.Value, err)
	}
}

func TestDecodeStrictRequiresExactWireFields(t *testing.T) {
	request := wire.EffectRequest{ProtocolVersion: 1, RequestID: "run:1", ModuleHash: strings.Repeat("0", 64), Function: "main", Effect: "clock.read", Capability: "clock_read", Path: ""}
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var decoded wire.EffectRequest
	if err := DecodeStrict(raw, &decoded); err != nil || decoded != request {
		t.Fatalf("valid decode=%+v err=%v", decoded, err)
	}
	for _, invalid := range []string{
		strings.Replace(string(raw), `"path":""`, `"path":"","path":""`, 1),
		strings.Replace(string(raw), `"path":""`, `"Path":""`, 1),
		strings.Replace(string(raw), `,"path":""`, ``, 1),
		strings.Replace(string(raw), `"path":""`, `"path":null`, 1),
		strings.Replace(string(raw), `"protocol_version":1`, `"protocol_version":null`, 1),
		strings.Replace(string(raw), `"path":""`, `"path":"","unexpected":0`, 1),
		strings.Replace(string(raw), `"path":""`, `"path":"\ud800"`, 1),
		strings.Replace(string(raw), `"path":""`, `"path":"\udfff"`, 1),
		string(raw) + `{}`,
		`null`,
	} {
		if err := DecodeStrict([]byte(invalid), &decoded); err == nil {
			t.Fatalf("accepted ambiguous wire JSON: %s", invalid)
		}
	}
}

func TestDecodeStrictAcceptsPairedUnicodeAndLiteralEscapes(t *testing.T) {
	for _, raw := range []string{`"\ud83d\ude00"`, `"\\ud800"`, `"\u003c"`} {
		var text string
		if err := DecodeStrict([]byte(raw), &text); err != nil {
			t.Fatalf("valid escaped text=%s err=%v", raw, err)
		}
	}
}
