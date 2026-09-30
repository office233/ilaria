package pce

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"ilaria/generated/myriad"
	"ilaria/runtime/protocol"
	"ilaria/runtime/world"
)

const ReplayRecipeSupervisedV1 = "pce-supervised-v1"

type Options struct {
	CapsuleID            string
	SourceCellID         string
	SourceExpertID       string
	AncestryHash         string
	Domain               string
	ObservationSchema    string
	AbstractState        string
	ActionOrHypothesis   string
	RewardPPM            uint64
	VerifierEvidenceHash string
	ProvenanceRefs       []string
	ReplayRecipe         string
	ParameterDeltaHash   string
	CreatedUnixMS        int64
}

func NewFromWorldEvent(event myriad.WorldEvent, opts Options) (myriad.ExperienceCapsule, error) {
	if err := world.Validate(event); err != nil {
		return myriad.ExperienceCapsule{}, err
	}
	if !world.IsVerified(event) {
		return myriad.ExperienceCapsule{}, fmt.Errorf("pce: world event is not verifier-backed")
	}
	transferable, err := world.IsGloballyTransferable(event)
	if err != nil {
		return myriad.ExperienceCapsule{}, err
	}
	if !transferable {
		return myriad.ExperienceCapsule{}, fmt.Errorf("pce: privacy class %q is not globally transferable", event.PrivacyClass)
	}
	eventHash, err := world.Hash(event)
	if err != nil {
		return myriad.ExperienceCapsule{}, err
	}
	capsule := myriad.ExperienceCapsule{
		ProtocolVersion:      protocol.Version,
		CapsuleID:            opts.CapsuleID,
		SourceCellID:         opts.SourceCellID,
		SourceExpertID:       opts.SourceExpertID,
		AncestryHash:         opts.AncestryHash,
		Domain:               opts.Domain,
		ObservationSchema:    opts.ObservationSchema,
		WorldEventHash:       eventHash,
		AbstractState:        opts.AbstractState,
		ActionOrHypothesis:   opts.ActionOrHypothesis,
		Result:               event.Result,
		RewardPPM:            opts.RewardPPM,
		VerifierType:         event.Verifier,
		VerifierEvidenceHash: opts.VerifierEvidenceHash,
		PrivacyClass:         event.PrivacyClass,
		ProvenanceRefs:       append([]string(nil), opts.ProvenanceRefs...),
		ReplayRecipe:         opts.ReplayRecipe,
		ParameterDeltaHash:   opts.ParameterDeltaHash,
		CreatedUnixMS:        opts.CreatedUnixMS,
	}
	if err := ValidateUnsigned(capsule); err != nil {
		return myriad.ExperienceCapsule{}, err
	}
	return capsule, nil
}

func ValidateUnsigned(capsule myriad.ExperienceCapsule) error {
	if err := protocol.ValidateVersion(capsule.ProtocolVersion); err != nil {
		return err
	}
	for field, value := range map[string]string{
		"capsule_id":         capsule.CapsuleID,
		"source_cell_id":     capsule.SourceCellID,
		"source_expert_id":   capsule.SourceExpertID,
		"domain":             capsule.Domain,
		"observation_schema": capsule.ObservationSchema,
		"verifier_type":      capsule.VerifierType,
		"replay_recipe":      capsule.ReplayRecipe,
	} {
		if err := protocol.ValidateIdentifier(field, value); err != nil {
			return err
		}
	}
	for field, value := range map[string]string{
		"abstract_state":       capsule.AbstractState,
		"action_or_hypothesis": capsule.ActionOrHypothesis,
		"result":               capsule.Result,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("pce: %s is empty", field)
		}
	}
	if capsule.CreatedUnixMS <= 0 {
		return fmt.Errorf("pce: created_unix_ms must be positive")
	}
	if len(capsule.ProvenanceRefs) == 0 {
		return fmt.Errorf("pce: provenance_refs is empty")
	}
	for _, ref := range capsule.ProvenanceRefs {
		if err := protocol.ValidateIdentifier("provenance_ref", ref); err != nil {
			return err
		}
	}
	if err := protocol.ValidatePPM("reward_ppm", capsule.RewardPPM); err != nil {
		return err
	}
	if err := protocol.ValidateSHA256("ancestry_hash", capsule.AncestryHash, false); err != nil {
		return err
	}
	if err := protocol.ValidateSHA256("world_event_hash", capsule.WorldEventHash, false); err != nil {
		return err
	}
	if err := protocol.ValidateSHA256("verifier_evidence_hash", capsule.VerifierEvidenceHash, false); err != nil {
		return err
	}
	if err := protocol.ValidateSHA256("parameter_delta_hash", capsule.ParameterDeltaHash, true); err != nil {
		return err
	}
	transferable, err := protocol.IsGloballyTransferable(capsule.PrivacyClass)
	if err != nil {
		return err
	}
	if !transferable {
		return fmt.Errorf("pce: privacy class %q is not globally transferable", capsule.PrivacyClass)
	}
	return nil
}

