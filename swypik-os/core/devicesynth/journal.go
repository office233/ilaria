package devicesynth

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const AdaptationJournalSchemaV1 = "swypik.device-adaptation-journal/v1"

type AdaptationState string

const (
	StateProbe      AdaptationState = "PROBE"
	StateMatch      AdaptationState = "MATCH"
	StateSynthesize AdaptationState = "SYNTHESIZE"
	StateBuild      AdaptationState = "BUILD"
	StateVerify     AdaptationState = "VERIFY"
	StateStage      AdaptationState = "STAGE"
	StateCanary     AdaptationState = "CANARY"
	StateActive     AdaptationState = "ACTIVE"
	StateFailed     AdaptationState = "FAILED"
	StateRollback   AdaptationState = "ROLLBACK"
	StateSafeMode   AdaptationState = "SAFE_MODE"
)

var (
	ErrInvalidTransition    = errors.New("invalid adaptation transition")
	ErrStateConflict        = errors.New("adaptation state conflict")
	ErrVerificationRequired = errors.New("successful deterministic verification required")
)

type TransitionEvidence struct {
	CandidateDigest string
	ArtifactDigest  string
	Verification    *VerificationResult
	HealthPassed    *bool
	Reason          string
}

type TransitionRecord struct {
	Sequence                uint64                   `json:"sequence"`
	From                    AdaptationState          `json:"from"`
	To                      AdaptationState          `json:"to"`
	CandidateDigest         string                   `json:"candidate_digest,omitempty"`
	ArtifactDigest          string                   `json:"artifact_digest,omitempty"`
	VerificationDigest      string                   `json:"verification_digest,omitempty"`
	VerificationAttestation *VerificationAttestation `json:"verification_attestation,omitempty"`
	HealthPassed            *bool                    `json:"health_passed,omitempty"`
	Reason                  string                   `json:"reason,omitempty"`
	At                      time.Time                `json:"at"`
	PreviousHash            string                   `json:"previous_hash,omitempty"`
	Hash                    string                   `json:"hash"`
}

type AdaptationRecord struct {
	SchemaVersion string             `json:"schema_version"`
	DeviceID      string             `json:"device_id"`
	Current       AdaptationState    `json:"current"`
	Sequence      uint64             `json:"sequence"`
	History       []TransitionRecord `json:"history"`
}

type Journal struct {
	mu                  sync.Mutex
	path                string
	hardwareBindingHash string
	trustAnchors        map[string]VerifierTrustAnchor
}

func OpenJournal(path string, trustAnchors ...VerifierTrustAnchor) (*Journal, error) {
	return openJournal(path, "", trustAnchors...)
}

func OpenJournalForHardware(path, hardwareBindingHash string, trustAnchors ...VerifierTrustAnchor) (*Journal, error) {
	if !validSHA256(hardwareBindingHash) {
		return nil, errors.New("valid current hardware binding hash is required")
	}
	return openJournal(path, hardwareBindingHash, trustAnchors...)
}

func openJournal(path, hardwareBindingHash string, trustAnchors ...VerifierTrustAnchor) (*Journal, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("journal path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create journal directory: %w", err)
	}
	anchors := make(map[string]VerifierTrustAnchor, len(trustAnchors))
	for _, anchor := range trustAnchors {
		if strings.TrimSpace(anchor.VerifierID) == "" || strings.TrimSpace(anchor.VerifierVersion) == "" || strings.TrimSpace(anchor.KeyID) == "" || len(anchor.PublicKey) == 0 {
			return nil, errors.New("invalid verifier trust anchor")
		}
		key := trustAnchorKey(anchor.VerifierID, anchor.VerifierVersion, anchor.KeyID)
		if _, exists := anchors[key]; exists {
			return nil, fmt.Errorf("duplicate verifier trust anchor %q", anchor.KeyID)
		}
		copyAnchor := anchor
		copyAnchor.PublicKey = append([]byte(nil), anchor.PublicKey...)
		anchors[key] = copyAnchor
	}
	return &Journal{path: path, hardwareBindingHash: hardwareBindingHash, trustAnchors: anchors}, nil
}

func trustAnchorKey(verifierID, verifierVersion, keyID string) string {
	return verifierID + "\x00" + verifierVersion + "\x00" + keyID
}

func (j *Journal) Initialize(deviceID string) (AdaptationRecord, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if strings.TrimSpace(deviceID) == "" {
		return AdaptationRecord{}, errors.New("device id is required")
	}
	if existing, err := j.loadLocked(); err == nil {
		if existing.DeviceID != deviceID {
			return AdaptationRecord{}, fmt.Errorf("journal belongs to device %q", existing.DeviceID)
		}
		return existing, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return AdaptationRecord{}, err
	}
	record := AdaptationRecord{SchemaVersion: AdaptationJournalSchemaV1, DeviceID: deviceID, Current: StateProbe, History: []TransitionRecord{}}
	if err := j.saveLocked(record); err != nil {
		return AdaptationRecord{}, err
	}
	return record, nil
}

