package supervisor

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"

	"swypik-os/core/controlkernel"
)

const sealedContinuationVersion uint64 = 1
const continuationBindingDomain = "nexus.swyp.continuation.v1\n"

var continuationFields = []string{
	"protocol_version", "type", "state_version", "run_id", "module_hash", "entry",
	"fuel_limit", "steps_used", "max_effect_bytes", "effect_bytes", "effect_cursor",
	"effect_request_hash", "effect_result_hash", "state_hash", "state",
}

type sealedContinuationRecord struct {
	Version    uint64              `json:"version"`
	Algorithm  string              `json:"algorithm"`
	KeyID      string              `json:"key_id"`
	Binding    ContinuationBinding `json:"binding"`
	Nonce      []byte              `json:"nonce"`
	Ciphertext []byte              `json:"ciphertext"`
}

type continuationAAD struct {
	Version   uint64              `json:"version"`
	Algorithm string              `json:"algorithm"`
	KeyID     string              `json:"key_id"`
	Binding   ContinuationBinding `json:"binding"`
}

var sealedContinuationFields = map[string]bool{
	"version": true, "algorithm": true, "key_id": true, "binding": true, "nonce": true, "ciphertext": true,
}

func decodeSealedContinuationRecord(raw []byte, record *sealedContinuationRecord) error {
	seen := make(map[string]bool, len(sealedContinuationFields))
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return fmt.Errorf("sealed continuation record must be an object")
	}
	for decoder.More() {
		token, err = decoder.Token()
		if err != nil {
			return err
		}
		field, ok := token.(string)
		if !ok || !sealedContinuationFields[field] || seen[field] {
			return fmt.Errorf("unknown or duplicate sealed continuation field")
		}
		seen[field] = true
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("invalid sealed continuation field")
		}
	}
	if _, err := decoder.Token(); err != nil || len(seen) != len(sealedContinuationFields) {
		return fmt.Errorf("sealed continuation record is missing required fields")
	}
	if _, err := decoder.Token(); err != io.EOF {
		return fmt.Errorf("trailing sealed continuation data")
	}
	strict := json.NewDecoder(bytes.NewReader(raw))
	strict.DisallowUnknownFields()
	if err := strict.Decode(record); err != nil {
		return err
	}
	if record.Version != sealedContinuationVersion || record.Algorithm != ContinuationModeAES256GCM || record.KeyID == "" ||
		len(record.Nonce) == 0 || len(record.Ciphertext) == 0 {
		return fmt.Errorf("invalid sealed continuation record identity")
	}
	return nil
}

