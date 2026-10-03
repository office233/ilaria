package universal_test

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"swypik-os/core/controlkernel"
	"swypik-os/core/devicesynth"
	"swypik-os/installer/universal"
)

func fixtureDriverImageV1() []byte {
	image := make([]byte, 0x200)
	copy(image[:8], []byte{'S', 'W', 'Y', 'D', 'R', 'V', '1', 0})
	binary.LittleEndian.PutUint16(image[8:10], 1)
	binary.LittleEndian.PutUint16(image[10:12], devicesynth.DriverImageHeaderBytes)
	binary.LittleEndian.PutUint16(image[12:14], 2)
	binary.LittleEndian.PutUint64(image[24:32], 0x100)
	binary.LittleEndian.PutUint64(image[32:40], 0x3000)
	binary.LittleEndian.PutUint64(image[72:80], 0x100)
	binary.LittleEndian.PutUint64(image[80:88], 4)
	binary.LittleEndian.PutUint64(image[88:96], 0x1000)
	binary.LittleEndian.PutUint64(image[96:104], devicesynth.DriverImageSegmentRead|devicesynth.DriverImageSegmentExecute)
	binary.LittleEndian.PutUint64(image[112:120], 0x2000)
	binary.LittleEndian.PutUint64(image[120:128], 0x110)
	binary.LittleEndian.PutUint64(image[128:136], 4)
	binary.LittleEndian.PutUint64(image[136:144], 0x1000)
	binary.LittleEndian.PutUint64(image[144:152], devicesynth.DriverImageSegmentRead|devicesynth.DriverImageSegmentWrite)
	copy(image[0x100:0x104], []byte{0x90, 0x90, 0x90, 0xc3})
	copy(image[0x110:0x114], []byte{0xde, 0xad, 0xbe, 0xef})
	return image
}

type adaptationAuth map[string]string

func (a adaptationAuth) AuthenticateVerifier(credential string) (controlkernel.VerifierPrincipal, error) {
	id, ok := a[credential]
	if !ok {
		return controlkernel.VerifierPrincipal{}, errors.New("invalid verifier credential")
	}
	return controlkernel.VerifierPrincipal{ID: id}, nil
}

func (a adaptationAuth) AuthenticateExecutor(credential string) (controlkernel.ExecutorPrincipal, error) {
	id, ok := a[credential]
	if !ok {
		return controlkernel.ExecutorPrincipal{}, errors.New("invalid executor credential")
	}
	return controlkernel.ExecutorPrincipal{ID: id}, nil
}

type unsupportedMatcher struct{ deviceID string }

func (m unsupportedMatcher) Match(_ context.Context, _ devicesynth.HardwareManifest) ([]devicesynth.MatchResult, error) {
	return []devicesynth.MatchResult{{DeviceID: m.deviceID, Unsupported: true}}, nil
}

type fixtureSynthesizer struct{ candidate devicesynth.CandidateBundle }

func (s fixtureSynthesizer) Synthesize(_ context.Context, request devicesynth.SynthesisRequest) (devicesynth.SynthesisOutput, error) {
	if len(request.UnsupportedDevices) != 1 || request.UnsupportedDevices[0].ID != s.candidate.Manifest.Selector.DeviceID {
		return devicesynth.SynthesisOutput{}, errors.New("unexpected synthesis target")
	}
	return devicesynth.SynthesisOutput{
		Candidate:             s.candidate,
		Assumptions:           append([]string(nil), s.candidate.Assumptions...),
		RequestedCapabilities: append([]devicesynth.LogicalCapability(nil), s.candidate.RequestedCapabilities...),
		Tests:                 append([]devicesynth.TestContract(nil), s.candidate.Tests...),
	}, nil
}

type fixtureBuilder struct{ artifact []byte }

func (b fixtureBuilder) Build(_ context.Context, _ devicesynth.CandidateBundle) ([]byte, error) {
	return append([]byte(nil), b.artifact...), nil
}

type fixtureRunner struct{}

