package devicesynth

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const DefaultVerifierVersion = "devicesynth-verifier/v1"

type CheckResult struct {
	Name   string `json:"name"`
	Passed bool   `json:"passed"`
	Detail string `json:"detail,omitempty"`
}

type TrustedTestEvidence struct {
	ContractID      string `json:"contract_id"`
	RunnerID        string `json:"runner_id"`
	RunnerVersion   string `json:"runner_version"`
	CandidateDigest string `json:"candidate_digest"`
	ArtifactDigest  string `json:"artifact_digest"`
	ToolchainHash   string `json:"toolchain_hash"`
	Passed          bool   `json:"passed"`
	EvidenceHash    string `json:"evidence_hash"`
}

type CapabilityObservation struct {
	ScannerID       string              `json:"scanner_id"`
	ScannerVersion  string              `json:"scanner_version"`
	CandidateDigest string              `json:"candidate_digest"`
	ArtifactDigest  string              `json:"artifact_digest"`
	EvidenceHash    string              `json:"evidence_hash"`
	Capabilities    []LogicalCapability `json:"capabilities"`
}

type VerificationRequest struct {
	Hardware              HardwareManifest      `json:"hardware_manifest"`
	Candidate             CandidateBundle       `json:"candidate"`
	AllowedCapabilities   []LogicalCapability   `json:"allowed_capabilities"`
	ApprovedEvidence      []EvidenceReference   `json:"approved_evidence"`
	BuiltArtifact         []byte                `json:"-"`
	TrustedTestEvidence   []TrustedTestEvidence `json:"trusted_test_evidence"`
	CapabilityObservation CapabilityObservation `json:"capability_observation"`
	TargetState           AdaptationState       `json:"target_state"`
}

type VerificationResult struct {
	VerifierID          string                   `json:"verifier_id"`
	VerifierVersion     string                   `json:"verifier_version"`
	OK                  bool                     `json:"ok"`
	TargetState         AdaptationState          `json:"target_state"`
	HardwareBindingHash string                   `json:"hardware_binding_hash"`
	CandidateDigest     string                   `json:"candidate_digest"`
	ArtifactDigest      string                   `json:"artifact_digest"`
	TestEvidenceHash    string                   `json:"test_evidence_hash,omitempty"`
	EvidenceSummaryHash string                   `json:"evidence_summary_hash,omitempty"`
	Checks              []CheckResult            `json:"checks"`
	Attestation         *VerificationAttestation `json:"attestation,omitempty"`
}

type Verifier interface {
	Verify(ctx context.Context, request VerificationRequest) (VerificationResult, error)
}

type DeterministicVerifier struct {
	ID         string
	Version    string
	privateKey ed25519.PrivateKey
	publicKey  ed25519.PublicKey
	keyID      string
	initErr    error
}