func digestHex(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func continuationIdentifier(value string, max int, punctuation bool) bool {
	if len(value) == 0 || len(value) > max {
		return false
	}
	for i, c := range value {
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

func decodeContinuationEnvelope(raw []byte, maxBytes int) (ContinuationEnvelope, error) {
	var envelope ContinuationEnvelope
	if len(raw) == 0 || len(raw) > maxBytes || !utf8.Valid(raw) {
		return envelope, fmt.Errorf("%w: continuation envelope size is outside host policy", ErrContinuationRejected)
	}
	allowed := make(map[string]bool, len(continuationFields))
	for _, field := range continuationFields {
		allowed[field] = true
	}
	seen := make(map[string]bool, len(continuationFields))
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return envelope, fmt.Errorf("%w: continuation envelope must be an object", ErrContinuationRejected)
	}
	for decoder.More() {
		token, err = decoder.Token()
		if err != nil {
			return envelope, fmt.Errorf("%w: malformed continuation envelope", ErrContinuationRejected)
		}
		field, ok := token.(string)
		if !ok || !allowed[field] || seen[field] {
			return envelope, fmt.Errorf("%w: unknown or duplicate continuation field", ErrContinuationRejected)
		}
		seen[field] = true
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return envelope, fmt.Errorf("%w: invalid continuation field", ErrContinuationRejected)
		}
		if field == "state" {
			var encoded string
			if err := json.Unmarshal(value, &encoded); err != nil {
				return envelope, fmt.Errorf("%w: continuation state must be canonical base64", ErrContinuationRejected)
			}
			decoded, decodeErr := base64.StdEncoding.Strict().DecodeString(encoded)
			if decodeErr != nil || base64.StdEncoding.EncodeToString(decoded) != encoded || len(decoded) == 0 || len(decoded) > MaxContinuationStateBytes {
				return envelope, fmt.Errorf("%w: continuation state must be bounded canonical base64", ErrContinuationRejected)
			}
		}
	}
	if _, err := decoder.Token(); err != nil || len(seen) != len(continuationFields) {
		return envelope, fmt.Errorf("%w: continuation envelope missing required fields", ErrContinuationRejected)
	}
	if _, err := decoder.Token(); err != io.EOF {
		return envelope, fmt.Errorf("%w: trailing continuation data", ErrContinuationRejected)
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return envelope, fmt.Errorf("%w: malformed continuation envelope", ErrContinuationRejected)
	}
	if envelope.ProtocolVersion != 1 || envelope.Type != "continuation" || envelope.StateVersion != 1 ||
		!continuationIdentifier(envelope.RunID, 120, true) || !continuationIdentifier(envelope.Entry, 64, false) || !validHash(envelope.ModuleHash) ||
		envelope.FuelLimit < 1 || envelope.FuelLimit > MaxContinuationFuel || envelope.StepsUsed > envelope.FuelLimit ||
		envelope.MaxEffectBytes > MaxContinuationEffectBytes || envelope.EffectBytes > envelope.MaxEffectBytes ||
		envelope.EffectCursor == 0 || envelope.EffectCursor > envelope.StepsUsed || !validHash(envelope.EffectRequestHash) ||
		!validHash(envelope.EffectResultHash) || !validHash(envelope.StateHash) || len(envelope.State) == 0 || len(envelope.State) > MaxContinuationStateBytes {
		return ContinuationEnvelope{}, fmt.Errorf("%w: invalid continuation identity", ErrContinuationRejected)
	}
	if digestHex(envelope.State) != envelope.StateHash {
		return ContinuationEnvelope{}, fmt.Errorf("%w: continuation state digest mismatch", ErrContinuationRejected)
	}
	return envelope, nil
}

// DecodeContinuationEnvelope validates the public Swyp continuation v1 wire
// shape without importing language internals. maxBytes lets a concrete host
// transport impose a stricter bound than the protocol-wide maximum.
func DecodeContinuationEnvelope(raw []byte, maxBytes int) (ContinuationEnvelope, error) {
	if maxBytes < 1 || maxBytes > MaxContinuationEnvelopeBytes {
		return ContinuationEnvelope{}, fmt.Errorf("%w: invalid host continuation envelope limit", ErrContinuationRejected)
	}
	return decodeContinuationEnvelope(raw, maxBytes)
}

func continuationEnvelopeHash(envelope ContinuationEnvelope) (string, error) {
	binding := struct {
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
	}{envelope.ProtocolVersion, envelope.Type, envelope.StateVersion, envelope.RunID, envelope.ModuleHash, envelope.Entry,
		envelope.FuelLimit, envelope.StepsUsed, envelope.MaxEffectBytes, envelope.EffectBytes, envelope.EffectCursor,
		envelope.EffectRequestHash, envelope.EffectResultHash, envelope.StateHash}
	raw, err := json.Marshal(binding)
	if err != nil {
		return "", err
	}
	return digestHex(append([]byte(continuationBindingDomain), raw...)), nil
}

func (s *Supervisor) continuationBindingLocked(sequence uint64, checkpointHash, envelopeHash, stateHash string) (ContinuationBinding, error) {
	if !s.config.Continuation.Enabled {
		return ContinuationBinding{}, ErrContinuationUnavailable
	}
	if sequence == 0 || sequence != s.ledger.status.Committed || s.ledger.status.Issued != s.ledger.status.Committed {
		return ContinuationBinding{}, fmt.Errorf("%w: continuation cursor is not the latest fully committed effect", ErrContinuationRejected)
	}
	issued, issuedOK := s.ledger.issued[sequence]
	committed, committedOK := s.ledger.commits[sequence]
	if !issuedOK || !committedOK {
		return ContinuationBinding{}, fmt.Errorf("%w: continuation has no durable effect accounting", ErrContinuationRejected)
	}
	node, nodeOK := s.config.Kernel.Node(issued.NodeID)
	intent, intentOK := s.config.Kernel.IntentByKey("effect:v1:" + issued.RequestID)
	if !nodeOK || !intentOK || node.State != controlkernel.NodeSucceeded || intent.State != controlkernel.IntentCommitted ||
		node.TaskID != s.config.Plan.TaskID || intent.TaskID != s.config.Plan.TaskID || intent.NodeID != issued.NodeID ||
		intent.ID != committed.IntentID || intent.RequestHash != issued.RequestHash || intent.ResultHash != committed.ResultHash ||
		intent.AttemptID == "" || intent.LeaseID == "" || intent.Fence == 0 {
		return ContinuationBinding{}, fmt.Errorf("%w: committed effect identity is incomplete or changed", ErrContinuationRejected)
	}
	verification, verified := s.matchingVerificationLocked(node.ID, intent)
	if !verified || verification.EvidenceHash != committed.ReceiptHash {
		return ContinuationBinding{}, fmt.Errorf("%w: durable independent verification is missing or changed", ErrContinuationRejected)
	}
	if lease, exists := s.config.Kernel.Lease(node.ID); exists {
		if lease.ID != intent.LeaseID || lease.AttemptID != intent.AttemptID || lease.Fence != intent.Fence || lease.ExecutorID != s.config.ExecutorID {
			return ContinuationBinding{}, fmt.Errorf("%w: continuation execution epoch is stale", ErrContinuationRejected)
		}
	}
	return ContinuationBinding{
		Version: sealedContinuationVersion, TaskID: s.config.Plan.TaskID, RunID: s.config.Plan.RunID,
		ModuleHash: s.config.Plan.ModuleHash, Entry: s.config.Plan.Entry, PlanHash: s.planHash,
		ExecutionPolicyHash: s.config.ExecutionPolicyHash, MaxEffects: s.config.Plan.MaxEffects,
		MaxReadBytes: s.config.Plan.MaxReadBytes, FuelLimit: s.config.Plan.FuelLimit, MaxEffectBytes: s.config.Plan.MaxEffectBytes,
		DeadlineUnixMS: s.config.Plan.Deadline.UTC().UnixMilli(),
		EffectCursor:   sequence, NodeID: node.ID, AttemptID: intent.AttemptID, LeaseID: intent.LeaseID, Fence: intent.Fence,
		RequestHash: committed.RequestHash, ResultHash: committed.ResultHash, ReceiptHash: committed.ReceiptHash,
		IntentID: committed.IntentID, CheckpointHash: checkpointHash, EnvelopeHash: envelopeHash, StateHash: stateHash,
	}, nil
}

func sealAAD(record sealedContinuationRecord) ([]byte, error) {
	return json.Marshal(continuationAAD{
		Version: record.Version, Algorithm: record.Algorithm, KeyID: record.KeyID, Binding: record.Binding,
	})
}

func (s *Supervisor) sealContinuationLocked(binding ContinuationBinding, envelope []byte) ([]byte, string, error) {
	block, err := aes.NewCipher(s.config.Continuation.Key[:])
	if err != nil {
		return nil, "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, "", err
	}
	record := sealedContinuationRecord{
		Version: sealedContinuationVersion, Algorithm: ContinuationModeAES256GCM,
		KeyID: s.config.Continuation.KeyID, Binding: binding, Nonce: nonce,
	}
	aad, err := sealAAD(record)
	if err != nil {
		return nil, "", err
	}
	record.Ciphertext = aead.Seal(nil, nonce, envelope, aad)
	raw, err := json.Marshal(record)
	if err != nil {
		return nil, "", err
	}
	return raw, digestHex(raw), nil
}

func (s *Supervisor) continuationDirectoryLocked() string {
	return filepath.Join(s.config.Continuation.Directory, s.planHash)
}

func continuationRecordName(sequence uint64, recordHash string) string {
	return fmt.Sprintf("%020d-%s.sealed", sequence, recordHash)
}

func (s *Supervisor) continuationRecordPathLocked(payload continuationPayload) string {
	return filepath.Join(s.continuationDirectoryLocked(), continuationRecordName(payload.Sequence, payload.RecordHash))
}

func ensurePrivateDirectory(path string) error {
	if info, err := os.Lstat(path); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("continuation store path is not a real directory")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("continuation store directory creation failed")
	}
	return nil
}