func (j *Journal) Load() (AdaptationRecord, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.loadLocked()
}

func (j *Journal) Transition(expected, to AdaptationState, evidence TransitionEvidence) (AdaptationRecord, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	record, err := j.loadLocked()
	if err != nil {
		return AdaptationRecord{}, err
	}
	if record.Current != expected {
		return AdaptationRecord{}, fmt.Errorf("%w: expected %s, current %s", ErrStateConflict, expected, record.Current)
	}
	if !transitionAllowed(expected, to) {
		return AdaptationRecord{}, fmt.Errorf("%w: %s -> %s", ErrInvalidTransition, expected, to)
	}
	verificationDigest, attestation, err := j.validateTransitionEvidence(to, evidence)
	if err != nil {
		return AdaptationRecord{}, err
	}

	transition := TransitionRecord{
		Sequence:                record.Sequence + 1,
		From:                    expected,
		To:                      to,
		CandidateDigest:         evidence.CandidateDigest,
		ArtifactDigest:          evidence.ArtifactDigest,
		VerificationDigest:      verificationDigest,
		VerificationAttestation: attestation,
		HealthPassed:            evidence.HealthPassed,
		Reason:                  evidence.Reason,
		At:                      time.Now().UTC(),
	}
	if len(record.History) > 0 {
		transition.PreviousHash = record.History[len(record.History)-1].Hash
	}
	transition.Hash, err = transitionHash(transition)
	if err != nil {
		return AdaptationRecord{}, err
	}
	record.Current = to
	record.Sequence = transition.Sequence
	record.History = append(record.History, transition)
	if err := j.saveLocked(record); err != nil {
		return AdaptationRecord{}, err
	}
	return record, nil
}

func (j *Journal) validateTransitionEvidence(to AdaptationState, evidence TransitionEvidence) (string, *VerificationAttestation, error) {
	if to == StateStage || to == StateCanary || to == StateActive {
		if to == StateActive && (evidence.HealthPassed == nil || !*evidence.HealthPassed) {
			return "", nil, errors.New("canary health proof required before ACTIVE")
		}
		if evidence.Verification == nil || !evidence.Verification.OK || evidence.Verification.Attestation == nil {
			return "", nil, ErrVerificationRequired
		}
		attestation := *evidence.Verification.Attestation
		if err := j.validateProtectedAttestation(to, evidence.CandidateDigest, evidence.ArtifactDigest, attestation); err != nil {
			return "", nil, err
		}
		if evidence.Verification.CandidateDigest != attestation.CandidateDigest ||
			evidence.Verification.HardwareBindingHash != attestation.HardwareBindingHash ||
			evidence.Verification.ArtifactDigest != attestation.ArtifactDigest ||
			evidence.Verification.VerifierID != attestation.VerifierID ||
			evidence.Verification.VerifierVersion != attestation.VerifierVersion ||
			evidence.Verification.TargetState != attestation.TargetState ||
			evidence.Verification.EvidenceSummaryHash != attestation.EvidenceSummaryHash {
			return "", nil, fmt.Errorf("%w: mutable verification result does not match signed attestation", ErrVerificationRequired)
		}
		digest, err := CanonicalHash(attestation)
		if err != nil {
			return "", nil, err
		}
		return digest, &attestation, nil
	}
	if to == StateRollback && strings.TrimSpace(evidence.Reason) == "" {
		return "", nil, errors.New("rollback requires a health/failure reason")
	}
	return "", nil, nil
}

func (j *Journal) validateProtectedAttestation(to AdaptationState, candidateDigest, artifactDigest string, attestation VerificationAttestation) error {
	if !validSHA256(candidateDigest) || candidateDigest != attestation.CandidateDigest {
		return fmt.Errorf("%w: candidate digest mismatch", ErrVerificationRequired)
	}
	if !validSHA256(artifactDigest) || artifactDigest != attestation.ArtifactDigest {
		return fmt.Errorf("%w: artifact digest mismatch", ErrVerificationRequired)
	}
	if !validSHA256(j.hardwareBindingHash) || attestation.HardwareBindingHash != j.hardwareBindingHash {
		return fmt.Errorf("%w: attestation is stale for current hardware binding", ErrVerificationRequired)
	}
	if verificationRank(attestation.TargetState) < verificationRank(to) {
		return fmt.Errorf("%w: verification target %s does not authorize %s", ErrVerificationRequired, attestation.TargetState, to)
	}
	anchor, ok := j.trustAnchors[trustAnchorKey(attestation.VerifierID, attestation.VerifierVersion, attestation.KeyID)]
	if !ok {
		return fmt.Errorf("%w: verifier trust anchor is not configured", ErrVerificationRequired)
	}
	if err := verifyVerificationAttestation(attestation, anchor); err != nil {
		return fmt.Errorf("%w: %v", ErrVerificationRequired, err)
	}
	return nil
}