func NewDeterministicVerifier(id string) DeterministicVerifier {
	if strings.TrimSpace(id) == "" {
		id = "devicesynth-default-v1"
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	verifier := DeterministicVerifier{ID: id, Version: DefaultVerifierVersion, privateKey: privateKey, publicKey: publicKey, initErr: err}
	if err == nil {
		verifier.keyID = HashBytes(publicKey)
	}
	return verifier
}

func NewDeterministicVerifierWithPrivateKey(id, version string, privateKey ed25519.PrivateKey) (DeterministicVerifier, error) {
	if strings.TrimSpace(id) == "" {
		return DeterministicVerifier{}, errors.New("verifier id is required")
	}
	if strings.TrimSpace(version) == "" {
		return DeterministicVerifier{}, errors.New("verifier version is required")
	}
	if len(privateKey) != ed25519.PrivateKeySize {
		return DeterministicVerifier{}, errors.New("invalid Ed25519 verifier private key")
	}
	privateCopy := append(ed25519.PrivateKey(nil), privateKey...)
	publicKey := append(ed25519.PublicKey(nil), privateCopy.Public().(ed25519.PublicKey)...)
	return DeterministicVerifier{
		ID:         id,
		Version:    version,
		privateKey: privateCopy,
		publicKey:  publicKey,
		keyID:      HashBytes(publicKey),
	}, nil
}

func (v DeterministicVerifier) TrustAnchor() (VerifierTrustAnchor, error) {
	if v.initErr != nil {
		return VerifierTrustAnchor{}, fmt.Errorf("initialize verifier signer: %w", v.initErr)
	}
	if len(v.publicKey) != ed25519.PublicKeySize || strings.TrimSpace(v.keyID) == "" {
		return VerifierTrustAnchor{}, errors.New("verifier has no signing authority")
	}
	return VerifierTrustAnchor{
		VerifierID:      v.ID,
		VerifierVersion: v.Version,
		KeyID:           v.keyID,
		PublicKey:       append([]byte(nil), v.publicKey...),
	}, nil
}

func (v DeterministicVerifier) Verify(ctx context.Context, request VerificationRequest) (VerificationResult, error) {
	if err := ctx.Err(); err != nil {
		return VerificationResult{}, err
	}
	if v.initErr != nil {
		return VerificationResult{}, fmt.Errorf("initialize verifier signer: %w", v.initErr)
	}
	result := VerificationResult{VerifierID: v.ID, VerifierVersion: v.Version, TargetState: request.TargetState}
	add := func(name string, passed bool, detail string) {
		result.Checks = append(result.Checks, CheckResult{Name: name, Passed: passed, Detail: detail})
	}

	bindingHash, bindingErr := HardwareBindingHash(request.Hardware)
	if bindingErr != nil {
		add("hardware_schema", false, bindingErr.Error())
	} else {
		result.HardwareBindingHash = bindingHash
		add("hardware_schema", true, "")
	}

	candidateDigest, candidateErr := request.Candidate.Digest()
	if candidateErr != nil {
		add("candidate_digest", false, candidateErr.Error())
	} else {
		result.CandidateDigest = candidateDigest
		add("candidate_digest", true, "")
	}

	manifest := request.Candidate.Manifest
	add("schema_abi",
		manifest.SchemaVersion == DriverManifestSchemaV1 && manifest.ABIVersion == DriverABIVersion1 && manifest.Service.Version == ServiceABIVersion1,
		"driver manifest, driver ABI and service ABI must all be v1")

	bound := bindingErr == nil && manifest.HardwareBindingHash == bindingHash
	add("hardware_firmware_binding", bound, "candidate must bind to the exact hardware/firmware manifest")

	matched := false
	for _, device := range request.Hardware.Graph.Devices {
		if manifest.Selector.Matches(device) {
			matched = true
			break
		}
	}
	add("target_selector", matched, "selector must identify exactly the intended manifest device")

	abiSet := abi1CapabilitySet()
	vocabularyOK := uniqueCapabilities(request.AllowedCapabilities) &&
		capabilitiesWithin(request.AllowedCapabilities, abiSet) &&
		uniqueCapabilities(request.Candidate.RequestedCapabilities) &&
		capabilitiesWithin(request.Candidate.RequestedCapabilities, abiSet) &&
		uniqueCapabilities(manifest.DeclaredCapabilities) &&
		capabilitiesWithin(manifest.DeclaredCapabilities, abiSet)
	add("capability_vocabulary", vocabularyOK, "allowed, requested and declared capabilities must use the closed Driver ABI v1 vocabulary")

	allowedSet := make(map[LogicalCapability]struct{}, len(request.AllowedCapabilities))
	for _, capability := range request.AllowedCapabilities {
		allowedSet[capability] = struct{}{}
	}
	requestedAllowed := vocabularyOK
	for _, capability := range request.Candidate.RequestedCapabilities {
		if _, ok := allowedSet[capability]; !ok {
			requestedAllowed = false
		}
	}
	add("allowed_capabilities", requestedAllowed, "requested capability set must be unique, ABI-v1 and policy-allowed")

	declared := normalizeCapabilities(manifest.DeclaredCapabilities)
	requested := normalizeCapabilities(request.Candidate.RequestedCapabilities)
	declaredMatch := len(declared) == len(requested)
	if declaredMatch {
		for i := range declared {
			if declared[i] != requested[i] {
				declaredMatch = false
				break
			}
		}
	}
	add("declared_capabilities", declaredMatch, "driver manifest declarations must equal the synthesis capability request")

	artifactDigest := ""
	artifactOK := true
	if stateRequiresBuiltArtifact(request.TargetState) {
		artifactOK = len(request.BuiltArtifact) > 0
		if artifactOK {
			artifactDigest = HashBytes(request.BuiltArtifact)
			artifactOK = artifactDigest == manifest.BuildArtifactHash
		}
	}
	result.ArtifactDigest = artifactDigest
	add("built_artifact", artifactOK, "trusted builder artifact bytes must hash exactly to the driver manifest")

	observationOK := trustedCapabilityObservationValid(request.CapabilityObservation, candidateDigest, artifactDigest, abiSet)
	add("trusted_capability_observation", observationOK, "capability observation must come from a bound external scanner result using Driver ABI v1")
	declaredSet := make(map[LogicalCapability]struct{}, len(manifest.DeclaredCapabilities))
	for _, capability := range manifest.DeclaredCapabilities {
		declaredSet[capability] = struct{}{}
	}
	noUndeclared := observationOK
	for _, capability := range request.CapabilityObservation.Capabilities {
		if _, ok := declaredSet[capability]; !ok {
			noUndeclared = false
			break
		}
	}
	add("no_undeclared_capability", noUndeclared, "trusted static/build observations may not exceed declared capabilities")
	add("user_mode_default", manifest.UserMode, "generated drivers are user-mode/capability-domain by default")

	sourceMaterial := request.Candidate.Source
	if len(sourceMaterial) == 0 {
		sourceMaterial = request.Candidate.IntermediateRepresentation
	}
	sourceHash := HashBytes(sourceMaterial)
	buildManifestHash := HashBytes(request.Candidate.BuildManifest)
	toolchainHash := HashBytes(request.Candidate.ToolchainIdentity)
	provenanceHash, provenanceErr := CanonicalHash(request.Candidate.Provenance)
	hashesOK := len(sourceMaterial) > 0 &&
		manifest.SourceHash == sourceHash &&
		manifest.BuildManifestHash == buildManifestHash &&
		manifest.ToolchainHash == toolchainHash &&
		provenanceErr == nil &&
		manifest.ProvenanceHash == provenanceHash
	add("source_build_toolchain_provenance_hashes", hashesOK, "source, build manifest, toolchain and provenance hashes must match exact candidate material")

	approvedEvidence := approvedProvenance(request.Candidate.Provenance, request.ApprovedEvidence)
	add("approved_provenance", approvedEvidence, "candidate provenance must match the externally approved evidence registry by exact id+digest; candidate Approved flags are ignored")

	testsOK := true
	if stateRequiresTestEvidence(request.TargetState) {
		testsOK = requiredTrustedTestsPassed(request.Candidate.Tests, request.TrustedTestEvidence, candidateDigest, artifactDigest, toolchainHash)
	}
	add("test_evidence", testsOK, "required tests need trusted runner evidence bound to candidate, artifact, contract and toolchain")

	testEvidenceHash, testEvidenceErr := CanonicalHash(request.TrustedTestEvidence)
	if testEvidenceErr == nil {
		result.TestEvidenceHash = testEvidenceHash
	}

	result.OK = len(result.Checks) > 0
	for _, check := range result.Checks {
		if !check.Passed {
			result.OK = false
			break
		}
	}

	summaryHash, summaryErr := CanonicalHash(struct {
		ApprovedEvidence      []EvidenceReference   `json:"approved_evidence"`
		TrustedTestEvidence   []TrustedTestEvidence `json:"trusted_test_evidence"`
		CapabilityObservation CapabilityObservation `json:"capability_observation"`
		Checks                []CheckResult         `json:"checks"`
	}{
		ApprovedEvidence:      request.ApprovedEvidence,
		TrustedTestEvidence:   request.TrustedTestEvidence,
		CapabilityObservation: request.CapabilityObservation,
		Checks:                result.Checks,
	})
	if summaryErr != nil {
		return VerificationResult{}, summaryErr
	}
	result.EvidenceSummaryHash = summaryHash

	if result.OK && verificationRank(request.TargetState) > 0 {
		attestation, err := signVerificationAttestation(VerificationAttestation{
			SchemaVersion:       VerificationAttestationV1,
			CandidateDigest:     result.CandidateDigest,
			HardwareBindingHash: result.HardwareBindingHash,
			ArtifactDigest:      result.ArtifactDigest,
			VerifierID:          result.VerifierID,
			VerifierVersion:     result.VerifierVersion,
			KeyID:               v.keyID,
			TargetState:         result.TargetState,
			EvidenceSummaryHash: result.EvidenceSummaryHash,
		}, v.privateKey)
		if err != nil {
			return VerificationResult{}, err
		}
		result.Attestation = &attestation
	}
	return result, nil
}

func abi1CapabilitySet() map[LogicalCapability]struct{} {
	spec := ABI1()
	set := make(map[LogicalCapability]struct{}, len(spec.LogicalCapabilities))
	for _, capability := range spec.LogicalCapabilities {
		set[capability] = struct{}{}
	}
	return set
}

func capabilitiesWithin(capabilities []LogicalCapability, allowed map[LogicalCapability]struct{}) bool {
	for _, capability := range capabilities {
		if _, ok := allowed[capability]; !ok {
			return false
		}
	}
	return true
}

func trustedCapabilityObservationValid(observation CapabilityObservation, candidateDigest, artifactDigest string, abiSet map[LogicalCapability]struct{}) bool {
	return strings.TrimSpace(observation.ScannerID) != "" &&
		strings.TrimSpace(observation.ScannerVersion) != "" &&
		validSHA256(observation.EvidenceHash) &&
		candidateDigest != "" &&
		artifactDigest != "" &&
		observation.CandidateDigest == candidateDigest &&
		observation.ArtifactDigest == artifactDigest &&
		uniqueCapabilities(observation.Capabilities) &&
		capabilitiesWithin(observation.Capabilities, abiSet)
}

func approvedProvenance(candidate, approved []EvidenceReference) bool {
	if len(candidate) == 0 || len(approved) == 0 {
		return false
	}
	registry := make(map[string]struct{}, len(approved))
	for _, ref := range approved {
		if strings.TrimSpace(ref.ID) == "" || !validSHA256(ref.Digest) {
			continue
		}
		registry[ref.ID+"\x00"+ref.Digest] = struct{}{}
	}
	for _, ref := range candidate {
		if strings.TrimSpace(ref.ID) == "" || !validSHA256(ref.Digest) {
			return false
		}
		if _, ok := registry[ref.ID+"\x00"+ref.Digest]; !ok {
			return false
		}
	}
	return true
}

func requiredTrustedTestsPassed(contracts []TestContract, evidence []TrustedTestEvidence, candidateDigest, artifactDigest, toolchainHash string) bool {
	required := 0
	byID := make(map[string]TrustedTestEvidence, len(evidence))
	for _, item := range evidence {
		if item.ContractID == "" ||
			strings.TrimSpace(item.RunnerID) == "" ||
			strings.TrimSpace(item.RunnerVersion) == "" ||
			!item.Passed ||
			!validSHA256(item.EvidenceHash) ||
			item.CandidateDigest != candidateDigest ||
			item.ArtifactDigest != artifactDigest ||
			item.ToolchainHash != toolchainHash {
			continue
		}
		if _, duplicate := byID[item.ContractID]; duplicate {
			return false
		}
		byID[item.ContractID] = item
	}
	for _, contract := range contracts {
		if !contract.Required {
			continue
		}
		required++
		if _, ok := byID[contract.ID]; !ok || contract.ID == "" {
			return false
		}
	}
	return required > 0
}

func validSHA256(value string) bool {
	const prefix = "sha256:"
	if !strings.HasPrefix(value, prefix) {
		return false
	}
	raw := strings.TrimPrefix(value, prefix)
	if len(raw) != 64 {
		return false
	}
	_, err := hex.DecodeString(raw)
	return err == nil
}

func stateRequiresTestEvidence(state AdaptationState) bool {
	return verificationRank(state) >= verificationRank(StateStage)
}

func stateRequiresBuiltArtifact(state AdaptationState) bool {
	switch state {
	case StateVerify, StateStage, StateCanary, StateActive:
		return true
	default:
		return false
	}
}

func (r VerificationResult) Error() error {
	if r.OK {
		return nil
	}
	for _, check := range r.Checks {
		if !check.Passed {
			return fmt.Errorf("verification failed at %s: %s", check.Name, check.Detail)
		}
	}
	return fmt.Errorf("verification failed")
}
