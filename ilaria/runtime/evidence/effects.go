// Package evidence verifies execution evidence without acquiring OS authority.
// A successful receipt proves what a configured trusted executor attested; it
// does not establish task correctness, transferable provenance or training rights.
package evidence

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	effects "ilaria/generated/swypeffects"
)

const (
	ProtocolVersion        uint64 = 1
	ReceiptSignatureDomain        = "nexus.effect.receipt.v1\n"
	TrustRegistryFormat           = "ilaria-effect-trust-registry-v1"
	ObservationFormat             = "ilaria-effect-observation-v1"
	MaxValueBytes                 = 1 << 20
	MaxPathBytes                  = 4096
	MaxIdentifierBytes            = 128
	MaxNameBytes                  = 64
	PrivacyLocalPrivate           = "local_private"
)

// TrustedKey is configuration supplied by the caller, never by a receipt.
// PublicKey is standard padded base64 when encoded as JSON.
type TrustedKey struct {
	ExecutorID string            `json:"executor_id"`
	PublicKey  ed25519.PublicKey `json:"public_key"`
	Revoked    bool              `json:"revoked"`
}

type TrustRegistry struct {
	Format string                `json:"format"`
	Keys   map[string]TrustedKey `json:"keys"`
}

// ExpectedExecution must come from the caller's task/lease state independently
// of the receipt. IntentID can additionally pin an already-known broker intent.
type ExpectedExecution struct {
	TaskID     string `json:"task_id"`
	NodeID     string `json:"node_id"`
	AttemptID  string `json:"attempt_id"`
	ExecutorID string `json:"executor_id"`
	GrantID    string `json:"grant_id"`
	LeaseID    string `json:"lease_id"`
	Fence      uint64 `json:"fence"`
	IntentID   string `json:"intent_id,omitempty"`
}

// Observation deliberately omits the payload/path and cannot mint grants,
// produce WorldEvents/PCE capsules, or authorize any training promotion.
type Observation struct {
	Format           string `json:"format"`
	ProtocolVersion  uint64 `json:"protocol_version"`
	Verified         bool   `json:"verified"`
	Purpose          string `json:"purpose"`
	TrainingEligible bool   `json:"training_eligible"`
	PrivacyClass     string `json:"privacy_class"`
	RequestID        string `json:"request_id"`
	RequestHash      string `json:"request_hash"`
	ResultHash       string `json:"result_hash"`
	ReceiptHash      string `json:"receipt_hash"`
	ModuleHash       string `json:"module_hash"`
	Function         string `json:"function"`
	Effect           string `json:"effect"`
	Capability       string `json:"capability"`
	TaskID           string `json:"task_id"`
	NodeID           string `json:"node_id"`
	AttemptID        string `json:"attempt_id"`
	ExecutorID       string `json:"executor_id"`
	GrantID          string `json:"grant_id"`
	LeaseID          string `json:"lease_id"`
	Fence            uint64 `json:"fence"`
	IntentID         string `json:"intent_id"`
	SignerKeyID      string `json:"signer_key_id"`
	OccurredAtUnixMS int64  `json:"occurred_at_unix_ms"`
	ValueType        string `json:"value_type"`
	ValueBytes       int    `json:"value_bytes"`
}

// Verifier holds an immutable copy of the caller's trust configuration.
// Construct a new verifier from updated configuration when keys are revoked.
type Verifier struct {
	keys map[string]TrustedKey
}

func NewVerifier(keys map[string]TrustedKey) (*Verifier, error) {
	if len(keys) == 0 {
		return nil, fmt.Errorf("evidence: trusted key registry is empty")
	}
	copyKeys := make(map[string]TrustedKey, len(keys))
	for id, key := range keys {
		if err := validateIdentifier("signer_key_id", id, MaxIdentifierBytes); err != nil {
			return nil, err
		}
		if err := validateIdentifier("trusted executor_id", key.ExecutorID, MaxIdentifierBytes); err != nil {
			return nil, err
		}
		if len(key.PublicKey) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("evidence: trusted key %q is not an Ed25519 public key", id)
		}
		key.PublicKey = append(ed25519.PublicKey(nil), key.PublicKey...)
		copyKeys[id] = key
	}
	return &Verifier{keys: copyKeys}, nil
}

func validateIdentifier(field, value string, limit int) error {
	if value == "" || len(value) > limit {
		return fmt.Errorf("evidence: %s must contain 1..%d ASCII identifier bytes", field, limit)
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || strings.ContainsRune("_.:-", rune(c)) {
			continue
		}
		return fmt.Errorf("evidence: %s contains an invalid identifier byte", field)
	}
	return nil
}

