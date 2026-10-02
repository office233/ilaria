package pce

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"

	"ilaria/generated/myriad"
	"ilaria/runtime/protocol"
)

const ReplayArtifactFormatV1 = "ilaria-pce-replay-v1"

func replayArtifactDigestPayload(artifact myriad.PCEReplayArtifact) []byte {
	fields := []string{
		artifact.Format,
		strconv.FormatUint(artifact.ProtocolVersion, 10),
		artifact.CapsuleHash,
		artifact.AncestryHash,
		artifact.Domain,
		artifact.DecisionPrompt,
		artifact.ActionTarget,
		artifact.VerifierEvidenceHash,
		artifact.SignerKeyID,
	}
	var buf bytes.Buffer
	for _, field := range fields {
		_, _ = fmt.Fprintf(&buf, "%d:", len([]byte(field)))
		buf.WriteString(field)
	}
	return buf.Bytes()
}

func ReplayArtifactHash(artifact myriad.PCEReplayArtifact) string {
	sum := sha256.Sum256(replayArtifactDigestPayload(artifact))
	return hex.EncodeToString(sum[:])
}

func BuildReplayArtifact(
	capsule myriad.ExperienceCapsule,
	publicKey ed25519.PublicKey,
	targetAncestryHash string,
) (myriad.PCEReplayArtifact, error) {
	example, err := ToReplayExample(capsule, publicKey, targetAncestryHash)
	if err != nil {
		return myriad.PCEReplayArtifact{}, err
	}
	// Preserve the signed action directly. Parsing the rendered replay target
	// would let a reserved marker inside the action silently truncate it.
	actionTarget := strings.TrimSpace(capsule.ActionOrHypothesis)
	if actionTarget == "" {
		return myriad.PCEReplayArtifact{}, fmt.Errorf("pce replay artifact: action target is empty")
	}
	artifact := myriad.PCEReplayArtifact{
		Format:               ReplayArtifactFormatV1,
		ProtocolVersion:      protocol.Version,
		CapsuleHash:          example.CapsuleHash,
		AncestryHash:         example.AncestryHash,
		Domain:               example.Domain,
		DecisionPrompt:       example.Prompt,
		ActionTarget:         actionTarget,
		VerifierEvidenceHash: example.VerifierEvidenceHash,
		SignerKeyID:          capsule.SignerKeyID,
	}
	artifact.ArtifactSha256 = ReplayArtifactHash(artifact)
	if err := ValidateReplayArtifact(artifact); err != nil {
		return myriad.PCEReplayArtifact{}, err
	}
	return artifact, nil
}

func ValidateReplayArtifact(artifact myriad.PCEReplayArtifact) error {
	if artifact.Format != ReplayArtifactFormatV1 {
		return fmt.Errorf("pce replay artifact: unsupported format %q", artifact.Format)
	}
	if err := protocol.ValidateVersion(artifact.ProtocolVersion); err != nil {
		return err
	}
	for field, value := range map[string]string{
		"domain":        artifact.Domain,
		"signer_key_id": artifact.SignerKeyID,
	} {
		if err := protocol.ValidateIdentifier(field, value); err != nil {
			return err
		}
	}
	for field, value := range map[string]string{
		"artifact_sha256":        artifact.ArtifactSha256,
		"capsule_hash":           artifact.CapsuleHash,
		"ancestry_hash":          artifact.AncestryHash,
		"verifier_evidence_hash": artifact.VerifierEvidenceHash,
	} {
		if err := protocol.ValidateSHA256(field, value, false); err != nil {
			return err
		}
	}
	if strings.TrimSpace(artifact.DecisionPrompt) == "" {
		return fmt.Errorf("pce replay artifact: decision_prompt is empty")
	}
	if strings.TrimSpace(artifact.ActionTarget) == "" {
		return fmt.Errorf("pce replay artifact: action_target is empty")
	}
	for _, forbidden := range []string{"<|obs:result|>", "<|result:verified|>", "<|pce:end|>"} {
		if strings.Contains(artifact.DecisionPrompt, forbidden) {
			return fmt.Errorf("pce replay artifact: decision_prompt contains post-action material")
		}
		if strings.Contains(artifact.ActionTarget, forbidden) {
			return fmt.Errorf("pce replay artifact: action_target contains post-action material")
		}
	}
	want := ReplayArtifactHash(artifact)
	if artifact.ArtifactSha256 != want {
		return fmt.Errorf("pce replay artifact: content hash mismatch")
	}
	return nil
}

func MarshalReplayArtifact(artifact myriad.PCEReplayArtifact) ([]byte, error) {
	if err := ValidateReplayArtifact(artifact); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(artifact)
	if err != nil {
		return nil, fmt.Errorf("pce replay artifact: marshal: %w", err)
	}
	return raw, nil
}

func ParseReplayArtifact(raw []byte) (myriad.PCEReplayArtifact, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var artifact myriad.PCEReplayArtifact
	if err := decoder.Decode(&artifact); err != nil {
		return myriad.PCEReplayArtifact{}, fmt.Errorf("pce replay artifact: decode: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return myriad.PCEReplayArtifact{}, fmt.Errorf("pce replay artifact: trailing JSON content")
		}
		return myriad.PCEReplayArtifact{}, fmt.Errorf("pce replay artifact: trailing JSON content: %w", err)
	}
	if err := ValidateReplayArtifact(artifact); err != nil {
		return myriad.PCEReplayArtifact{}, err
	}
	return artifact, nil
}