func writeExclusiveRecord(path string, raw []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		existingFile, openErr := os.Open(path)
		if openErr != nil {
			return openErr
		}
		existing, readErr := io.ReadAll(io.LimitReader(existingFile, int64(len(raw))+1))
		closeErr := existingFile.Close()
		if readErr != nil {
			return readErr
		}
		if closeErr != nil {
			return closeErr
		}
		if len(existing) != len(raw) || !bytes.Equal(existing, raw) {
			return fmt.Errorf("%w: immutable continuation record collision", ErrContinuationRejected)
		}
		return nil
	}
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		_ = file.Close()
		if !ok {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(raw); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	ok = true
	return nil
}

func (s *Supervisor) persistContinuationRecordLocked(payload continuationPayload, raw []byte) error {
	if err := ensurePrivateDirectory(s.config.Continuation.Directory); err != nil {
		return err
	}
	dir := s.continuationDirectoryLocked()
	if err := ensurePrivateDirectory(dir); err != nil {
		return err
	}
	return writeExclusiveRecord(filepath.Join(dir, continuationRecordName(payload.Sequence, payload.RecordHash)), raw)
}

func (s *Supervisor) openSealedContinuationLocked(payload continuationPayload) (ResumeState, error) {
	if !s.config.Continuation.Enabled {
		return ResumeState{}, ErrContinuationUnavailable
	}
	if payload.KeyID != s.config.Continuation.KeyID || !validHash(payload.RecordHash) {
		return ResumeState{}, fmt.Errorf("%w: continuation key identity changed", ErrContinuationRejected)
	}
	path := s.continuationRecordPathLocked(payload)
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ResumeState{}, fmt.Errorf("%w: sealed continuation record missing", ErrContinuationRejected)
		}
		return ResumeState{}, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return ResumeState{}, fmt.Errorf("%w: sealed continuation record is not a regular file", ErrContinuationRejected)
	}
	file, err := os.Open(path)
	if err != nil {
		return ResumeState{}, err
	}
	defer file.Close()
	maxRecordBytes := int64(s.config.Continuation.MaxEnvelopeBytes)*2 + 64<<10
	raw, err := io.ReadAll(io.LimitReader(file, maxRecordBytes+1))
	if err != nil {
		return ResumeState{}, err
	}
	if int64(len(raw)) > maxRecordBytes || digestHex(raw) != payload.RecordHash {
		return ResumeState{}, fmt.Errorf("%w: sealed continuation record hash mismatch", ErrContinuationRejected)
	}
	var record sealedContinuationRecord
	if err := decodeSealedContinuationRecord(raw, &record); err != nil {
		return ResumeState{}, fmt.Errorf("%w: malformed sealed continuation record", ErrContinuationRejected)
	}
	if record.Version != sealedContinuationVersion || record.Algorithm != ContinuationModeAES256GCM || record.KeyID != s.config.Continuation.KeyID {
		return ResumeState{}, fmt.Errorf("%w: unsupported sealed continuation record", ErrContinuationRejected)
	}
	expected, err := s.continuationBindingLocked(payload.Sequence, payload.CheckpointHash, payload.EnvelopeHash, payload.StateHash)
	if err != nil {
		return ResumeState{}, err
	}
	if record.Binding != expected || record.Binding.EffectCursor != payload.Sequence || record.Binding.CheckpointHash != payload.CheckpointHash || record.Binding.EnvelopeHash != payload.EnvelopeHash ||
		record.Binding.StateHash != payload.StateHash || record.Binding.NodeID != payload.NodeID || record.Binding.AttemptID != payload.AttemptID ||
		record.Binding.LeaseID != payload.LeaseID || record.Binding.Fence != payload.Fence || record.Binding.RequestHash != payload.RequestHash ||
		record.Binding.ResultHash != payload.ResultHash || record.Binding.ReceiptHash != payload.ReceiptHash || record.Binding.IntentID != payload.IntentID {
		return ResumeState{}, fmt.Errorf("%w: sealed continuation binding mismatch", ErrContinuationRejected)
	}
	block, err := aes.NewCipher(s.config.Continuation.Key[:])
	if err != nil {
		return ResumeState{}, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return ResumeState{}, err
	}
	if len(record.Nonce) != aead.NonceSize() {
		return ResumeState{}, fmt.Errorf("%w: invalid continuation nonce", ErrContinuationRejected)
	}
	aad, err := sealAAD(record)
	if err != nil {
		return ResumeState{}, err
	}
	envelopeRaw, err := aead.Open(nil, record.Nonce, record.Ciphertext, aad)
	if err != nil {
		return ResumeState{}, fmt.Errorf("%w: continuation authentication failed", ErrContinuationRejected)
	}
	if digestHex(envelopeRaw) != expected.CheckpointHash {
		return ResumeState{}, fmt.Errorf("%w: continuation checkpoint digest mismatch", ErrContinuationRejected)
	}
	envelope, err := decodeContinuationEnvelope(envelopeRaw, s.config.Continuation.MaxEnvelopeBytes)
	if err != nil {
		return ResumeState{}, err
	}
	envelopeHash, err := continuationEnvelopeHash(envelope)
	if err != nil || envelopeHash != expected.EnvelopeHash {
		return ResumeState{}, fmt.Errorf("%w: continuation public envelope digest mismatch", ErrContinuationRejected)
	}
	if envelope.ModuleHash != s.config.Plan.ModuleHash || envelope.Entry != s.config.Plan.Entry || envelope.RunID != s.config.Plan.RunID ||
		envelope.EffectCursor != payload.Sequence || envelope.StateHash != payload.StateHash || envelope.FuelLimit != s.config.Plan.FuelLimit ||
		envelope.MaxEffectBytes != s.config.Plan.MaxEffectBytes || envelope.EffectRequestHash != expected.RequestHash || envelope.EffectResultHash != expected.ResultHash {
		return ResumeState{}, fmt.Errorf("%w: continuation program identity mismatch", ErrContinuationRejected)
	}
	checkpoint := envelope
	checkpoint.State = append([]byte(nil), envelope.State...)
	return ResumeState{Binding: expected, Checkpoint: checkpoint, Envelope: append([]byte(nil), envelopeRaw...)}, nil
}