func validateCapability(value string) error {
	if value == "" || len(value) > MaxNameBytes || value[0] < 'a' || value[0] > 'z' {
		return fmt.Errorf("evidence: capability must be a lowercase semantic name")
	}
	for _, c := range value {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '_' {
			return fmt.Errorf("evidence: capability must be a lowercase semantic name")
		}
	}
	return nil
}

func validateFunction(value string) error {
	if value == "" || len(value) > MaxNameBytes {
		return fmt.Errorf("evidence: function must be an ASCII semantic name")
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' ||
			(i > 0 && c >= '0' && c <= '9') {
			continue
		}
		return fmt.Errorf("evidence: function must be an ASCII semantic name")
	}
	return nil
}

func validateHash(field, value string) error {
	if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
		return fmt.Errorf("evidence: %s must be lowercase SHA-256 hex", field)
	}
	if _, err := hex.DecodeString(value); err != nil {
		return fmt.Errorf("evidence: %s must be lowercase SHA-256 hex", field)
	}
	return nil
}

func ValidateRequest(request effects.EffectRequest) error {
	if request.ProtocolVersion != ProtocolVersion {
		return fmt.Errorf("evidence: unsupported request protocol version")
	}
	if err := validateIdentifier("request_id", request.RequestID, MaxIdentifierBytes); err != nil {
		return err
	}
	if err := validateHash("module_hash", request.ModuleHash); err != nil {
		return err
	}
	if err := validateFunction(request.Function); err != nil {
		return err
	}
	if err := validateCapability(request.Capability); err != nil {
		return err
	}
	switch request.Effect {
	case "fs.read":
		if request.Path == "" || len(request.Path) > MaxPathBytes || !utf8.ValidString(request.Path) || strings.ContainsRune(request.Path, 0) {
			return fmt.Errorf("evidence: fs.read path must be nonempty UTF-8 without NUL, at most %d bytes", MaxPathBytes)
		}
	case "clock.read":
		if request.Path != "" {
			return fmt.Errorf("evidence: clock.read path must be empty")
		}
	default:
		return fmt.Errorf("evidence: unsupported effect %q", request.Effect)
	}
	return nil
}

func validateExpected(expected ExpectedExecution) error {
	for field, value := range map[string]string{
		"expected task_id": expected.TaskID, "expected node_id": expected.NodeID,
		"expected attempt_id": expected.AttemptID, "expected executor_id": expected.ExecutorID,
		"expected grant_id": expected.GrantID, "expected lease_id": expected.LeaseID,
	} {
		if err := validateIdentifier(field, value, MaxIdentifierBytes); err != nil {
			return err
		}
	}
	if expected.Fence == 0 {
		return fmt.Errorf("evidence: expected fence must be positive")
	}
	if expected.IntentID != "" {
		return validateIdentifier("expected intent_id", expected.IntentID, MaxIdentifierBytes)
	}
	return nil
}