func CheckReplayCompatibility(capsule myriad.ExperienceCapsule, targetAncestryHash string) error {
	if err := ValidateUnsigned(capsule); err != nil {
		return err
	}
	if err := protocol.ValidateSHA256("target_ancestry_hash", targetAncestryHash, false); err != nil {
		return err
	}
	if capsule.AncestryHash != targetAncestryHash {
		return fmt.Errorf("pce: ancestry mismatch")
	}
	return nil
}

func VerifyForReplay(capsule myriad.ExperienceCapsule, publicKey ed25519.PublicKey, targetAncestryHash string) error {
	if err := Verify(capsule, publicKey); err != nil {
		return err
	}
	return CheckReplayCompatibility(capsule, targetAncestryHash)
}

func ToReplayExample(capsule myriad.ExperienceCapsule, publicKey ed25519.PublicKey, targetAncestryHash string) (myriad.ReplayExample, error) {
	if err := VerifyForReplay(capsule, publicKey, targetAncestryHash); err != nil {
		return myriad.ReplayExample{}, err
	}
	if capsule.ReplayRecipe != ReplayRecipeSupervisedV1 {
		return myriad.ReplayExample{}, fmt.Errorf("pce: unsupported replay recipe %q", capsule.ReplayRecipe)
	}
	capsuleHash, err := ContentHash(capsule)
	if err != nil {
		return myriad.ReplayExample{}, err
	}
	prompt := fmt.Sprintf("<|pce:start|>\ndomain: %s\nstate: %s\n", capsule.Domain, capsule.AbstractState)
	target := fmt.Sprintf("%s\n<|obs:result|>\n%s\n<|result:verified|>\n<|pce:end|>", capsule.ActionOrHypothesis, capsule.Result)
	return myriad.ReplayExample{
		ProtocolVersion:      protocol.Version,
		CapsuleHash:          capsuleHash,
		AncestryHash:         capsule.AncestryHash,
		Domain:               capsule.Domain,
		Prompt:               prompt,
		Target:               target,
		VerifierEvidenceHash: capsule.VerifierEvidenceHash,
	}, nil
}

func ValidateSigned(capsule myriad.ExperienceCapsule) error {
	if err := ValidateUnsigned(capsule); err != nil {
		return err
	}
	if err := protocol.ValidateIdentifier("signer_key_id", capsule.SignerKeyID); err != nil {
		return err
	}
	if strings.TrimSpace(capsule.Signature) == "" {
		return fmt.Errorf("pce: signature is empty")
	}
	return nil
}

func canonicalPayload(capsule myriad.ExperienceCapsule) ([]byte, error) {
	capsule.Signature = ""
	raw, err := json.Marshal(capsule)
	if err != nil {
		return nil, fmt.Errorf("pce: canonical json: %w", err)
	}
	return raw, nil
}

func ContentHash(capsule myriad.ExperienceCapsule) (string, error) {
	if err := ValidateUnsigned(capsule); err != nil {
		return "", err
	}
	raw, err := canonicalPayload(capsule)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func Sign(capsule *myriad.ExperienceCapsule, signerKeyID string, privateKey ed25519.PrivateKey) error {
	if capsule == nil {
		return fmt.Errorf("pce: nil capsule")
	}
	if len(privateKey) != ed25519.PrivateKeySize {
		return fmt.Errorf("pce: invalid ed25519 private key length")
	}
	if err := protocol.ValidateIdentifier("signer_key_id", signerKeyID); err != nil {
		return err
	}
	capsule.SignerKeyID = signerKeyID
	capsule.Signature = ""
	if err := ValidateUnsigned(*capsule); err != nil {
		return err
	}
	payload, err := canonicalPayload(*capsule)
	if err != nil {
		return err
	}
	capsule.Signature = base64.RawStdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	return nil
}

func Verify(capsule myriad.ExperienceCapsule, publicKey ed25519.PublicKey) error {
	if err := ValidateSigned(capsule); err != nil {
		return err
	}
	if len(publicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("pce: invalid ed25519 public key length")
	}
	signature, err := base64.RawStdEncoding.DecodeString(capsule.Signature)
	if err != nil {
		return fmt.Errorf("pce: decode signature: %w", err)
	}
	if len(signature) != ed25519.SignatureSize {
		return fmt.Errorf("pce: invalid signature length")
	}
	payload, err := canonicalPayload(capsule)
	if err != nil {
		return err
	}
	if !ed25519.Verify(publicKey, payload, signature) {
		return fmt.Errorf("pce: signature verification failed")
	}
	return nil
}
