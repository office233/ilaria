// Package continuation defines the authority-free, versioned wire contract used
// to persist and authenticate Swyp Core continuations outside the language
// runtime. It deliberately contains no key, signature, lease, fence, filesystem,
// network, or OS authority.
package continuation

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"unicode/utf8"
)

const (
	Version         uint64 = 1
	StateVersion    uint64 = 1
	MaxStateBytes          = 6 << 20
	MaxMessageBytes        = 9 << 20
	MaxAckBytes            = 64 << 10
	MaxFuel                = 1_000_000
	MaxEffectBytes         = 1 << 20
	BindingDomain          = "nexus.swyp.continuation.v1\n"
)

// Checkpoint is an authority-free envelope. State is opaque to hosts; Swyp
// validates it against the exact verified module before resuming. The two effect
// hashes let a trusted host bind the verified result that produced EffectCursor
// to the exact post-effect interpreter state it authenticates.
type Checkpoint struct {
	ProtocolVersion   uint64 `json:"protocol_version"`
	Type              string `json:"type"`
	StateVersion      uint64 `json:"state_version"`
	RunID             string `json:"run_id"`
	ModuleHash        string `json:"module_hash"`
	Entry             string `json:"entry"`
	FuelLimit         uint64 `json:"fuel_limit"`
	StepsUsed         uint64 `json:"steps_used"`
	MaxEffectBytes    uint64 `json:"max_effect_bytes"`
	EffectBytes       uint64 `json:"effect_bytes"`
	EffectCursor      uint64 `json:"effect_cursor"`
	EffectRequestHash string `json:"effect_request_hash"`
	EffectResultHash  string `json:"effect_result_hash"`
	StateHash         string `json:"state_hash"`
	State             []byte `json:"state"`
}

// Ack is transport flow control only. "accepted" means the trusted host has
// durably handled/authenticated the checkpoint according to its own policy.
// No authority or signature material is carried back into Swyp.
type Ack struct {
	ProtocolVersion uint64 `json:"protocol_version"`
	Type            string `json:"type"`
	RunID           string `json:"run_id"`
	ModuleHash      string `json:"module_hash"`
	Entry           string `json:"entry"`
	EffectCursor    uint64 `json:"effect_cursor"`
	StateHash       string `json:"state_hash"`
	Status          string `json:"status"`
	ErrorCode       string `json:"error_code"`
}

type binding struct {
	ProtocolVersion   uint64 `json:"protocol_version"`
	Type              string `json:"type"`
	StateVersion      uint64 `json:"state_version"`
	RunID             string `json:"run_id"`
	ModuleHash        string `json:"module_hash"`
	Entry             string `json:"entry"`
	FuelLimit         uint64 `json:"fuel_limit"`
	StepsUsed         uint64 `json:"steps_used"`
	MaxEffectBytes    uint64 `json:"max_effect_bytes"`
	EffectBytes       uint64 `json:"effect_bytes"`
	EffectCursor      uint64 `json:"effect_cursor"`
	EffectRequestHash string `json:"effect_request_hash"`
	EffectResultHash  string `json:"effect_result_hash"`
	StateHash         string `json:"state_hash"`
}

var checkpointFields = []string{
	"protocol_version", "type", "state_version", "run_id", "module_hash", "entry",
	"fuel_limit", "steps_used", "max_effect_bytes", "effect_bytes", "effect_cursor",
	"effect_request_hash", "effect_result_hash", "state_hash", "state",
}

var ackFields = []string{
	"protocol_version", "type", "run_id", "module_hash", "entry", "effect_cursor",
	"state_hash", "status", "error_code",
}

func HashState(state []byte) (string, error) {
	if len(state) == 0 || len(state) > MaxStateBytes {
		return "", fmt.Errorf("continuation state size outside 1..%d bytes", MaxStateBytes)
	}
	sum := sha256.Sum256(state)
	return hex.EncodeToString(sum[:]), nil
}

func ValidateCheckpoint(c Checkpoint) error {
	if c.ProtocolVersion != Version || c.Type != "continuation" || c.StateVersion != StateVersion {
		return fmt.Errorf("unsupported continuation protocol, frame type, or state version")
	}
	if !identifier(c.RunID, 120, true) || !identifier(c.Entry, 64, false) || !digest(c.ModuleHash) {
		return fmt.Errorf("invalid continuation run, module, or entry identity")
	}
	if c.FuelLimit < 1 || c.FuelLimit > MaxFuel || c.StepsUsed > c.FuelLimit ||
		c.MaxEffectBytes > MaxEffectBytes || c.EffectBytes > c.MaxEffectBytes ||
		c.EffectCursor == 0 || c.EffectCursor > c.StepsUsed {
		return fmt.Errorf("invalid continuation budget or effect cursor")
	}
	if !digest(c.EffectRequestHash) || !digest(c.EffectResultHash) || !digest(c.StateHash) {
		return fmt.Errorf("invalid continuation request, result, or state hash")
	}
	hash, err := HashState(c.State)
	if err != nil {
		return err
	}
	if hash != c.StateHash {
		return fmt.Errorf("continuation state hash mismatch")
	}
	return nil
}

