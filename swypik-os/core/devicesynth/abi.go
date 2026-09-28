package devicesynth

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

const (
	DriverManifestSchemaV1 = "swypik.driver-manifest/v1"
	DriverABIVersion1      = "swypik.driver-abi/v1"
	ServiceABIVersion1     = "swypik.device-service/v1"
	ArtifactManifestV1     = "swypik.driver-artifact/v1"
	LocalTrustRecordV1     = "swypik.local-trust/v1"
)

type LogicalCapability string

const (
	CapabilityMMIO   LogicalCapability = "mmio"
	CapabilityIOPort LogicalCapability = "ioport"
	CapabilityIRQ    LogicalCapability = "irq"
	CapabilityDMA    LogicalCapability = "dma"
	CapabilityConfig LogicalCapability = "config"
	CapabilityPower  LogicalCapability = "power"
	CapabilityClock  LogicalCapability = "clock"
)

type DriverABISpec struct {
	Version             string              `json:"version"`
	ServiceVersion      string              `json:"service_version"`
	LogicalCapabilities []LogicalCapability `json:"logical_capabilities"`
	UserModeByDefault   bool                `json:"user_mode_by_default"`
}

func ABI1() DriverABISpec {
	return DriverABISpec{
		Version:             DriverABIVersion1,
		ServiceVersion:      ServiceABIVersion1,
		LogicalCapabilities: []LogicalCapability{CapabilityMMIO, CapabilityIOPort, CapabilityIRQ, CapabilityDMA, CapabilityConfig, CapabilityPower, CapabilityClock},
		UserModeByDefault:   true,
	}
}

type DeviceSelector struct {
	DeviceID  string     `json:"device_id"`
	Kind      DeviceKind `json:"kind,omitempty"`
	VendorID  string     `json:"vendor_id,omitempty"`
	ProductID string     `json:"product_id,omitempty"`
}

func (s DeviceSelector) Matches(d DeviceNode) bool {
	if s.DeviceID == "" || s.DeviceID != d.ID {
		return false
	}
	if s.Kind != "" && s.Kind != d.Kind {
		return false
	}
	if s.VendorID != "" && s.VendorID != d.Identity.VendorID {
		return false
	}
	if s.ProductID != "" && s.ProductID != d.Identity.ProductID {
		return false
	}
	return true
}

type ServiceMethod struct {
	Name               string `json:"name"`
	RequestSchemaHash  string `json:"request_schema_hash"`
	ResponseSchemaHash string `json:"response_schema_hash"`
}

type ServiceInterface struct {
	Version string          `json:"version"`
	Methods []ServiceMethod `json:"methods"`
}

type EvidenceReference struct {
	ID       string `json:"id"`
	Location string `json:"location,omitempty"`
	Digest   string `json:"digest"`
	// Approved is legacy candidate metadata only. Verifier authority comes from
	// VerificationRequest.ApprovedEvidence exact ID+digest membership.
	Approved bool `json:"approved"`
}

type TestContract struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Required bool   `json:"required"`
}

type TestEvidence struct {
	// Candidate-owned test evidence is descriptive only and never authorizes a
	// protected transition. Trusted runner evidence is supplied separately.
	ContractID   string `json:"contract_id"`
	Passed       bool   `json:"passed"`
	EvidenceHash string `json:"evidence_hash"`
}

type DriverManifest struct {
	SchemaVersion        string              `json:"schema_version"`
	ABIVersion           string              `json:"abi_version"`
	Name                 string              `json:"name"`
	Version              string              `json:"version"`
	Selector             DeviceSelector      `json:"selector"`
	UserMode             bool                `json:"user_mode"`
	DeclaredCapabilities []LogicalCapability `json:"declared_capabilities"`
	Service              ServiceInterface    `json:"service_interface"`
	HardwareBindingHash  string              `json:"hardware_binding_hash"`
	SourceHash           string              `json:"source_hash"`
	BuildManifestHash    string              `json:"build_manifest_hash"`
	BuildArtifactHash    string              `json:"build_artifact_hash"`
	ToolchainHash        string              `json:"toolchain_hash"`
	ProvenanceHash       string              `json:"provenance_hash"`
}