// StoreContinuation seals the exact authority-free Swyp envelope only after the
// effect at its cursor is durably committed and independently verified.
func (s *Supervisor) StoreContinuation(ctx context.Context, envelopeRaw []byte) (ContinuationBinding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkLocked(); err != nil {
		return ContinuationBinding{}, err
	}
	if !s.config.Continuation.Enabled {
		return ContinuationBinding{}, ErrContinuationUnavailable
	}
	if err := ctx.Err(); err != nil {
		return ContinuationBinding{}, err
	}
	if !s.config.Now().Before(s.config.Plan.Deadline) || s.ledger.status.State != StateRunning || !s.startedHere ||
		s.ledger.status.Issued != s.ledger.status.Committed || s.ledger.status.Committed == 0 {
		return ContinuationBinding{}, fmt.Errorf("%w: continuation checkpoint is outside an active committed execution", ErrContinuationRejected)
	}
	envelope, err := decodeContinuationEnvelope(envelopeRaw, s.config.Continuation.MaxEnvelopeBytes)
	if err != nil {
		return ContinuationBinding{}, err
	}
	sequence := s.ledger.status.Committed
	if envelope.ModuleHash != s.config.Plan.ModuleHash || envelope.Entry != s.config.Plan.Entry || envelope.RunID != s.config.Plan.RunID ||
		envelope.EffectCursor != sequence || envelope.FuelLimit != s.config.Plan.FuelLimit || envelope.MaxEffectBytes != s.config.Plan.MaxEffectBytes {
		return ContinuationBinding{}, fmt.Errorf("%w: continuation checkpoint identity/cursor mismatch", ErrContinuationRejected)
	}
	committed := s.ledger.commits[sequence]
	if envelope.EffectRequestHash != committed.RequestHash || envelope.EffectResultHash != committed.ResultHash {
		return ContinuationBinding{}, fmt.Errorf("%w: continuation checkpoint is not bound to the verified durable effect result", ErrContinuationRejected)
	}
	if existing, ok := s.ledger.continuations[sequence]; ok {
		resume, err := s.openSealedContinuationLocked(existing)
		if err != nil {
			return ContinuationBinding{}, err
		}
		if !bytes.Equal(resume.Envelope, envelopeRaw) {
			return ContinuationBinding{}, fmt.Errorf("%w: effect cursor already bound to a different continuation", ErrContinuationRejected)
		}
		return resume.Binding, nil
	}
	checkpointHash := digestHex(envelopeRaw)
	envelopeHash, err := continuationEnvelopeHash(envelope)
	if err != nil {
		return ContinuationBinding{}, err
	}
	binding, err := s.continuationBindingLocked(sequence, checkpointHash, envelopeHash, envelope.StateHash)
	if err != nil {
		return ContinuationBinding{}, err
	}
	recordRaw, recordHash, err := s.sealContinuationLocked(binding, envelopeRaw)
	if err != nil {
		return ContinuationBinding{}, err
	}
	payload := continuationPayload{
		Sequence: sequence, RecordHash: recordHash, CheckpointHash: checkpointHash, EnvelopeHash: envelopeHash, StateHash: envelope.StateHash,
		KeyID: s.config.Continuation.KeyID, NodeID: binding.NodeID, AttemptID: binding.AttemptID, LeaseID: binding.LeaseID,
		Fence: binding.Fence, RequestHash: binding.RequestHash, ResultHash: binding.ResultHash, ReceiptHash: binding.ReceiptHash,
		IntentID: binding.IntentID,
	}
	if err := s.persistContinuationRecordLocked(payload, recordRaw); err != nil {
		return ContinuationBinding{}, err
	}
	if err := s.appendLocked(eventContinuation, payload); err != nil {
		return ContinuationBinding{}, err
	}
	return binding, nil
}