func hashJSON(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// RequestHash and ResultHash use the generated DTO field order and Go JSON
// representation pinned by the shared Swyp effects v1 wire contract.
func RequestHash(request effects.EffectRequest) (string, error) { return hashJSON(request) }
func ResultHash(result effects.EffectResult) (string, error)    { return hashJSON(result) }

func ReceiptSigningBytes(receipt effects.EffectReceipt) ([]byte, error) {
	receipt.Signature = nil
	raw, err := json.Marshal(receipt)
	if err != nil {
		return nil, err
	}
	return append([]byte(ReceiptSignatureDomain), raw...), nil
}

func validateSuccessfulResult(request effects.EffectRequest, result effects.EffectResult) error {
	if result.ProtocolVersion != ProtocolVersion || result.RequestID != request.RequestID {
		return fmt.Errorf("evidence: result protocol/request binding mismatch")
	}
	if result.Status != "succeeded" || result.ErrorCode != "" {
		return fmt.Errorf("evidence: result is not successful terminal execution evidence")
	}
	if len(result.Value) > MaxValueBytes {
		return fmt.Errorf("evidence: result exceeds %d decoded payload bytes", MaxValueBytes)
	}
	if result.Value == nil {
		return fmt.Errorf("evidence: successful result must contain a value")
	}
	if request.Effect == "fs.read" {
		if result.ValueType != "bytes" {
			return fmt.Errorf("evidence: fs.read requires bytes result")
		}
		return nil
	}
	if result.ValueType != "i64" {
		return fmt.Errorf("evidence: clock.read requires i64 result")
	}
	value, err := strconv.ParseInt(string(result.Value), 10, 64)
	if err != nil || value < 0 || strconv.FormatInt(value, 10) != string(result.Value) {
		return fmt.Errorf("evidence: clock result must be canonical non-negative Unix milliseconds")
	}
	return nil
}

// Verify accepts only terminal success bound to independent caller context.
// It never changes weights, memory, trust configuration, grants or OS state.
func (v *Verifier) Verify(request effects.EffectRequest, result effects.EffectResult,
	receipt effects.EffectReceipt, expected ExpectedExecution) (Observation, error) {
	if v == nil || len(v.keys) == 0 {
		return Observation{}, fmt.Errorf("evidence: no trusted verifier configured")
	}
	if err := ValidateRequest(request); err != nil {
		return Observation{}, err
	}
	if err := validateExpected(expected); err != nil {
		return Observation{}, err
	}
	if err := validateSuccessfulResult(request, result); err != nil {
		return Observation{}, err
	}
	if receipt.ProtocolVersion != ProtocolVersion || receipt.RequestID != request.RequestID ||
		receipt.Effect != request.Effect || receipt.Capability != request.Capability {
		return Observation{}, fmt.Errorf("evidence: receipt request/protocol/effect/capability binding mismatch")
	}
	if receipt.Status != "succeeded" || receipt.Status != result.Status || receipt.ErrorCode != "" {
		return Observation{}, fmt.Errorf("evidence: receipt is not successful terminal execution evidence")
	}
	if receipt.TaskID != expected.TaskID || receipt.NodeID != expected.NodeID ||
		receipt.AttemptID != expected.AttemptID || receipt.ExecutorID != expected.ExecutorID ||
		receipt.GrantID != expected.GrantID || receipt.LeaseID != expected.LeaseID || receipt.Fence != expected.Fence {
		return Observation{}, fmt.Errorf("evidence: receipt does not match independently expected execution")
	}
	if err := validateIdentifier("intent_id", receipt.IntentID, MaxIdentifierBytes); err != nil {
		return Observation{}, err
	}
	if expected.IntentID != "" && receipt.IntentID != expected.IntentID {
		return Observation{}, fmt.Errorf("evidence: receipt intent does not match expected execution")
	}
	if receipt.OccurredAtUnixMS <= 0 || receipt.PrivacyClass != PrivacyLocalPrivate {
		return Observation{}, fmt.Errorf("evidence: invalid receipt time/privacy policy")
	}
	if err := validateIdentifier("signer_key_id", receipt.SignerKeyID, MaxIdentifierBytes); err != nil {
		return Observation{}, err
	}
	key, found := v.keys[receipt.SignerKeyID]
	if !found || key.Revoked {
		return Observation{}, fmt.Errorf("evidence: receipt signer is unknown or revoked")
	}
	if key.ExecutorID != receipt.ExecutorID {
		return Observation{}, fmt.Errorf("evidence: receipt signer is not trusted for this executor")
	}
	for field, value := range map[string]string{"request_hash": receipt.RequestHash, "result_hash": receipt.ResultHash} {
		if err := validateHash(field, value); err != nil {
			return Observation{}, err
		}
	}
	requestHash, err := RequestHash(request)
	if err != nil {
		return Observation{}, err
	}
	resultHash, err := ResultHash(result)
	if err != nil {
		return Observation{}, err
	}
	if receipt.RequestHash != requestHash || receipt.ResultHash != resultHash {
		return Observation{}, fmt.Errorf("evidence: receipt request/result content hash mismatch")
	}
	signedBytes, err := ReceiptSigningBytes(receipt)
	if err != nil {
		return Observation{}, err
	}
	if len(receipt.Signature) != ed25519.SignatureSize || !ed25519.Verify(key.PublicKey, signedBytes, receipt.Signature) {
		return Observation{}, fmt.Errorf("evidence: receipt Ed25519 signature verification failed")
	}
	contentHash := sha256.Sum256(signedBytes)
	return Observation{
		Format: ObservationFormat, ProtocolVersion: ProtocolVersion, Verified: true,
		Purpose: "execution_evidence_only", TrainingEligible: false, PrivacyClass: PrivacyLocalPrivate,
		RequestID: request.RequestID, RequestHash: requestHash, ResultHash: resultHash,
		ReceiptHash: hex.EncodeToString(contentHash[:]), ModuleHash: request.ModuleHash,
		Function: request.Function, Effect: request.Effect, Capability: request.Capability,
		TaskID: receipt.TaskID, NodeID: receipt.NodeID, AttemptID: receipt.AttemptID,
		ExecutorID: receipt.ExecutorID, GrantID: receipt.GrantID, LeaseID: receipt.LeaseID,
		Fence: receipt.Fence, IntentID: receipt.IntentID, SignerKeyID: receipt.SignerKeyID,
		OccurredAtUnixMS: receipt.OccurredAtUnixMS, ValueType: result.ValueType, ValueBytes: len(result.Value),
	}, nil
}