func (fixtureRunner) Run(_ context.Context, candidate devicesynth.CandidateBundle, artifact []byte) ([]devicesynth.TrustedTestEvidence, error) {
	candidateDigest, err := candidate.Digest()
	if err != nil {
		return nil, err
	}
	artifactDigest := devicesynth.HashBytes(artifact)
	toolchainHash := devicesynth.HashBytes(candidate.ToolchainIdentity)
	evidence := make([]devicesynth.TrustedTestEvidence, 0, len(candidate.Tests))
	for _, contract := range candidate.Tests {
		if !contract.Required {
			continue
		}
		evidence = append(evidence, devicesynth.TrustedTestEvidence{
			ContractID:      contract.ID,
			RunnerID:        "installer-test-runner",
			RunnerVersion:   "v1",
			CandidateDigest: candidateDigest,
			ArtifactDigest:  artifactDigest,
			ToolchainHash:   toolchainHash,
			Passed:          true,
			EvidenceHash:    devicesynth.HashBytes([]byte("test:" + contract.ID)),
		})
	}
	return evidence, nil
}

type fixtureScanner struct{}

func (fixtureScanner) Scan(_ context.Context, candidate devicesynth.CandidateBundle, artifact []byte) (devicesynth.CapabilityObservation, error) {
	candidateDigest, err := candidate.Digest()
	if err != nil {
		return devicesynth.CapabilityObservation{}, err
	}
	return devicesynth.CapabilityObservation{
		ScannerID:       "installer-capability-scanner",
		ScannerVersion:  "v1",
		CandidateDigest: candidateDigest,
		ArtifactDigest:  devicesynth.HashBytes(artifact),
		EvidenceHash:    devicesynth.HashBytes([]byte("capability-scan")),
		Capabilities:    append([]devicesynth.LogicalCapability(nil), candidate.RequestedCapabilities...),
	}, nil
}

type fixtureDomain struct {
	health         universal.CanaryHealth
	activateCalls  int
	rollbackCalls  int
	lastActivation universal.DriverDomainActivation
}

func (d *fixtureDomain) ActivateCanary(_ context.Context, activation universal.DriverDomainActivation) (universal.DriverDomainReceipt, error) {
	d.activateCalls++
	d.lastActivation = activation
	return universal.DriverDomainReceipt{
		ExternalRef:  "driver-domain:canary:" + activation.Device.ID,
		EvidenceHash: devicesynth.HashBytes([]byte("canary:" + activation.Device.ID)),
	}, nil
}

func (d *fixtureDomain) CheckCanary(_ context.Context, _ universal.DriverDomainReceipt) (universal.CanaryHealth, error) {
	return d.health, nil
}

func (d *fixtureDomain) Rollback(_ context.Context, receipt universal.DriverDomainReceipt) (universal.DriverDomainReceipt, error) {
	d.rollbackCalls++
	return universal.DriverDomainReceipt{
		ExternalRef:  receipt.ExternalRef + ":rolled-back",
		EvidenceHash: devicesynth.HashBytes([]byte("rollback:" + receipt.ExternalRef)),
	}, nil
}