type CandidateBundle struct {
	Manifest                   DriverManifest      `json:"manifest"`
	Source                     []byte              `json:"source,omitempty"`
	IntermediateRepresentation []byte              `json:"ir,omitempty"`
	BuildManifest              []byte              `json:"build_manifest"`
	ToolchainIdentity          []byte              `json:"toolchain_identity"`
	Provenance                 []EvidenceReference `json:"provenance"`
	Assumptions                []string            `json:"assumptions,omitempty"`
	RequestedCapabilities      []LogicalCapability `json:"requested_capabilities"`
	ObservedCapabilities       []LogicalCapability `json:"observed_capabilities,omitempty"`
	Tests                      []TestContract      `json:"tests"`
	TestEvidence               []TestEvidence      `json:"test_evidence,omitempty"`
}

func (c CandidateBundle) Digest() (string, error) {
	return CanonicalHash(c)
}

type SynthesisRequest struct {
	UnsupportedDevices []DeviceNode        `json:"unsupported_devices"`
	Hardware           HardwareManifest    `json:"hardware_manifest"`
	ABI                DriverABISpec       `json:"driver_abi"`
	Evidence           []EvidenceReference `json:"approved_evidence"`
}

type SynthesisOutput struct {
	Candidate             CandidateBundle     `json:"candidate"`
	Assumptions           []string            `json:"assumptions"`
	RequestedCapabilities []LogicalCapability `json:"requested_capabilities"`
	Tests                 []TestContract      `json:"tests"`
}

// Synthesizer is the constrained Ilaria boundary. The core package never calls
// a remote model; an installer injects a local or remote implementation explicitly.
type Synthesizer interface {
	Synthesize(ctx context.Context, request SynthesisRequest) (SynthesisOutput, error)
}

// ProbeSource allows Linux, firmware-native, hypervisor or future first-party
// probes to feed the same substrate-independent schema.
type ProbeSource interface {
	Probe(ctx context.Context) (HardwareManifest, error)
}

type MatchResult struct {
	DeviceID      string `json:"device_id"`
	KnownArtifact string `json:"known_artifact,omitempty"`
	Unsupported   bool   `json:"unsupported"`
}

type DriverMatcher interface {
	Match(ctx context.Context, manifest HardwareManifest) ([]MatchResult, error)
}

type ArtifactManifest struct {
	SchemaVersion       string         `json:"schema_version"`
	ArtifactDigest      string         `json:"artifact_digest"`
	CandidateDigest     string         `json:"candidate_digest"`
	DriverManifestHash  string         `json:"driver_manifest_hash"`
	HardwareBindingHash string         `json:"hardware_binding_hash"`
	ABIVersion          string         `json:"abi_version"`
	SourceHash          string         `json:"source_hash"`
	BuildManifestHash   string         `json:"build_manifest_hash"`
	BuildArtifactHash   string         `json:"build_artifact_hash"`
	ToolchainHash       string         `json:"toolchain_hash"`
	ProvenanceHash      string         `json:"provenance_hash"`
	TestEvidenceHash    string         `json:"test_evidence_hash"`
	Signature           *SignatureSlot `json:"signature,omitempty"`
}

