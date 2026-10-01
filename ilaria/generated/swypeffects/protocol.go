// Package effects defines the versioned, authority-free broker wire protocol.
// A requirement names a capability; only the receiving host can grant it.
package effects

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"unicode/utf8"
)

const (
	Version                     uint64 = 1
	MaxValueBytes                      = 1 << 20
	MaxMessageBytes                    = 2 << 20
	MaxContinuationBytes               = 6 << 20
	MaxContinuationMessageBytes        = 9 << 20
	ReceiptDomain                      = "nexus.effect.receipt.v1\n"
)

func ValidateRequest(r EffectRequest) error {
	if r.ProtocolVersion != Version {
		return fmt.Errorf("unsupported effect protocol version %d", r.ProtocolVersion)
	}
	if !identifier(r.RequestID, 128, true) || !identifier(r.Function, 64, false) || !capability(r.Capability) {
		return fmt.Errorf("invalid request identity, function or capability")
	}
	if !moduleHash(r.ModuleHash) {
		return fmt.Errorf("module_hash must be lowercase SHA-256 hex")
	}
	if !utf8.ValidString(r.Path) || len(r.Path) > 4096 {
		return fmt.Errorf("path must be bounded UTF-8")
	}
	switch r.Effect {
	case "clock.read":
		if r.Path != "" {
			return fmt.Errorf("clock.read has no path")
		}
	case "fs.read":
		if r.Path == "" || bytes.IndexByte([]byte(r.Path), 0) >= 0 {
			return fmt.Errorf("fs.read requires a nonempty path without NUL")
		}
	default:
		return fmt.Errorf("unsupported broker effect %q", r.Effect)
	}
	return nil
}

func ValidateResult(r EffectResult, request EffectRequest) error {
	if err := ValidateRequest(request); err != nil {
		return err
	}
	if r.ProtocolVersion != Version || r.RequestID != request.RequestID {
		return fmt.Errorf("effect result version or request identity mismatch")
	}
	wantType := "bytes"
	if request.Effect == "clock.read" {
		wantType = "i64"
	}
	if r.ValueType != wantType || len(r.Value) > MaxValueBytes {
		return fmt.Errorf("effect result type or byte limit mismatch")
	}
	switch r.Status {
	case "succeeded":
		if r.ErrorCode != "" || r.Value == nil {
			return fmt.Errorf("successful effect result requires a value and no error")
		}
		if wantType == "i64" {
			n, err := strconv.ParseInt(string(r.Value), 10, 64)
			if err != nil || n < 0 || strconv.FormatInt(n, 10) != string(r.Value) {
				return fmt.Errorf("clock result must be canonical nonnegative Unix milliseconds")
			}
		}
	case "denied", "failed", "uncertain", "blocked":
		if len(r.Value) != 0 || !capability(r.ErrorCode) {
			return fmt.Errorf("unsuccessful effect result requires an error and no value")
		}
	default:
		return fmt.Errorf("unknown effect result status %q", r.Status)
	}
	return nil
}

func RequestHash(r EffectRequest) (string, error) {
	if err := ValidateRequest(r); err != nil {
		return "", err
	}
	return canonicalHash(r)
}

// ResultHash covers the entire result, including its type, status and error.
// ValidateResult must also be called with the expected request before acceptance.
func ResultHash(r EffectResult) (string, error) { return canonicalHash(r) }