func adaptationFixture(t *testing.T) (devicesynth.HardwareManifest, devicesynth.DeviceNode, []devicesynth.EvidenceReference, devicesynth.CandidateBundle, []byte) {
	t.Helper()
	device := devicesynth.DeviceNode{
		ID:    "nic0",
		Kind:  devicesynth.DeviceNetwork,
		BusID: "pcie0",
		Identity: devicesynth.DeviceIdentity{
			StableID:  devicesynth.PrivacySafeDeviceID("pcie", "fixture-nic", "1234", "5678"),
			VendorID:  "1234",
			ProductID: "5678",
		},
		FirmwareDigest: devicesynth.HashBytes([]byte("fixture-firmware")),
	}
	manifest := devicesynth.HardwareManifest{
		SchemaVersion: devicesynth.HardwareManifestSchemaV1,
		DeviceClass:   devicesynth.PlatformWorkstation,
		Architecture:  devicesynth.ArchX8664,
		ABI:           "win64",
		Endianness:    devicesynth.EndianLittle,
		Graph: devicesynth.DeviceGraph{
			SchemaVersion: devicesynth.DeviceGraphSchemaV1,
			Buses:         []devicesynth.BusDescriptor{{ID: "pcie0", Kind: devicesynth.BusPCIe}},
			Devices:       []devicesynth.DeviceNode{device},
			Resources: []devicesynth.DeviceResource{
				{DeviceID: device.ID, Kind: devicesynth.ResourceMMIO, Start: 0xfebf0000, Length: 0x1000},
				{DeviceID: device.ID, Kind: devicesynth.ResourceIRQ, Start: 17, Length: 1},
				{DeviceID: device.ID, Kind: devicesynth.ResourceDMA, Start: 0x20000000, Length: 0x2000},
				{DeviceID: device.ID, Kind: devicesynth.ResourceConfig, Start: 0, Length: 0x100},
			},
		},
		ProbeSource:  "installer-test",
		ProbeVersion: "1",
	}
	binding, err := devicesynth.HardwareBindingHash(manifest)
	if err != nil {
		t.Fatal(err)
	}
	artifact := fixtureDriverImageV1()
	source := []byte("driver source fixture")
	buildManifest := []byte("tool=fixture-driver-builder\nreproducible=true")
	toolchain := []byte("fixture-toolchain-v1")
	approved := []devicesynth.EvidenceReference{{ID: "nic-spec", Digest: devicesynth.HashBytes([]byte("approved-nic-spec"))}}
	provenanceHash, err := devicesynth.CanonicalHash(approved)
	if err != nil {
		t.Fatal(err)
	}
	capabilities := []devicesynth.LogicalCapability{devicesynth.CapabilityMMIO, devicesynth.CapabilityIRQ, devicesynth.CapabilityDMA, devicesynth.CapabilityConfig}
	candidate := devicesynth.CandidateBundle{
		Manifest: devicesynth.DriverManifest{
			SchemaVersion:        devicesynth.DriverManifestSchemaV1,
			ABIVersion:           devicesynth.DriverABIVersion1,
			Name:                 "fixture-nic-driver",
			Version:              "0.0.1",
			Selector:             devicesynth.DeviceSelector{DeviceID: device.ID, Kind: device.Kind, VendorID: device.Identity.VendorID, ProductID: device.Identity.ProductID},
			UserMode:             true,
			ImageFormat:          devicesynth.DriverImageFormatV1,
			DeclaredCapabilities: append([]devicesynth.LogicalCapability(nil), capabilities...),
			Service: devicesynth.ServiceInterface{
				Version: devicesynth.ServiceABIVersion1,
				Methods: []devicesynth.ServiceMethod{{Name: "Transmit", RequestSchemaHash: devicesynth.HashBytes([]byte("tx-request")), ResponseSchemaHash: devicesynth.HashBytes([]byte("tx-response"))}},
			},
			HardwareBindingHash: binding,
			SourceHash:          devicesynth.HashBytes(source),
			BuildManifestHash:   devicesynth.HashBytes(buildManifest),
			BuildArtifactHash:   devicesynth.HashBytes(artifact),
			ToolchainHash:       devicesynth.HashBytes(toolchain),
			ProvenanceHash:      provenanceHash,
		},
		Source:                source,
		BuildManifest:         buildManifest,
		ToolchainIdentity:     toolchain,
		Provenance:            append([]devicesynth.EvidenceReference(nil), approved...),
		Assumptions:           []string{"fixture device follows approved register contract"},
		RequestedCapabilities: append([]devicesynth.LogicalCapability(nil), capabilities...),
		Tests: []devicesynth.TestContract{
			{ID: "protocol", Name: "protocol conformance", Required: true},
			{ID: "fault", Name: "fault injection", Required: true},
		},
	}
	return manifest, device, approved, candidate, artifact
}

func openAdaptationKernel(t *testing.T, verifierID string) (*controlkernel.Kernel, string, adaptationAuth) {
	t.Helper()
	auth := adaptationAuth{
		"executor-credential": "driver-executor",
		"verifier-credential": verifierID,
	}
	path := filepath.Join(t.TempDir(), "control-kernel.journal")
	kernel, err := controlkernel.OpenKernel(path,
		controlkernel.WithExecutorAuthenticator(auth),
		controlkernel.WithVerifierAuthenticator(auth),
	)
	if err != nil {
		t.Fatal(err)
	}
	return kernel, path, auth
}

func newAdaptationCoordinator(kernel *controlkernel.Kernel, deviceID string, candidate devicesynth.CandidateBundle, artifact []byte, verifier devicesynth.DeterministicVerifier, domain universal.DriverDomain) *universal.DeviceAdaptationCoordinator {
	return &universal.DeviceAdaptationCoordinator{
		Kernel:      kernel,
		Matcher:     unsupportedMatcher{deviceID: deviceID},
		Synthesizer: fixtureSynthesizer{candidate: candidate},
		Verifier:    verifier,
		Builder:     fixtureBuilder{artifact: artifact},
		Tests:       fixtureRunner{},
		Scanner:     fixtureScanner{},
		Domain:      domain,
	}
}

