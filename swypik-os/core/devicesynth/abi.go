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
	DriverImageFormatV1    = "swypik.driver-image/v1"
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

type ResourceRight uint64

const (
	ResourceRightRead    ResourceRight = 1 << 0
	ResourceRightWrite   ResourceRight = 1 << 1
	ResourceRightMap     ResourceRight = 1 << 2
	ResourceRightBind    ResourceRight = 1 << 3
	ResourceRightAck     ResourceRight = 1 << 4
	ResourceRightSend    ResourceRight = 1 << 5
	ResourceRightReceive ResourceRight = 1 << 6
	ResourceRightControl ResourceRight = 1 << 7
)

type ResourceGrant struct {
	Resource DeviceResource `json:"resource"`
	Rights   ResourceRight  `json:"rights"`
}

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

func resourceKindForCapability(capability LogicalCapability) (DeviceResourceKind, bool) {
	switch capability {
	case CapabilityMMIO:
		return ResourceMMIO, true
	case CapabilityIOPort:
		return ResourcePortIO, true
	case CapabilityIRQ:
		return ResourceIRQ, true
	case CapabilityDMA:
		return ResourceDMA, true
	case CapabilityConfig:
		return ResourceConfig, true
	case CapabilityPower, CapabilityClock:
		return ResourceDeviceControl, true
	default:
		return "", false
	}
}

func AllowedRightsForResourceKind(kind DeviceResourceKind) ResourceRight {
	switch kind {
	case ResourceMMIO, ResourceDMA, ResourceSharedMemory:
		return ResourceRightRead | ResourceRightWrite | ResourceRightMap
	case ResourcePortIO:
		return ResourceRightRead | ResourceRightWrite
	case ResourceIRQ:
		return ResourceRightBind | ResourceRightAck
	case ResourceConfig:
		return ResourceRightRead | ResourceRightWrite
	case ResourceDeviceControl:
		return ResourceRightRead | ResourceRightControl
	default:
		return 0
	}
}

// ConcreteResourcesForCapabilities returns the exact probed resources that can
// back a verified logical capability request for one device. It fails closed if
// any requested capability has no concrete hardware resource in the manifest.
func ConcreteResourcesForCapabilities(manifest HardwareManifest, deviceID string, capabilities []LogicalCapability) ([]DeviceResource, error) {
	if err := manifest.Validate(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(deviceID) == "" {
		return nil, fmt.Errorf("device id is required")
	}
	deviceFound := false
	for _, device := range manifest.Graph.Devices {
		if device.ID == deviceID {
			deviceFound = true
			break
		}
	}
	if !deviceFound {
		return nil, fmt.Errorf("device %q is not present in hardware manifest", deviceID)
	}

	requiredKinds := make(map[DeviceResourceKind]struct{}, len(capabilities))
	for _, capability := range capabilities {
		kind, ok := resourceKindForCapability(capability)
		if !ok {
			return nil, fmt.Errorf("capability %q has no Driver ABI v1 hardware-resource mapping", capability)
		}
		requiredKinds[kind] = struct{}{}
	}
	if len(requiredKinds) == 0 {
		return nil, fmt.Errorf("at least one concrete driver capability is required")
	}

	foundKinds := make(map[DeviceResourceKind]bool, len(requiredKinds))
	resources := make([]DeviceResource, 0)
	for _, resource := range manifest.Graph.Resources {
		if resource.DeviceID != deviceID {
			continue
		}
		if _, required := requiredKinds[resource.Kind]; required {
			foundKinds[resource.Kind] = true
			resources = append(resources, resource)
		}
	}
	for kind := range requiredKinds {
		if !foundKinds[kind] {
			return nil, fmt.Errorf("device %q has no concrete %s resource for requested capability", deviceID, kind)
		}
	}
	return resources, nil
}

// ValidateResourceGrantPlan validates an externally-authorized, least-privilege
// grant plan against the exact hardware manifest and requested logical
// capabilities. It returns a canonical ordering suitable for evidence hashing.
func ValidateResourceGrantPlan(manifest HardwareManifest, deviceID string, capabilities []LogicalCapability, grants []ResourceGrant) ([]ResourceGrant, error) {
	if _, err := ConcreteResourcesForCapabilities(manifest, deviceID, capabilities); err != nil {
		return nil, err
	}
	if len(grants) == 0 {
		return nil, fmt.Errorf("explicit resource grants are required")
	}

	requiredKinds := make(map[DeviceResourceKind]struct{}, len(capabilities))
	for _, capability := range capabilities {
		kind, ok := resourceKindForCapability(capability)
		if !ok {
			return nil, fmt.Errorf("capability %q has no hardware-resource mapping", capability)
		}
		requiredKinds[kind] = struct{}{}
	}
	manifestResources := make(map[DeviceResource]struct{}, len(manifest.Graph.Resources))
	for _, resource := range manifest.Graph.Resources {
		manifestResources[resource] = struct{}{}
	}
	seenResources := make(map[DeviceResource]struct{}, len(grants))
	seenKinds := make(map[DeviceResourceKind]bool, len(requiredKinds))
	normalized := append([]ResourceGrant(nil), grants...)
	for _, grant := range normalized {
		if grant.Resource.DeviceID != deviceID {
			return nil, fmt.Errorf("resource grant targets device %q instead of %q", grant.Resource.DeviceID, deviceID)
		}
		if _, requested := requiredKinds[grant.Resource.Kind]; !requested {
			return nil, fmt.Errorf("resource grant kind %s was not requested by the candidate", grant.Resource.Kind)
		}
		if _, exists := manifestResources[grant.Resource]; !exists {
			return nil, fmt.Errorf("resource grant is not an exact member of the hardware manifest")
		}
		if _, duplicate := seenResources[grant.Resource]; duplicate {
			return nil, fmt.Errorf("duplicate resource grant for %s at 0x%x", grant.Resource.Kind, grant.Resource.Start)
		}
		allowed := AllowedRightsForResourceKind(grant.Resource.Kind)
		if grant.Rights == 0 || allowed == 0 || grant.Rights&^allowed != 0 {
			return nil, fmt.Errorf("resource grant rights 0x%x exceed %s rights 0x%x", uint64(grant.Rights), grant.Resource.Kind, uint64(allowed))
		}
		seenResources[grant.Resource] = struct{}{}
		seenKinds[grant.Resource.Kind] = true
	}
	for kind := range requiredKinds {
		if !seenKinds[kind] {
			return nil, fmt.Errorf("requested capability has no authorized %s resource grant", kind)
		}
	}
	sort.Slice(normalized, func(i, j int) bool {
		a, b := normalized[i], normalized[j]
		if a.Resource.DeviceID != b.Resource.DeviceID {
			return a.Resource.DeviceID < b.Resource.DeviceID
		}
		if a.Resource.Kind != b.Resource.Kind {
			return a.Resource.Kind < b.Resource.Kind
		}
		if a.Resource.Start != b.Resource.Start {
			return a.Resource.Start < b.Resource.Start
		}
		if a.Resource.Length != b.Resource.Length {
			return a.Resource.Length < b.Resource.Length
		}
		if a.Resource.Aux != b.Resource.Aux {
			return a.Resource.Aux < b.Resource.Aux
		}
		if a.Resource.Flags != b.Resource.Flags {
			return a.Resource.Flags < b.Resource.Flags
		}
		return a.Rights < b.Rights
	})
	return normalized, nil
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
	ImageFormat          string              `json:"image_format,omitempty"`
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
	ImageFormat         string         `json:"image_format,omitempty"`
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
		ImageFormat:         candidate.Manifest.ImageFormat,
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