func canonicalHash(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

// ReceiptSigningBytes excludes only the signature, and separates the signing
// domain from other uses of the same host key. This function grants no trust.
func ReceiptSigningBytes(r EffectReceipt) ([]byte, error) {
	r.Signature = nil
	b, err := json.Marshal(r)
	if err != nil {
		return nil, err
	}
	return append([]byte(ReceiptDomain), b...), nil
}

func DecodeRequest(data []byte) (EffectRequest, error) {
	var r EffectRequest
	err := decodeExact(data, &r, []string{"protocol_version", "request_id", "module_hash", "function", "effect", "capability", "path"}, "")
	if err == nil {
		err = ValidateRequest(r)
	}
	return r, err
}

// DecodeResult checks the wire shape. Call ValidateResult to bind it to the
// outstanding request before resuming the guest interpreter.
func DecodeResult(data []byte) (EffectResult, error) {
	var r EffectResult
	err := decodeExact(data, &r, []string{"protocol_version", "request_id", "status", "value_type", "value", "error_code"}, "value")
	return r, err
}

func ContinuationHash(data []byte) (string, error) {
	if len(data) == 0 || len(data) > MaxContinuationBytes {
		return "", fmt.Errorf("continuation size outside 1..%d bytes", MaxContinuationBytes)
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), nil
}

func ValidateContinuationCheckpoint(c ContinuationCheckpoint) error {
	if c.ProtocolVersion != Version || !identifier(c.RunID, 128, true) || !moduleHash(c.ModuleHash) || c.EffectSequence == 0 ||
		!moduleHash(c.ContinuationHash) || len(c.Continuation) == 0 || len(c.Continuation) > MaxContinuationBytes {
		return fmt.Errorf("invalid continuation checkpoint identity, sequence, hash or size")
	}
	hash, _ := ContinuationHash(c.Continuation)
	if hash != c.ContinuationHash {
		return fmt.Errorf("continuation checkpoint hash mismatch")
	}
	return nil
}

func DecodeContinuationCheckpoint(data []byte) (ContinuationCheckpoint, error) {
	var checkpoint ContinuationCheckpoint
	err := decodeExactBounded(data, &checkpoint,
		[]string{"protocol_version", "run_id", "module_hash", "effect_sequence", "continuation_hash", "continuation"},
		MaxContinuationMessageBytes, map[string]exactBytesRule{"continuation": {maxBytes: MaxContinuationBytes}})
	if err == nil {
		err = ValidateContinuationCheckpoint(checkpoint)
	}
	return checkpoint, err
}

func validateContinuationAckShape(a ContinuationAck) error {
	if a.ProtocolVersion != Version || !identifier(a.RunID, 128, true) || !moduleHash(a.ModuleHash) || a.EffectSequence == 0 || !moduleHash(a.ContinuationHash) {
		return fmt.Errorf("invalid continuation acknowledgement identity")
	}
	switch a.Status {
	case "accepted":
		if a.ErrorCode != "" {
			return fmt.Errorf("accepted continuation acknowledgement cannot carry an error")
		}
	case "rejected":
		if !capability(a.ErrorCode) {
			return fmt.Errorf("rejected continuation acknowledgement requires an error code")
		}
	default:
		return fmt.Errorf("unknown continuation acknowledgement status %q", a.Status)
	}
	return nil
}

func ValidateContinuationAck(a ContinuationAck, checkpoint ContinuationCheckpoint) error {
	if err := validateContinuationAckShape(a); err != nil {
		return err
	}
	if err := ValidateContinuationCheckpoint(checkpoint); err != nil {
		return err
	}
	if a.RunID != checkpoint.RunID || a.ModuleHash != checkpoint.ModuleHash || a.EffectSequence != checkpoint.EffectSequence || a.ContinuationHash != checkpoint.ContinuationHash {
		return fmt.Errorf("continuation acknowledgement does not match checkpoint")
	}
	return nil
}

func DecodeContinuationAck(data []byte) (ContinuationAck, error) {
	var ack ContinuationAck
	err := decodeExactBounded(data, &ack,
		[]string{"protocol_version", "run_id", "module_hash", "effect_sequence", "continuation_hash", "status", "error_code"},
		MaxMessageBytes, nil)
	if err == nil {
		err = validateContinuationAckShape(ack)
	}
	return ack, err
}

// decodeExact rejects aliases, duplicate fields, omitted fields and trailing
// values. encoding/json alone accepts case-folded aliases and duplicate keys.
func decodeExact(data []byte, target any, fields []string, nullable string) error {
	var rules map[string]exactBytesRule
	if nullable != "" {
		rules = map[string]exactBytesRule{nullable: {maxBytes: MaxValueBytes, nullable: true}}
	}
	return decodeExactBounded(data, target, fields, MaxMessageBytes, rules)
}

type exactBytesRule struct {
	maxBytes int
	nullable bool
}

func decodeExactBounded(data []byte, target any, fields []string, maxMessageBytes int, bytesRules map[string]exactBytesRule) error {
	if len(data) > maxMessageBytes || !utf8.Valid(data) || !validUnicodeEscapes(data) {
		return fmt.Errorf("effect message exceeds byte limit or is not UTF-8")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	t, err := d.Token()
	if err != nil || t != json.Delim('{') {
		return fmt.Errorf("effect message must be an object")
	}
	allowed := make(map[string]bool, len(fields))
	for _, f := range fields {
		allowed[f] = true
	}
	seen := make(map[string]bool, len(fields))
	for d.More() {
		t, err = d.Token()
		if err != nil {
			return err
		}
		key, ok := t.(string)
		if !ok || !allowed[key] || seen[key] {
			return fmt.Errorf("unknown or duplicate effect field %q", key)
		}
		seen[key] = true
		var v json.RawMessage
		if err = d.Decode(&v); err != nil {
			return err
		}
		rule, isBytes := bytesRules[key]
		isNull := bytes.Equal(bytes.TrimSpace(v), []byte("null"))
		if isNull {
			if !isBytes || !rule.nullable {
				return fmt.Errorf("effect field %q cannot be null", key)
			}
			continue
		}
		if isBytes {
			var encoded string
			if err := json.Unmarshal(v, &encoded); err != nil {
				return fmt.Errorf("effect value must be a base64 string")
			}
			decoded, err := base64.StdEncoding.Strict().DecodeString(encoded)
			if err != nil || base64.StdEncoding.EncodeToString(decoded) != encoded || len(decoded) > rule.maxBytes {
				return fmt.Errorf("effect value must be bounded canonical base64")
			}
		}
	}
	if _, err = d.Token(); err != nil {
		return err
	}
	if len(seen) != len(allowed) {
		return fmt.Errorf("effect message is missing required fields")
	}
	if _, err = d.Token(); err != io.EOF {
		return fmt.Errorf("trailing data after effect message")
	}
	return json.Unmarshal(data, target)
}

// encoding/json substitutes U+FFFD for an unpaired escaped UTF-16 surrogate.
// Reject that lossy spelling instead of changing a signed path during decoding.
func validUnicodeEscapes(data []byte) bool {
	inString := false
	for i := 0; i < len(data); i++ {
		if data[i] == '"' {
			inString = !inString
			continue
		}
		if !inString || data[i] != '\\' {
			continue
		}
		i++
		if i >= len(data) {
			return false
		}
		if data[i] != 'u' {
			continue
		}
		if i+4 >= len(data) {
			return false
		}
		u, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if u >= 0xdc00 && u <= 0xdfff {
			return false
		}
		if u < 0xd800 || u > 0xdbff {
			continue
		}
		if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
			return false
		}
		low, err := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
		if err != nil || low < 0xdc00 || low > 0xdfff {
			return false
		}
		i += 6
	}
	return true
}

func identifier(s string, max int, punctuation bool) bool {
	if len(s) == 0 || len(s) > max {
		return false
	}
	for i, c := range s {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '_' {
			continue
		}
		if c >= '0' && c <= '9' && (punctuation || i > 0) {
			continue
		}
		if punctuation && (c == '.' || c == ':' || c == '-') {
			continue
		}
		return false
	}
	return true
}

func moduleHash(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func capability(s string) bool {
	if len(s) == 0 || len(s) > 64 || s[0] < 'a' || s[0] > 'z' {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}