func adaptationRequest(operationID, journalPath string, manifest devicesynth.HardwareManifest, device devicesynth.DeviceNode, approved []devicesynth.EvidenceReference, candidate devicesynth.CandidateBundle) universal.DeviceAdaptationRequest {
	grants := make([]devicesynth.ResourceGrant, 0)
	requestedKinds := map[devicesynth.DeviceResourceKind]bool{}
	for _, capability := range candidate.RequestedCapabilities {
		switch capability {
		case devicesynth.CapabilityMMIO:
			requestedKinds[devicesynth.ResourceMMIO] = true
		case devicesynth.CapabilityIOPort:
			requestedKinds[devicesynth.ResourcePortIO] = true
		case devicesynth.CapabilityIRQ:
			requestedKinds[devicesynth.ResourceIRQ] = true
		case devicesynth.CapabilityDMA:
			requestedKinds[devicesynth.ResourceDMA] = true
		case devicesynth.CapabilityConfig:
			requestedKinds[devicesynth.ResourceConfig] = true
		case devicesynth.CapabilityPower, devicesynth.CapabilityClock:
			requestedKinds[devicesynth.ResourceDeviceControl] = true
		}
	}
	for _, resource := range manifest.Graph.Resources {
		if resource.DeviceID == device.ID && requestedKinds[resource.Kind] {
			grants = append(grants, devicesynth.ResourceGrant{Resource: resource, Rights: devicesynth.AllowedRightsForResourceKind(resource.Kind)})
		}
	}
	return universal.DeviceAdaptationRequest{
		OperationID:           operationID,
		Hardware:              manifest,
		DeviceID:              device.ID,
		ApprovedEvidence:      approved,
		AllowedCapabilities:   append([]devicesynth.LogicalCapability(nil), candidate.RequestedCapabilities...),
		AllowedResourceGrants: grants,
		JournalPath:           journalPath,
		ExecutorCredential:    "executor-credential",
		ExecutorOwner:         "installer-driver-worker",
		VerifierCredential:    "verifier-credential",
		LeaseTTL:              time.Minute,
	}
}