// BeginResume validates the latest sealed continuation against current durable
// ledger + Control Kernel evidence and authorizes exactly this supervisor
// process to accept the next effect. Swyp must still validate Envelope before it
// executes; this method never interprets or grants authority from guest state.
func (s *Supervisor) BeginResume(ctx context.Context) (ResumeState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkLocked(); err != nil {
		return ResumeState{}, err
	}
	if err := ctx.Err(); err != nil {
		return ResumeState{}, err
	}
	if !s.reopened || s.startedHere || s.ledger.status.State != StateRunning || s.ledger.status.Issued != s.ledger.status.Committed ||
		s.ledger.status.Committed == 0 || !s.config.Now().Before(s.config.Plan.Deadline) {
		return ResumeState{}, fmt.Errorf("%w: exact resume is not admissible", ErrContinuationRejected)
	}
	sequence := s.ledger.status.Committed
	payload, ok := s.ledger.continuations[sequence]
	if !ok {
		return ResumeState{}, ErrContinuationUnavailable
	}
	resume, err := s.openSealedContinuationLocked(payload)
	if err != nil {
		return ResumeState{}, err
	}
	s.startedHere = true
	s.resumeAuthorized = true
	return resume, nil
}

// ForgetResumeAuthorization is used when Swyp rejects the envelope before any
// new effect is admitted. Durable state is unchanged, so a later recovery can
// retry the same authenticated checkpoint.
func (s *Supervisor) ForgetResumeAuthorization() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reopened && s.ledger.status.Issued == s.ledger.status.Committed {
		s.startedHere = false
		s.resumeAuthorized = false
	}
}