func DecodeCheckpoint(data []byte) (Checkpoint, error) {
	var c Checkpoint
	if err := decodeExact(data, MaxMessageBytes, checkpointFields, "state", MaxStateBytes, &c); err != nil {
		return Checkpoint{}, err
	}
	if err := ValidateCheckpoint(c); err != nil {
		return Checkpoint{}, err
	}
	return c, nil
}

// BindingBytes returns deterministic metadata for a host-owned authentication
// primitive. StateHash commits to State, so the potentially multi-megabyte state
// need not be duplicated in a signature payload.
func BindingBytes(c Checkpoint) ([]byte, error) {
	if err := ValidateCheckpoint(c); err != nil {
		return nil, err
	}
	b := binding{
		ProtocolVersion: c.ProtocolVersion, Type: c.Type, StateVersion: c.StateVersion,
		RunID: c.RunID, ModuleHash: c.ModuleHash, Entry: c.Entry,
		FuelLimit: c.FuelLimit, StepsUsed: c.StepsUsed,
		MaxEffectBytes: c.MaxEffectBytes, EffectBytes: c.EffectBytes,
		EffectCursor: c.EffectCursor, EffectRequestHash: c.EffectRequestHash,
		EffectResultHash: c.EffectResultHash, StateHash: c.StateHash,
	}
	raw, err := json.Marshal(b)
	if err != nil {
		return nil, err
	}
	return append([]byte(BindingDomain), raw...), nil
}

func EnvelopeHash(c Checkpoint) (string, error) {
	raw, err := BindingBytes(c)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func DecodeAck(data []byte) (Ack, error) {
	var a Ack
	if err := decodeExact(data, MaxAckBytes, ackFields, "", 0, &a); err != nil {
		return Ack{}, err
	}
	if err := validateAckShape(a); err != nil {
		return Ack{}, err
	}
	return a, nil
}

func ValidateAck(a Ack, c Checkpoint) error {
	if err := validateAckShape(a); err != nil {
		return err
	}
	if err := ValidateCheckpoint(c); err != nil {
		return err
	}
	if a.RunID != c.RunID || a.ModuleHash != c.ModuleHash || a.Entry != c.Entry ||
		a.EffectCursor != c.EffectCursor || a.StateHash != c.StateHash {
		return fmt.Errorf("continuation acknowledgement does not match checkpoint")
	}
	return nil
}

func validateAckShape(a Ack) error {
	if a.ProtocolVersion != Version || a.Type != "continuation_ack" ||
		!identifier(a.RunID, 120, true) || !identifier(a.Entry, 64, false) ||
		!digest(a.ModuleHash) || a.EffectCursor == 0 || !digest(a.StateHash) {
		return fmt.Errorf("invalid continuation acknowledgement identity")
	}
	switch a.Status {
	case "accepted":
		if a.ErrorCode != "" {
			return fmt.Errorf("accepted continuation acknowledgement cannot carry an error")
		}
	case "rejected":
		if !errorCode(a.ErrorCode) {
			return fmt.Errorf("rejected continuation acknowledgement requires an error code")
		}
	default:
		return fmt.Errorf("unknown continuation acknowledgement status %q", a.Status)
	}
	return nil
}

func decodeExact(data []byte, maxBytes int, fields []string, bytesField string, maxDecodedBytes int, target any) error {
	if len(data) == 0 || len(data) > maxBytes || !utf8.Valid(data) {
		return fmt.Errorf("continuation message size outside 1..%d bytes or not UTF-8", maxBytes)
	}
	allowed := make(map[string]bool, len(fields))
	for _, field := range fields {
		allowed[field] = true
	}
	seen := make(map[string]bool, len(fields))
	d := json.NewDecoder(bytes.NewReader(data))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return fmt.Errorf("continuation message must be an object")
	}
	for d.More() {
		token, err = d.Token()
		if err != nil {
			return err
		}
		key, ok := token.(string)
		if !ok || !allowed[key] || seen[key] {
			return fmt.Errorf("unknown or duplicate continuation field %q", key)
		}
		seen[key] = true
		var raw json.RawMessage
		if err := d.Decode(&raw); err != nil {
			return err
		}
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return fmt.Errorf("continuation field %q cannot be null", key)
		}
		if key == bytesField {
			var encoded string
			if err := json.Unmarshal(raw, &encoded); err != nil {
				return fmt.Errorf("continuation state must be a base64 string")
			}
			decoded, err := base64.StdEncoding.Strict().DecodeString(encoded)
			if err != nil || base64.StdEncoding.EncodeToString(decoded) != encoded || len(decoded) == 0 || len(decoded) > maxDecodedBytes {
				return fmt.Errorf("continuation state must be bounded canonical base64")
			}
		}
	}
	if _, err := d.Token(); err != nil {
		return err
	}
	if len(seen) != len(allowed) {
		return fmt.Errorf("continuation message is missing required fields")
	}
	if _, err := d.Token(); err != io.EOF {
		return fmt.Errorf("trailing data after continuation message")
	}
	return json.Unmarshal(data, target)
}

func digest(s string) bool {
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

func errorCode(s string) bool {
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