func TestDeviceAdaptationConnectsManifestVerificationKernelAndCanary(t *testing.T) {
	manifest, device, approved, candidate, artifact := adaptationFixture(t)
	verifier := devicesynth.NewDeterministicVerifier("driver-verifier")
	kernel, kernelPath, auth := openAdaptationKernel(t, verifier.ID)
	defer func() { _ = kernel.Close() }()
	domain := &fixtureDomain{health: universal.CanaryHealth{Passed: true, EvidenceHash: devicesynth.HashBytes([]byte("healthy"))}}
	coordinator := newAdaptationCoordinator(kernel, device.ID, candidate, artifact, verifier, domain)
	journalPath := filepath.Join(t.TempDir(), "device-adaptation.json")
	request := adaptationRequest("install-nic0-v1", journalPath, manifest, device, approved, candidate)
	for i := range request.AllowedResourceGrants {
		if request.AllowedResourceGrants[i].Resource.Kind == devicesynth.ResourceMMIO {
			request.AllowedResourceGrants[i].Rights = devicesynth.ResourceRightRead | devicesynth.ResourceRightMap
		}
	}

	result, err := coordinator.AdaptUnsupportedDevice(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if result.Journal.Current != devicesynth.StateActive || result.Intent.State != controlkernel.IntentCommitted {
		t.Fatalf("journal=%s intent=%s", result.Journal.Current, result.Intent.State)
	}
	if result.ControlVerification.Decision != controlkernel.VerificationPassed || result.ControlVerification.VerifierID != verifier.ID {
		t.Fatalf("control verification=%+v", result.ControlVerification)
	}
	if result.Trust.AcceptedState != devicesynth.StateActive || result.Trust.ArtifactDigest != result.Artifact.ArtifactDigest {
		t.Fatalf("trust record=%+v", result.Trust)
	}
	if domain.activateCalls != 1 || domain.rollbackCalls != 0 {
		t.Fatalf("domain activate=%d rollback=%d", domain.activateCalls, domain.rollbackCalls)
	}
	if domain.lastActivation.LeaseFence == 0 || domain.lastActivation.ControlLeaseID == "" || domain.lastActivation.ControlAttemptID == "" {
		t.Fatalf("driver-domain authority not bound to control lease: %+v", domain.lastActivation)
	}
	if len(domain.lastActivation.ResourceGrants) != len(candidate.RequestedCapabilities) {
		t.Fatalf("activation resource grants=%d requested capabilities=%d", len(domain.lastActivation.ResourceGrants), len(candidate.RequestedCapabilities))
	}
	foundNarrowMMIO := false
	for _, grant := range domain.lastActivation.ResourceGrants {
		if grant.Resource.Kind == devicesynth.ResourceMMIO {
			foundNarrowMMIO = true
			if grant.Rights != devicesynth.ResourceRightRead|devicesynth.ResourceRightMap {
				t.Fatalf("MMIO rights=0x%x want read+map", uint64(grant.Rights))
			}
		}
	}
	if !foundNarrowMMIO {
		t.Fatal("narrow MMIO grant missing from driver-domain activation")
	}
	normalizedGrants, err := devicesynth.ValidateResourceGrantPlan(manifest, device.ID, candidate.RequestedCapabilities, request.AllowedResourceGrants)
	if err != nil {
		t.Fatal(err)
	}
	grantHash, err := devicesynth.CanonicalHash(normalizedGrants)
	if err != nil {
		t.Fatal(err)
	}
	bindingHash, err := devicesynth.HardwareBindingHash(manifest)
	if err != nil {
		t.Fatal(err)
	}
	candidateDigest, err := candidate.Digest()
	if err != nil {
		t.Fatal(err)
	}
	expectedRequestHash, err := devicesynth.CanonicalHash(struct {
		HardwareBinding   string `json:"hardware_binding"`
		DeviceID          string `json:"device_id"`
		ArtifactDigest    string `json:"artifact_digest"`
		CandidateDigest   string `json:"candidate_digest"`
		ResourceGrantHash string `json:"resource_grant_hash"`
	}{bindingHash, device.ID, result.Artifact.ArtifactDigest, candidateDigest, grantHash})
	if err != nil {
		t.Fatal(err)
	}
	if result.Intent.RequestHash != expectedRequestHash {
		t.Fatalf("intent request hash=%s want %s", result.Intent.RequestHash, expectedRequestHash)
	}
	node, ok := kernel.Node(result.NodeID)
	if !ok || node.State != controlkernel.NodeSucceeded {
		t.Fatalf("node=%+v ok=%v", node, ok)
	}

	anchor, err := verifier.TrustAnchor()
	if err != nil {
		t.Fatal(err)
	}
	binding, err := devicesynth.HardwareBindingHash(manifest)
	if err != nil {
		t.Fatal(err)
	}
	journal, err := devicesynth.OpenJournalForHardware(journalPath, binding, anchor)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := journal.Load()
	if err != nil || replayed.Current != devicesynth.StateActive {
		t.Fatalf("replayed journal=%+v err=%v", replayed, err)
	}
	if err := kernel.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := controlkernel.OpenKernel(kernelPath,
		controlkernel.WithExecutorAuthenticator(auth),
		controlkernel.WithVerifierAuthenticator(auth),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	replayedNode, ok := reopened.Node(result.NodeID)
	if !ok || replayedNode.State != controlkernel.NodeSucceeded {
		t.Fatalf("replayed node=%+v ok=%v", replayedNode, ok)
	}
}

func TestDeviceAdaptationRollsBackUnhealthyCanary(t *testing.T) {
	manifest, device, approved, candidate, artifact := adaptationFixture(t)
	verifier := devicesynth.NewDeterministicVerifier("driver-verifier")
	kernel, _, _ := openAdaptationKernel(t, verifier.ID)
	defer kernel.Close()
	domain := &fixtureDomain{health: universal.CanaryHealth{
		Passed:       false,
		EvidenceHash: devicesynth.HashBytes([]byte("unhealthy")),
		Reason:       "fixture health probe failed",
	}}
	coordinator := newAdaptationCoordinator(kernel, device.ID, candidate, artifact, verifier, domain)
	journalPath := filepath.Join(t.TempDir(), "device-adaptation.json")

	result, err := coordinator.AdaptUnsupportedDevice(context.Background(), adaptationRequest("install-nic0-rollback", journalPath, manifest, device, approved, candidate))
	if !errors.Is(err, universal.ErrCanaryHealth) {
		t.Fatalf("error=%v", err)
	}
	if domain.activateCalls != 1 || domain.rollbackCalls != 1 {
		t.Fatalf("domain activate=%d rollback=%d", domain.activateCalls, domain.rollbackCalls)
	}
	if result.Journal.Current != devicesynth.StateFailed || result.Intent.State != controlkernel.IntentCommitted {
		t.Fatalf("partial result journal=%s intent=%s", result.Journal.Current, result.Intent.State)
	}
	node, ok := kernel.Node(result.NodeID)
	if !ok || node.State != controlkernel.NodeFailed {
		t.Fatalf("node=%+v ok=%v", node, ok)
	}
	anchor, anchorErr := verifier.TrustAnchor()
	if anchorErr != nil {
		t.Fatal(anchorErr)
	}
	binding, bindErr := devicesynth.HardwareBindingHash(manifest)
	if bindErr != nil {
		t.Fatal(bindErr)
	}
	journal, openErr := devicesynth.OpenJournalForHardware(journalPath, binding, anchor)
	if openErr != nil {
		t.Fatal(openErr)
	}
	replayed, loadErr := journal.Load()
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if replayed.Current != devicesynth.StateFailed {
		t.Fatalf("journal state=%s want FAILED", replayed.Current)
	}
}

func TestDeviceAdaptationVerifierIdentityMismatchStopsBeforeCanary(t *testing.T) {
	manifest, device, approved, candidate, artifact := adaptationFixture(t)
	verifier := devicesynth.NewDeterministicVerifier("driver-verifier")
	kernel, _, _ := openAdaptationKernel(t, "different-verifier")
	defer kernel.Close()
	domain := &fixtureDomain{health: universal.CanaryHealth{Passed: true, EvidenceHash: devicesynth.HashBytes([]byte("healthy"))}}
	coordinator := newAdaptationCoordinator(kernel, device.ID, candidate, artifact, verifier, domain)
	journalPath := filepath.Join(t.TempDir(), "device-adaptation.json")

	_, err := coordinator.AdaptUnsupportedDevice(context.Background(), adaptationRequest("identity-mismatch", journalPath, manifest, device, approved, candidate))
	if !errors.Is(err, controlkernel.ErrVerifierUnauthorized) {
		t.Fatalf("error=%v", err)
	}
	if domain.activateCalls != 0 || domain.rollbackCalls != 0 {
		t.Fatalf("external driver domain was touched: activate=%d rollback=%d", domain.activateCalls, domain.rollbackCalls)
	}
}

func TestDeviceAdaptationRejectsOverbroadResourceGrantBeforeCanary(t *testing.T) {
	manifest, device, approved, candidate, artifact := adaptationFixture(t)
	verifier := devicesynth.NewDeterministicVerifier("driver-verifier")
	kernel, _, _ := openAdaptationKernel(t, verifier.ID)
	defer kernel.Close()
	domain := &fixtureDomain{health: universal.CanaryHealth{Passed: true, EvidenceHash: devicesynth.HashBytes([]byte("healthy"))}}
	coordinator := newAdaptationCoordinator(kernel, device.ID, candidate, artifact, verifier, domain)
	request := adaptationRequest("overbroad-resource-rights", filepath.Join(t.TempDir(), "device-adaptation.json"), manifest, device, approved, candidate)
	if len(request.AllowedResourceGrants) == 0 {
		t.Fatal("fixture has no resource grants")
	}
	request.AllowedResourceGrants[0].Rights |= devicesynth.ResourceRightControl

	result, err := coordinator.AdaptUnsupportedDevice(context.Background(), request)
	if err == nil {
		t.Fatal("overbroad resource grant was accepted")
	}
	if domain.activateCalls != 0 || domain.rollbackCalls != 0 {
		t.Fatalf("driver domain touched despite rejected authority: activate=%d rollback=%d", domain.activateCalls, domain.rollbackCalls)
	}
	if node, ok := kernel.Node(result.NodeID); !ok || node.State != controlkernel.NodeFailed {
		t.Fatalf("node=%+v ok=%v want FAILED", node, ok)
	}
}

func ExampleDeviceAdaptationCoordinator() {
	fmt.Println("HardwareManifest -> DeviceSynth verification -> Control Kernel -> canary driver domain")
	// Output: HardwareManifest -> DeviceSynth verification -> Control Kernel -> canary driver domain
}
