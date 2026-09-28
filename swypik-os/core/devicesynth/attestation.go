package devicesynth

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const VerificationAttestationV1 = "swypik.verification-attestation/v1"

type VerifierTrustAnchor struct {
	VerifierID      string `json:"verifier_id"`
	VerifierVersion string `json:"verifier_version"`
	KeyID           string `json:"key_id"`
	PublicKey       []byte `json:"public_key"`
}

type VerificationAttestation struct {
	SchemaVersion       string          `json:"schema_version"`
	CandidateDigest     string          `json:"candidate_digest"`
	HardwareBindingHash string          `json:"hardware_binding_hash"`
	ArtifactDigest      string          `json:"artifact_digest"`
	VerifierID          string          `json:"verifier_id"`
	VerifierVersion     string          `json:"verifier_version"`
	KeyID               string          `json:"key_id"`
	TargetState         AdaptationState `json:"target_state"`
	EvidenceSummaryHash string          `json:"evidence_summary_hash"`
	Signature           string          `json:"signature"`
}

func attestationPayload(attestation VerificationAttestation) ([]byte, error) {
	attestation.Signature = ""
	return json.Marshal(attestation)
}

func signVerificationAttestation(attestation VerificationAttestation, privateKey ed25519.PrivateKey) (VerificationAttestation, error) {
	if len(privateKey) != ed25519.PrivateKeySize {
		return VerificationAttestation{}, errors.New("invalid verifier private key")
	}
	payload, err := attestationPayload(attestation)
	if err != nil {
		return VerificationAttestation{}, err
	}
	attestation.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	return attestation, nil
}

func verifyVerificationAttestation(attestation VerificationAttestation, anchor VerifierTrustAnchor) error {
	if attestation.SchemaVersion != VerificationAttestationV1 {
		return fmt.Errorf("unsupported verification attestation schema %q", attestation.SchemaVersion)
	}
	if strings.TrimSpace(attestation.CandidateDigest) == "" ||
		strings.TrimSpace(attestation.HardwareBindingHash) == "" ||
		strings.TrimSpace(attestation.ArtifactDigest) == "" ||
		strings.TrimSpace(attestation.EvidenceSummaryHash) == "" {
		return errors.New("verification attestation is missing required binding")
	}
	if attestation.VerifierID != anchor.VerifierID ||
		attestation.VerifierVersion != anchor.VerifierVersion ||
		attestation.KeyID != anchor.KeyID {
		return errors.New("verification attestation does not match trusted verifier identity")
	}
	if len(anchor.PublicKey) != ed25519.PublicKeySize {
		return errors.New("invalid verifier trust anchor public key")
	}
	signature, err := base64.StdEncoding.DecodeString(attestation.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return errors.New("invalid verification attestation signature encoding")
	}
	payload, err := attestationPayload(attestation)
	if err != nil {
		return err
	}
	if !ed25519.Verify(ed25519.PublicKey(anchor.PublicKey), payload, signature) {
		return errors.New("verification attestation signature mismatch")
	}
	return nil
}