type SignatureSlot struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"key_id"`
	Value     string `json:"value"`
}

type LocalTrustRecord struct {
	SchemaVersion       string          `json:"schema_version"`
	ArtifactDigest      string          `json:"artifact_digest"`
	HardwareBindingHash string          `json:"hardware_binding_hash"`
	VerifierID          string          `json:"verifier_id"`
	VerificationDigest  string          `json:"verification_digest"`
	AcceptedState       AdaptationState `json:"accepted_state"`
	Decision            string          `json:"decision"`
	Signature           *SignatureSlot  `json:"signature,omitempty"`
}

func NewArtifactManifest(candidate CandidateBundle, verification VerificationResult) (ArtifactManifest, error) {
	if !verification.OK {
		return ArtifactManifest{}, fmt.Errorf("cannot create artifact manifest from failed verification")
	}
	if verification.Attestation == nil {
		return ArtifactManifest{}, fmt.Errorf("cannot create artifact manifest without verifier attestation")
	}
	candidateDigest, err := candidate.Digest()
	if err != nil {
		return ArtifactManifest{}, err
	}
	if candidateDigest != verification.CandidateDigest {
		return ArtifactManifest{}, fmt.Errorf("candidate digest does not match verification")
	}
	if verification.ArtifactDigest == "" || verification.ArtifactDigest != candidate.Manifest.BuildArtifactHash {
		return ArtifactManifest{}, fmt.Errorf("verified artifact bytes do not match driver manifest")
	}
	driverManifestHash, err := CanonicalHash(candidate.Manifest)
	if err != nil {
		return ArtifactManifest{}, err
	}
	artifact := ArtifactManifest{
		SchemaVersion:       ArtifactManifestV1,
		ArtifactDigest:      verification.ArtifactDigest,
		CandidateDigest:     candidateDigest,
		DriverManifestHash:  driverManifestHash,
		HardwareBindingHash: candidate.Manifest.HardwareBindingHash,
		ABIVersion:          candidate.Manifest.ABIVersion,
		SourceHash:          candidate.Manifest.SourceHash,
		BuildManifestHash:   candidate.Manifest.BuildManifestHash,
		BuildArtifactHash:   candidate.Manifest.BuildArtifactHash,
		ToolchainHash:       candidate.Manifest.ToolchainHash,
		ProvenanceHash:      candidate.Manifest.ProvenanceHash,
		TestEvidenceHash:    verification.TestEvidenceHash,
	}
	return artifact, nil
}

func NewLocalTrustRecord(artifact ArtifactManifest, verification VerificationResult, acceptedState AdaptationState) (LocalTrustRecord, error) {
	if !verification.OK {
		return LocalTrustRecord{}, fmt.Errorf("failed verification cannot create trust record")
	}
	if verification.Attestation == nil {
		return LocalTrustRecord{}, fmt.Errorf("verification attestation is required")
	}
	if artifact.ArtifactDigest == "" || artifact.ArtifactDigest != verification.ArtifactDigest || artifact.HardwareBindingHash != verification.HardwareBindingHash {
		return LocalTrustRecord{}, fmt.Errorf("artifact is not bound to verified hardware")
	}
	if verificationRank(verification.TargetState) < verificationRank(acceptedState) {
		return LocalTrustRecord{}, fmt.Errorf("verification target does not authorize accepted state")
	}
	verificationDigest, err := CanonicalHash(*verification.Attestation)
	if err != nil {
		return LocalTrustRecord{}, err
	}
	return LocalTrustRecord{
		SchemaVersion:       LocalTrustRecordV1,
		ArtifactDigest:      artifact.ArtifactDigest,
		HardwareBindingHash: artifact.HardwareBindingHash,
		VerifierID:          verification.VerifierID,
		VerificationDigest:  verificationDigest,
		AcceptedState:       acceptedState,
		Decision:            "LOCAL_VERIFIED",
	}, nil
}

func normalizeCapabilities(in []LogicalCapability) []LogicalCapability {
	out := append([]LogicalCapability(nil), in...)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func uniqueCapabilities(in []LogicalCapability) bool {
	seen := make(map[LogicalCapability]struct{}, len(in))
	for _, capability := range in {
		if strings.TrimSpace(string(capability)) == "" {
			return false
		}
		if _, exists := seen[capability]; exists {
			return false
		}
		seen[capability] = struct{}{}
	}
	return true
}