func verificationRank(state AdaptationState) int {
	switch state {
	case StateStage:
		return 1
	case StateCanary:
		return 2
	case StateActive:
		return 3
	default:
		return 0
	}
}

func transitionAllowed(from, to AdaptationState) bool {
	allowed := map[AdaptationState]map[AdaptationState]bool{
		StateProbe:      {StateMatch: true, StateFailed: true, StateSafeMode: true},
		StateMatch:      {StateSynthesize: true, StateBuild: true, StateFailed: true, StateSafeMode: true},
		StateSynthesize: {StateBuild: true, StateFailed: true, StateSafeMode: true},
		StateBuild:      {StateVerify: true, StateFailed: true, StateRollback: true, StateSafeMode: true},
		StateVerify:     {StateStage: true, StateFailed: true, StateRollback: true, StateSafeMode: true},
		StateStage:      {StateCanary: true, StateFailed: true, StateRollback: true, StateSafeMode: true},
		StateCanary:     {StateActive: true, StateFailed: true, StateRollback: true, StateSafeMode: true},
		StateActive:     {StateFailed: true, StateRollback: true, StateSafeMode: true},
		StateFailed:     {StateRollback: true, StateSafeMode: true},
		StateRollback:   {StateActive: true, StateFailed: true, StateSafeMode: true},
		StateSafeMode:   {StateProbe: true},
	}
	return allowed[from][to]
}

func transitionHash(record TransitionRecord) (string, error) {
	record.Hash = ""
	return CanonicalHash(record)
}

func (j *Journal) loadLocked() (AdaptationRecord, error) {
	b, err := os.ReadFile(j.path)
	if err != nil {
		return AdaptationRecord{}, err
	}
	var record AdaptationRecord
	if err := json.Unmarshal(b, &record); err != nil {
		return AdaptationRecord{}, fmt.Errorf("decode adaptation journal: %w", err)
	}
	if err := j.validateRecord(record); err != nil {
		return AdaptationRecord{}, err
	}
	return record, nil
}

func (j *Journal) validateRecord(record AdaptationRecord) error {
	if record.SchemaVersion != AdaptationJournalSchemaV1 || record.DeviceID == "" || record.Current == "" {
		return errors.New("invalid adaptation journal header")
	}
	if uint64(len(record.History)) != record.Sequence {
		return errors.New("adaptation journal sequence/history mismatch")
	}
	previousHash := ""
	current := StateProbe
	for i, item := range record.History {
		if item.Sequence != uint64(i+1) || item.From != current || item.PreviousHash != previousHash || !transitionAllowed(item.From, item.To) {
			return fmt.Errorf("invalid adaptation journal transition at sequence %d", item.Sequence)
		}
		if item.To == StateStage || item.To == StateCanary || item.To == StateActive {
			if item.CandidateDigest == "" || item.ArtifactDigest == "" || item.VerificationDigest == "" || item.VerificationAttestation == nil {
				return fmt.Errorf("adaptation journal missing verification evidence at sequence %d", item.Sequence)
			}
			if err := j.validateProtectedAttestation(item.To, item.CandidateDigest, item.ArtifactDigest, *item.VerificationAttestation); err != nil {
				return fmt.Errorf("adaptation journal invalid verifier attestation at sequence %d: %w", item.Sequence, err)
			}
			digest, err := CanonicalHash(*item.VerificationAttestation)
			if err != nil || digest != item.VerificationDigest {
				return fmt.Errorf("adaptation journal verification digest mismatch at sequence %d", item.Sequence)
			}
		}
		if item.To == StateActive && (item.HealthPassed == nil || !*item.HealthPassed) {
			return fmt.Errorf("adaptation journal missing canary health proof at sequence %d", item.Sequence)
		}
		if item.To == StateRollback && strings.TrimSpace(item.Reason) == "" {
			return fmt.Errorf("adaptation journal missing rollback reason at sequence %d", item.Sequence)
		}
		expectedHash, err := transitionHash(item)
		if err != nil || expectedHash != item.Hash {
			return fmt.Errorf("adaptation journal hash-chain mismatch at sequence %d", item.Sequence)
		}
		previousHash = item.Hash
		current = item.To
	}
	if current != record.Current {
		return errors.New("adaptation journal current state mismatch")
	}
	return nil
}

func (j *Journal) saveLocked(record AdaptationRecord) error {
	b, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	return atomicWriteFile(j.path, b, 0o600)
}

func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, ".devicesynth-*.tmp")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	cleanup := func() {
		_ = temp.Close()
		_ = os.Remove(tempName)
	}
	if err := temp.Chmod(mode); err != nil {
		cleanup()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := temp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	if err := os.Rename(tempName, path); err != nil {
		_ = os.Remove(tempName)
		return fmt.Errorf("atomic journal replace: %w", err)
	}
	if directory, err := os.Open(dir); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}
