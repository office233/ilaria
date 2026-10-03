package devicesynth

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

func testDriverImageV1() []byte {
	image := make([]byte, 0x200)
	copy(image[:8], []byte{'S', 'W', 'Y', 'D', 'R', 'V', '1', 0})
	binary.LittleEndian.PutUint16(image[8:10], 1)
	binary.LittleEndian.PutUint16(image[10:12], DriverImageHeaderBytes)
	binary.LittleEndian.PutUint16(image[12:14], 2)
	binary.LittleEndian.PutUint64(image[24:32], 0x100)
	binary.LittleEndian.PutUint64(image[32:40], 0x3000)
	binary.LittleEndian.PutUint64(image[64:72], 0)
	binary.LittleEndian.PutUint64(image[72:80], 0x100)
	binary.LittleEndian.PutUint64(image[80:88], 4)
	binary.LittleEndian.PutUint64(image[88:96], 0x1000)
	binary.LittleEndian.PutUint64(image[96:104], DriverImageSegmentRead|DriverImageSegmentExecute)
	binary.LittleEndian.PutUint64(image[112:120], 0x2000)
	binary.LittleEndian.PutUint64(image[120:128], 0x110)
	binary.LittleEndian.PutUint64(image[128:136], 4)
	binary.LittleEndian.PutUint64(image[136:144], 0x1000)
	binary.LittleEndian.PutUint64(image[144:152], DriverImageSegmentRead|DriverImageSegmentWrite)
	copy(image[0x100:0x104], []byte{0x90, 0x90, 0x90, 0xc3})
	copy(image[0x110:0x114], []byte{0xde, 0xad, 0xbe, 0xef})
	return image
}

type fakeSynthesizer struct {
	candidate CandidateBundle
}

func (f fakeSynthesizer) Synthesize(_ context.Context, request SynthesisRequest) (SynthesisOutput, error) {
	if len(request.UnsupportedDevices) != 1 {
		return SynthesisOutput{}, errors.New("expected one unsupported device")
	}
	return SynthesisOutput{
		Candidate:             f.candidate,
		Assumptions:           append([]string(nil), f.candidate.Assumptions...),
		RequestedCapabilities: append([]LogicalCapability(nil), f.candidate.RequestedCapabilities...),
		Tests:                 append([]TestContract(nil), f.candidate.Tests...),
	}, nil
}

func TestUnknownDeviceSynthesisVerifyCanaryRollback(t *testing.T) {
	unknown := DeviceNode{
		ID:    "nic0",
		Kind:  DeviceNetwork,
		BusID: "pcie0",
		Identity: DeviceIdentity{
			StableID:  PrivacySafeDeviceID("pcie", "0000:02:00.0", "1234", "5678"),
			VendorID:  "1234",
			ProductID: "5678",
		},
		FirmwareDigest: HashBytes([]byte("nic-fw-1.0")),
	}
	manifest := HardwareManifest{
		SchemaVersion: HardwareManifestSchemaV1,
		Architecture:  ArchX8664,
		ABI:           "sysv64",
		Endianness:    EndianLittle,
		Firmware: []FirmwareDescriptor{
			{Kind: FirmwareUEFI, Version: "2.10", Digest: HashBytes([]byte("uefi-fixture"))},
			{Kind: FirmwareACPI, Version: "6.5", Digest: HashBytes([]byte("acpi-fixture"))},
		},
		Graph: DeviceGraph{
			SchemaVersion: DeviceGraphSchemaV1,
			Buses:         []BusDescriptor{{ID: "pcie0", Kind: BusPCIe}},
			Devices:       []DeviceNode{unknown},
			Resources: []DeviceResource{
				{DeviceID: unknown.ID, Kind: ResourceMMIO, Start: 0xfebf0000, Length: 0x1000},
				{DeviceID: unknown.ID, Kind: ResourceIRQ, Start: 17, Length: 1},
				{DeviceID: unknown.ID, Kind: ResourceDMA, Start: 0x20000000, Length: 0x2000},
				{DeviceID: unknown.ID, Kind: ResourceConfig, Start: 0, Length: 0x100},
				{DeviceID: unknown.ID, Kind: ResourceDeviceControl, Start: 1, Length: 1},
			},
		},
		ProbeSource:  "fixture",
		ProbeVersion: "1",
	}
	binding, err := HardwareBindingHash(manifest)
	if err != nil {
		t.Fatal(err)
	}

	source := []byte("driver source fixture")
	buildManifest := []byte("tool=swypik-driver-build\nflags=reproducible")
	toolchain := []byte("swypik-toolchain-fixture-v1")
	provenance := []EvidenceReference{{ID: "spec-nic", Digest: HashBytes([]byte("approved hardware specification")), Approved: true}}
	provenanceHash, err := CanonicalHash(provenance)
	if err != nil {
		t.Fatal(err)
	}
	tests := []TestContract{{ID: "protocol", Name: "fake-device protocol test", Required: true}, {ID: "fault", Name: "fault injection", Required: true}}
	artifactBytes := testDriverImageV1()
	candidate := CandidateBundle{
		Manifest: DriverManifest{
			SchemaVersion:        DriverManifestSchemaV1,
			ABIVersion:           DriverABIVersion1,
			Name:                 "fixture-nic-adapter",
			Version:              "0.0.1",
			Selector:             DeviceSelector{DeviceID: unknown.ID, Kind: unknown.Kind, VendorID: "1234", ProductID: "5678"},
			UserMode:             true,
			ImageFormat:          DriverImageFormatV1,
			DeclaredCapabilities: []LogicalCapability{CapabilityMMIO, CapabilityIRQ, CapabilityDMA, CapabilityConfig, CapabilityPower},
			Service:              ServiceInterface{Version: ServiceABIVersion1, Methods: []ServiceMethod{{Name: "Transmit", RequestSchemaHash: HashBytes([]byte("tx-req")), ResponseSchemaHash: HashBytes([]byte("tx-res"))}}},
			HardwareBindingHash:  binding,
			SourceHash:           HashBytes(source),
			BuildManifestHash:    HashBytes(buildManifest),
			BuildArtifactHash:    HashBytes(artifactBytes),
			ToolchainHash:        HashBytes(toolchain),
			ProvenanceHash:       provenanceHash,
		},
		Source:                source,
		BuildManifest:         buildManifest,
		ToolchainIdentity:     toolchain,
		Provenance:            provenance,
		Assumptions:           []string{"device implements the approved fixture register contract"},
		RequestedCapabilities: []LogicalCapability{CapabilityMMIO, CapabilityIRQ, CapabilityDMA, CapabilityConfig, CapabilityPower},
		ObservedCapabilities:  []LogicalCapability{CapabilityMMIO, CapabilityIRQ, CapabilityDMA, CapabilityConfig, CapabilityPower},
		Tests:                 tests,
		TestEvidence: []TestEvidence{
			{ContractID: "protocol", Passed: true, EvidenceHash: HashBytes([]byte("protocol-pass"))},
			{ContractID: "fault", Passed: true, EvidenceHash: HashBytes([]byte("fault-pass"))},
		},
	}

	synth := fakeSynthesizer{candidate: candidate}
	output, err := synth.Synthesize(context.Background(), SynthesisRequest{
		UnsupportedDevices: []DeviceNode{unknown},
		Hardware:           manifest,
		ABI:                ABI1(),
		Evidence:           provenance,
	})
	if err != nil {
		t.Fatal(err)
	}
	candidateDigest, err := output.Candidate.Digest()
	if err != nil {
		t.Fatal(err)
	}

	verifier := NewDeterministicVerifier("test-verifier")
	anchor, err := verifier.TrustAnchor()
	if err != nil {
		t.Fatal(err)
	}
	journalPath := filepath.Join(t.TempDir(), "device-adaptation.json")
	journal, err := OpenJournalForHardware(journalPath, binding, anchor)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := journal.Initialize(unknown.ID); err != nil {
		t.Fatal(err)
	}
	mustTransition(t, journal, StateProbe, StateMatch, TransitionEvidence{Reason: "hardware probe complete"})
	mustTransition(t, journal, StateMatch, StateSynthesize, TransitionEvidence{Reason: "no known signed driver matched"})
	mustTransition(t, journal, StateSynthesize, StateBuild, TransitionEvidence{CandidateDigest: candidateDigest, Reason: "candidate synthesized"})
	mustTransition(t, journal, StateBuild, StateVerify, TransitionEvidence{CandidateDigest: candidateDigest, Reason: "isolated build completed"})

	if _, err := journal.Transition(StateVerify, StateStage, TransitionEvidence{CandidateDigest: candidateDigest}); !errors.Is(err, ErrVerificationRequired) {
		t.Fatalf("unverified candidate reached STAGE: %v", err)
	}

	trustedTests := trustedTestsForCandidate(t, output.Candidate, artifactBytes)
	observation := trustedObservationForCandidate(t, output.Candidate, artifactBytes, output.Candidate.RequestedCapabilities)
	verification, err := verifier.Verify(context.Background(), VerificationRequest{
		Hardware:              manifest,
		Candidate:             output.Candidate,
		AllowedCapabilities:   ABI1().LogicalCapabilities,
		AllowedResourceGrants: testResourceGrants(manifest, output.Candidate),
		ApprovedEvidence:      provenance,
		BuiltArtifact:         artifactBytes,
		TrustedTestEvidence:   trustedTests,
		CapabilityObservation: observation,
		TargetState:           StateActive,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := verification.Error(); err != nil {
		t.Fatal(err)
	}

	artifact, err := NewArtifactManifest(output.Candidate, verification)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewLocalTrustRecord(artifact, verification, StateActive); err != nil {
		t.Fatal(err)
	}

	proof := TransitionEvidence{CandidateDigest: candidateDigest, ArtifactDigest: artifact.ArtifactDigest, Verification: &verification}
	mustTransition(t, journal, StateVerify, StateStage, proof)
	mustTransition(t, journal, StateStage, StateCanary, proof)
	healthOK := true
	activeProof := proof
	activeProof.HealthPassed = &healthOK
	mustTransition(t, journal, StateCanary, StateActive, activeProof)

	reopened, err := OpenJournalForHardware(journalPath, binding, anchor)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.Load(); err != nil {
		t.Fatalf("signed journal failed reload validation: %v", err)
	}

	mustTransition(t, journal, StateActive, StateRollback, TransitionEvidence{
		CandidateDigest: candidateDigest,
		ArtifactDigest:  artifact.ArtifactDigest,
		Reason:          "canary health regression after activation",
	})

	reloaded, err := journal.Load()
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Current != StateRollback {
		t.Fatalf("expected durable rollback state, got %s", reloaded.Current)
	}
	if reloaded.Sequence != 8 || len(reloaded.History) != 8 {
		t.Fatalf("expected 8 durable transitions, sequence=%d history=%d", reloaded.Sequence, len(reloaded.History))
	}
}

func TestVerifierRejectsUndeclaredCapabilityAndBindingMismatch(t *testing.T) {
	manifest, candidate := verifierFixture(t)
	candidate.Manifest.HardwareBindingHash = HashBytes([]byte("different-machine"))
	artifactBytes := []byte("artifact")
	result, err := NewDeterministicVerifier("").Verify(context.Background(), VerificationRequest{
		Hardware:              manifest,
		Candidate:             candidate,
		AllowedCapabilities:   ABI1().LogicalCapabilities,
		AllowedResourceGrants: testResourceGrants(manifest, candidate),
		ApprovedEvidence:      candidate.Provenance,
		BuiltArtifact:         artifactBytes,
		TrustedTestEvidence:   trustedTestsForCandidate(t, candidate, artifactBytes),
		CapabilityObservation: trustedObservationForCandidate(t, candidate, artifactBytes, []LogicalCapability{CapabilityConfig, CapabilityClock}),
		TargetState:           StateStage,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.OK {
		t.Fatal("verifier accepted undeclared capability and wrong hardware binding")
	}
}

func TestVerifierAcceptsIRCandidateWithoutSource(t *testing.T) {
	manifest, candidate := verifierFixture(t)
	candidate.IntermediateRepresentation = append([]byte(nil), candidate.Source...)
	candidate.Source = nil
	candidate.Manifest.SourceHash = HashBytes(candidate.IntermediateRepresentation)
	artifactBytes := []byte("artifact")
	result, err := NewDeterministicVerifier("").Verify(context.Background(), VerificationRequest{
		Hardware:              manifest,
		Candidate:             candidate,
		AllowedCapabilities:   ABI1().LogicalCapabilities,
		AllowedResourceGrants: testResourceGrants(manifest, candidate),
		ApprovedEvidence:      candidate.Provenance,
		BuiltArtifact:         artifactBytes,
		TrustedTestEvidence:   trustedTestsForCandidate(t, candidate, artifactBytes),
		CapabilityObservation: trustedObservationForCandidate(t, candidate, artifactBytes, candidate.RequestedCapabilities),
		TargetState:           StateStage,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := result.Error(); err != nil {
		t.Fatal(err)
	}
}

func TestFabricatedVerificationResultCannotStage(t *testing.T) {
	manifest, candidate := verifierFixture(t)
	binding, err := HardwareBindingHash(manifest)
	if err != nil {
		t.Fatal(err)
	}
	candidateDigest, err := candidate.Digest()
	if err != nil {
		t.Fatal(err)
	}
	verifier := NewDeterministicVerifier("trusted-verifier")
	anchor, err := verifier.TrustAnchor()
	if err != nil {
		t.Fatal(err)
	}
	journal, _ := journalAtVerify(t, binding, anchor, candidateDigest)
	fabricated := VerificationResult{
		VerifierID:          "trusted-verifier",
		VerifierVersion:     DefaultVerifierVersion,
		OK:                  true,
		TargetState:         StateActive,
		HardwareBindingHash: binding,
		CandidateDigest:     candidateDigest,
		ArtifactDigest:      candidate.Manifest.BuildArtifactHash,
	}
	_, err = journal.Transition(StateVerify, StateStage, TransitionEvidence{
		CandidateDigest: candidateDigest,
		ArtifactDigest:  candidate.Manifest.BuildArtifactHash,
		Verification:    &fabricated,
	})
	if !errors.Is(err, ErrVerificationRequired) {
		t.Fatalf("fabricated public VerificationResult staged candidate: %v", err)
	}
}

func TestTamperedAndStaleVerifierAttestationsFailClosed(t *testing.T) {
	manifest, candidate := verifierFixture(t)
	artifactBytes := testDriverImageV1()
	candidate.Manifest.ImageFormat = DriverImageFormatV1
	candidate.Manifest.BuildArtifactHash = HashBytes(artifactBytes)
	verifier := NewDeterministicVerifier("trusted-verifier")
	verification := verifyCandidate(t, verifier, manifest, candidate, artifactBytes, StateActive, candidate.Provenance, candidate.RequestedCapabilities)
	anchor, err := verifier.TrustAnchor()
	if err != nil {
		t.Fatal(err)
	}
	binding, err := HardwareBindingHash(manifest)
	if err != nil {
		t.Fatal(err)
	}
	candidateDigest, err := candidate.Digest()
	if err != nil {
		t.Fatal(err)
	}

	t.Run("tampered signature payload", func(t *testing.T) {
		journal, _ := journalAtVerify(t, binding, anchor, candidateDigest)
		tampered := verification
		attestation := *verification.Attestation
		attestation.EvidenceSummaryHash = HashBytes([]byte("tampered-summary"))
		tampered.Attestation = &attestation
		tampered.EvidenceSummaryHash = attestation.EvidenceSummaryHash
		_, err := journal.Transition(StateVerify, StateStage, TransitionEvidence{CandidateDigest: candidateDigest, ArtifactDigest: verification.ArtifactDigest, Verification: &tampered})
		if !errors.Is(err, ErrVerificationRequired) {
			t.Fatalf("tampered attestation was accepted: %v", err)
		}
	})

	t.Run("stale hardware binding", func(t *testing.T) {
		staleBinding := HashBytes([]byte("different-current-hardware"))
		journal, _ := journalAtVerify(t, staleBinding, anchor, candidateDigest)
		_, err := journal.Transition(StateVerify, StateStage, TransitionEvidence{CandidateDigest: candidateDigest, ArtifactDigest: verification.ArtifactDigest, Verification: &verification})
		if !errors.Is(err, ErrVerificationRequired) {
			t.Fatalf("stale hardware attestation was accepted: %v", err)
		}
	})

	t.Run("tampered persisted attestation", func(t *testing.T) {
		journal, path := journalAtVerify(t, binding, anchor, candidateDigest)
		mustTransition(t, journal, StateVerify, StateStage, TransitionEvidence{CandidateDigest: candidateDigest, ArtifactDigest: verification.ArtifactDigest, Verification: &verification})
		record, err := journal.Load()
		if err != nil {
			t.Fatal(err)
		}
		last := len(record.History) - 1
		record.History[last].VerificationAttestation.EvidenceSummaryHash = HashBytes([]byte("persisted-tamper"))
		record.History[last].VerificationDigest, err = CanonicalHash(*record.History[last].VerificationAttestation)
		if err != nil {
			t.Fatal(err)
		}
		record.History[last].Hash, err = transitionHash(record.History[last])
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.MarshalIndent(record, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := atomicWriteFile(path, append(encoded, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
		reopened, err := OpenJournalForHardware(path, binding, anchor)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := reopened.Load(); err == nil {
			t.Fatal("tampered persisted verifier attestation survived reload")
		}
	})
}

func TestVerifierRejectsCandidateOwnedAuthorityInputs(t *testing.T) {
	manifest, candidate := verifierFixture(t)
	artifactBytes := []byte("artifact")
	verifier := NewDeterministicVerifier("trusted-verifier")

	t.Run("self-approved provenance", func(t *testing.T) {
		candidate.Provenance[0].Approved = true
		result := verifyCandidateRaw(t, verifier, manifest, candidate, artifactBytes, StateStage, nil, candidate.RequestedCapabilities, trustedTestsForCandidate(t, candidate, artifactBytes))
		if result.OK {
			t.Fatal("candidate self-approved provenance without registry authority")
		}
	})

	t.Run("candidate fake Passed test", func(t *testing.T) {
		candidate.TestEvidence = []TestEvidence{{ContractID: "t1", Passed: true, EvidenceHash: HashBytes([]byte("candidate-fake-pass"))}}
		result := verifyCandidateRaw(t, verifier, manifest, candidate, artifactBytes, StateStage, candidate.Provenance, candidate.RequestedCapabilities, nil)
		if result.OK {
			t.Fatal("candidate-owned Passed=true satisfied trusted test gate")
		}
	})
}

func TestVerifierRejectsArtifactMismatchAndCapabilityBoundaryBypass(t *testing.T) {
	manifest, candidate := verifierFixture(t)
	verifier := NewDeterministicVerifier("trusted-verifier")

	t.Run("artifact bytes mismatch", func(t *testing.T) {
		tamperedArtifact := []byte("different-artifact-bytes")
		result := verifyCandidateRaw(t, verifier, manifest, candidate, tamperedArtifact, StateStage, candidate.Provenance, candidate.RequestedCapabilities, trustedTestsForCandidate(t, candidate, tamperedArtifact))
		if result.OK {
			t.Fatal("manifest accepted artifact bytes with mismatched SHA-256")
		}
	})

	t.Run("arbitrary capability rejected even if policy allows it", func(t *testing.T) {
		custom := candidate
		forbidden := LogicalCapability("kernel-memory")
		custom.RequestedCapabilities = append(append([]LogicalCapability(nil), candidate.RequestedCapabilities...), forbidden)
		custom.Manifest.DeclaredCapabilities = append(append([]LogicalCapability(nil), candidate.Manifest.DeclaredCapabilities...), forbidden)
		artifactBytes := []byte("artifact")
		candidateDigest, err := custom.Digest()
		if err != nil {
			t.Fatal(err)
		}
		observation := CapabilityObservation{ScannerID: "fixture-scanner", ScannerVersion: "1", CandidateDigest: candidateDigest, ArtifactDigest: HashBytes(artifactBytes), EvidenceHash: HashBytes([]byte("scan")), Capabilities: custom.RequestedCapabilities}
		result, err := verifier.Verify(context.Background(), VerificationRequest{
			Hardware: manifest, Candidate: custom,
			AllowedCapabilities:   append(append([]LogicalCapability(nil), ABI1().LogicalCapabilities...), forbidden),
			AllowedResourceGrants: testResourceGrants(manifest, custom),
			ApprovedEvidence:      custom.Provenance, BuiltArtifact: artifactBytes,
			TrustedTestEvidence: trustedTestsForCandidate(t, custom, artifactBytes), CapabilityObservation: observation, TargetState: StateStage,
		})
		if err != nil {
			t.Fatal(err)
		}
		if result.OK {
			t.Fatal("non-ABI capability was authorized by caller allowlist")
		}
	})

	t.Run("candidate omission cannot hide trusted scanner observation", func(t *testing.T) {
		custom := candidate
		custom.ObservedCapabilities = nil
		artifactBytes := []byte("artifact")
		result := verifyCandidateRaw(t, verifier, manifest, custom, artifactBytes, StateStage, custom.Provenance, []LogicalCapability{CapabilityConfig, CapabilityClock}, trustedTestsForCandidate(t, custom, artifactBytes))
		if result.OK {
			t.Fatal("candidate omission hid undeclared trusted scanner capability")
		}
	})
}

func TestCanaryRequiresStructurallyLoadableDriverImage(t *testing.T) {
	manifest, candidate := verifierFixture(t)
	artifactBytes := []byte("hash-valid-but-not-a-driver-image")
	candidate.Manifest.ImageFormat = DriverImageFormatV1
	candidate.Manifest.BuildArtifactHash = HashBytes(artifactBytes)
	verifier := NewDeterministicVerifier("driver-image-verifier")

	staged := verifyCandidateRaw(t, verifier, manifest, candidate, artifactBytes, StateStage,
		candidate.Provenance, candidate.RequestedCapabilities, trustedTestsForCandidate(t, candidate, artifactBytes))
	if err := staged.Error(); err != nil {
		t.Fatalf("STAGE should permit structurally intermediate artifact: %v", err)
	}

	canary := verifyCandidateRaw(t, verifier, manifest, candidate, artifactBytes, StateCanary,
		candidate.Provenance, candidate.RequestedCapabilities, trustedTestsForCandidate(t, candidate, artifactBytes))
	if canary.OK {
		t.Fatal("CANARY accepted a hash-valid artifact that is not Driver Image v1")
	}
	found := false
	for _, check := range canary.Checks {
		if check.Name == "driver_image_format" {
			found = true
			if check.Passed {
				t.Fatal("driver image structural check unexpectedly passed")
			}
		}
	}
	if !found {
		t.Fatal("driver_image_format verifier check missing")
	}
}

func TestHardwareManifestRejectsInvalidTopology(t *testing.T) {
	base := HardwareManifest{
		SchemaVersion: HardwareManifestSchemaV1,
		Architecture:  ArchX8664,
		ABI:           "sysv64",
		Endianness:    EndianLittle,
		Graph: DeviceGraph{
			SchemaVersion: DeviceGraphSchemaV1,
			Buses:         []BusDescriptor{{ID: "b0", Kind: BusPCIe}, {ID: "b1", Kind: BusUSB}},
			Devices: []DeviceNode{
				{ID: "a", Kind: DeviceNetwork, BusID: "b0", Identity: DeviceIdentity{StableID: PrivacySafeDeviceID("a")}},
				{ID: "b", Kind: DeviceStorage, BusID: "b1", Identity: DeviceIdentity{StableID: PrivacySafeDeviceID("b")}},
			},
		},
	}
	cases := map[string]HardwareManifest{}
	missingParent := base
	missingParent.Graph.Buses = []BusDescriptor{{ID: "b0", Kind: BusPCIe, ParentID: "missing"}, {ID: "b1", Kind: BusUSB}}
	cases["bus missing parent"] = missingParent
	busCycle := base
	busCycle.Graph.Buses = []BusDescriptor{{ID: "b0", Kind: BusPCIe, ParentID: "b1"}, {ID: "b1", Kind: BusUSB, ParentID: "b0"}}
	cases["bus parent cycle"] = busCycle
	selfEdge := base
	selfEdge.Graph.Edges = []DeviceEdge{{From: "a", To: "a", Relation: "depends-on"}}
	cases["device self edge"] = selfEdge
	deviceCycle := base
	deviceCycle.Graph.Edges = []DeviceEdge{{From: "a", To: "b", Relation: "depends-on"}, {From: "b", To: "a", Relation: "depends-on"}}
	cases["device cycle"] = deviceCycle
	duplicateEdge := base
	duplicateEdge.Graph.Edges = []DeviceEdge{{From: "a", To: "b", Relation: "depends-on"}, {From: "a", To: "b", Relation: "depends-on"}}
	cases["duplicate device edge"] = duplicateEdge

	for name, manifest := range cases {
		t.Run(name, func(t *testing.T) {
			if err := manifest.Validate(); err == nil {
				t.Fatal("invalid topology was accepted")
			}
		})
	}
}

func TestHardwareManifestResourceAuthorityValidation(t *testing.T) {
	device := DeviceNode{ID: "dev0", Kind: DeviceNetwork, BusID: "pcie0", Identity: DeviceIdentity{StableID: PrivacySafeDeviceID("pcie", "dev0")}}
	base := HardwareManifest{
		SchemaVersion: HardwareManifestSchemaV1,
		Architecture:  ArchX8664,
		ABI:           "win64",
		Endianness:    EndianLittle,
		Graph: DeviceGraph{
			SchemaVersion: DeviceGraphSchemaV1,
			Buses:         []BusDescriptor{{ID: "pcie0", Kind: BusPCIe}},
			Devices:       []DeviceNode{device},
			Resources: []DeviceResource{
				{DeviceID: device.ID, Kind: ResourceMMIO, Start: 0x1000, Length: 0x100},
				{DeviceID: device.ID, Kind: ResourceIRQ, Start: 17, Length: 1},
				{DeviceID: device.ID, Kind: ResourceConfig, Start: 0, Length: 0x100},
				{DeviceID: device.ID, Kind: ResourceDMA, Start: 0x20000000, Length: 0x2000},
				{DeviceID: device.ID, Kind: ResourceSharedMemory, Start: 0x30000000, Length: 0x4000},
			},
		},
	}
	if err := base.Validate(); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name string
		edit func(*HardwareManifest)
	}{
		{"unknown device", func(m *HardwareManifest) { m.Graph.Resources[0].DeviceID = "missing" }},
		{"zero length", func(m *HardwareManifest) { m.Graph.Resources[0].Length = 0 }},
		{"wrapped mmio", func(m *HardwareManifest) { m.Graph.Resources[0].Start, m.Graph.Resources[0].Length = ^uint64(0)-7, 16 }},
		{"invalid irq width", func(m *HardwareManifest) { m.Graph.Resources[1].Length = 2 }},
		{"config aperture overflow", func(m *HardwareManifest) { m.Graph.Resources[2].Start, m.Graph.Resources[2].Length = 4095, 2 }},
		{"unaligned dma", func(m *HardwareManifest) { m.Graph.Resources[3].Start++ }},
		{"unaligned shared memory", func(m *HardwareManifest) { m.Graph.Resources[4].Length = 0x4100 }},
		{"overlap", func(m *HardwareManifest) {
			m.Graph.Resources = append(m.Graph.Resources, DeviceResource{DeviceID: device.ID, Kind: ResourceMMIO, Start: 0x1080, Length: 0x20})
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clone := base
			clone.Graph.Resources = append([]DeviceResource(nil), base.Graph.Resources...)
			tt.edit(&clone)
			if err := clone.Validate(); err == nil {
				t.Fatal("invalid resource authority was accepted")
			}
		})
	}

	reordered := base
	reordered.Graph.Resources = []DeviceResource{base.Graph.Resources[4], base.Graph.Resources[2], base.Graph.Resources[0], base.Graph.Resources[3], base.Graph.Resources[1]}
	left, err := HardwareBindingHash(base)
	if err != nil {
		t.Fatal(err)
	}
	right, err := HardwareBindingHash(reordered)
	if err != nil {
		t.Fatal(err)
	}
	if left != right {
		t.Fatalf("resource order changed hardware binding: %s != %s", left, right)
	}
}

func TestProtectedVerificationRequiresConcreteCapabilityResources(t *testing.T) {
	manifest, candidate := verifierFixture(t)
	manifest.Graph.Resources = nil
	binding, err := HardwareBindingHash(manifest)
	if err != nil {
		t.Fatal(err)
	}
	candidate.Manifest.HardwareBindingHash = binding
	artifactBytes := []byte("artifact")
	result := verifyCandidateRaw(t, NewDeterministicVerifier("resource-verifier"), manifest, candidate, artifactBytes, StateStage,
		candidate.Provenance, candidate.RequestedCapabilities, trustedTestsForCandidate(t, candidate, artifactBytes))
	if result.OK {
		t.Fatal("protected verification accepted a capability with no concrete hardware resource")
	}
	found := false
	for _, check := range result.Checks {
		if check.Name == "concrete_resource_grants" {
			found = true
			if check.Passed {
				t.Fatal("concrete resource check unexpectedly passed")
			}
		}
	}
	if !found {
		t.Fatal("concrete resource verifier check missing")
	}
}

func TestProtectedVerificationRejectsOverbroadResourceRights(t *testing.T) {
	manifest, candidate := verifierFixture(t)
	grants := testResourceGrants(manifest, candidate)
	if len(grants) != 1 {
		t.Fatalf("fixture grants=%d want 1", len(grants))
	}
	grants[0].Rights |= ResourceRightControl
	artifactBytes := []byte("artifact")
	result, err := NewDeterministicVerifier("resource-rights-verifier").Verify(context.Background(), VerificationRequest{
		Hardware:              manifest,
		Candidate:             candidate,
		AllowedCapabilities:   ABI1().LogicalCapabilities,
		AllowedResourceGrants: grants,
		ApprovedEvidence:      candidate.Provenance,
		BuiltArtifact:         artifactBytes,
		TrustedTestEvidence:   trustedTestsForCandidate(t, candidate, artifactBytes),
		CapabilityObservation: trustedObservationForCandidate(t, candidate, artifactBytes, candidate.RequestedCapabilities),
		TargetState:           StateStage,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.OK {
		t.Fatal("protected verification accepted rights outside the resource-kind ceiling")
	}
}

func TestHardwareManifestRejectsUnknownPlatformClass(t *testing.T) {
	manifest := HardwareManifest{
		SchemaVersion: HardwareManifestSchemaV1,
		DeviceClass:   PlatformClass("spaceship"),
		Architecture:  ArchARM64,
		ABI:           "aapcs64",
		Endianness:    EndianLittle,
		Graph: DeviceGraph{
			SchemaVersion: DeviceGraphSchemaV1,
			Devices:       []DeviceNode{},
		},
	}
	if err := manifest.Validate(); err == nil {
		t.Fatal("unsupported platform class was accepted")
	}
}

func TestManifestDoesNotSerializeRawSerial(t *testing.T) {
	rawSerial := "SUPER-SECRET-SERIAL-123"
	manifest, _ := verifierFixture(t)
	manifest.Graph.Devices[0].Identity.SerialDigest = HashPrivateIdentifier(rawSerial)
	b, err := jsonMarshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte(rawSerial)) {
		t.Fatal("raw serial leaked into hardware manifest")
	}
	if !bytes.Contains(b, []byte("serial_digest")) {
		t.Fatal("expected privacy-safe serial digest")
	}
}

func mustTransition(t *testing.T, journal *Journal, from, to AdaptationState, evidence TransitionEvidence) {
	t.Helper()
	if _, err := journal.Transition(from, to, evidence); err != nil {
		t.Fatalf("transition %s -> %s: %v", from, to, err)
	}
}

func trustedTestsForCandidate(t *testing.T, candidate CandidateBundle, artifactBytes []byte) []TrustedTestEvidence {
	t.Helper()
	candidateDigest, err := candidate.Digest()
	if err != nil {
		t.Fatal(err)
	}
	artifactDigest := HashBytes(artifactBytes)
	out := make([]TrustedTestEvidence, 0, len(candidate.Tests))
	for _, contract := range candidate.Tests {
		if !contract.Required {
			continue
		}
		out = append(out, TrustedTestEvidence{
			ContractID:      contract.ID,
			RunnerID:        "fixture-runner",
			RunnerVersion:   "1",
			CandidateDigest: candidateDigest,
			ArtifactDigest:  artifactDigest,
			ToolchainHash:   candidate.Manifest.ToolchainHash,
			Passed:          true,
			EvidenceHash:    HashBytes([]byte("trusted-test:" + contract.ID)),
		})
	}
	return out
}

func testResourceGrants(manifest HardwareManifest, candidate CandidateBundle) []ResourceGrant {
	resources, err := ConcreteResourcesForCapabilities(manifest, candidate.Manifest.Selector.DeviceID, candidate.RequestedCapabilities)
	if err != nil {
		return nil
	}
	grants := make([]ResourceGrant, 0, len(resources))
	for _, resource := range resources {
		grants = append(grants, ResourceGrant{Resource: resource, Rights: AllowedRightsForResourceKind(resource.Kind)})
	}
	return grants
}

func trustedObservationForCandidate(t *testing.T, candidate CandidateBundle, artifactBytes []byte, capabilities []LogicalCapability) CapabilityObservation {
	t.Helper()
	candidateDigest, err := candidate.Digest()
	if err != nil {
		t.Fatal(err)
	}
	return CapabilityObservation{
		ScannerID:       "fixture-scanner",
		ScannerVersion:  "1",
		CandidateDigest: candidateDigest,
		ArtifactDigest:  HashBytes(artifactBytes),
		EvidenceHash:    HashBytes([]byte("trusted-static-scan")),
		Capabilities:    append([]LogicalCapability(nil), capabilities...),
	}
}

func verifyCandidate(t *testing.T, verifier DeterministicVerifier, manifest HardwareManifest, candidate CandidateBundle, artifactBytes []byte, target AdaptationState, approved []EvidenceReference, observed []LogicalCapability) VerificationResult {
	t.Helper()
	result := verifyCandidateRaw(t, verifier, manifest, candidate, artifactBytes, target, approved, observed, trustedTestsForCandidate(t, candidate, artifactBytes))
	if err := result.Error(); err != nil {
		t.Fatal(err)
	}
	if result.Attestation == nil {
		t.Fatal("successful protected verification did not issue attestation")
	}
	return result
}

func verifyCandidateRaw(t *testing.T, verifier DeterministicVerifier, manifest HardwareManifest, candidate CandidateBundle, artifactBytes []byte, target AdaptationState, approved []EvidenceReference, observed []LogicalCapability, tests []TrustedTestEvidence) VerificationResult {
	t.Helper()
	result, err := verifier.Verify(context.Background(), VerificationRequest{
		Hardware:              manifest,
		Candidate:             candidate,
		AllowedCapabilities:   ABI1().LogicalCapabilities,
		AllowedResourceGrants: testResourceGrants(manifest, candidate),
		ApprovedEvidence:      approved,
		BuiltArtifact:         artifactBytes,
		TrustedTestEvidence:   tests,
		CapabilityObservation: trustedObservationForCandidate(t, candidate, artifactBytes, observed),
		TargetState:           target,
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func journalAtVerify(t *testing.T, hardwareBinding string, anchor VerifierTrustAnchor, candidateDigest string) (*Journal, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "device-adaptation.json")
	journal, err := OpenJournalForHardware(path, hardwareBinding, anchor)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := journal.Initialize("dev0"); err != nil {
		t.Fatal(err)
	}
	mustTransition(t, journal, StateProbe, StateMatch, TransitionEvidence{Reason: "probe complete"})
	mustTransition(t, journal, StateMatch, StateSynthesize, TransitionEvidence{Reason: "unknown device"})
	mustTransition(t, journal, StateSynthesize, StateBuild, TransitionEvidence{CandidateDigest: candidateDigest, Reason: "candidate built"})
	mustTransition(t, journal, StateBuild, StateVerify, TransitionEvidence{CandidateDigest: candidateDigest, Reason: "build ready for verification"})
	return journal, path
}

func verifierFixture(t *testing.T) (HardwareManifest, CandidateBundle) {
	t.Helper()
	device := DeviceNode{ID: "dev0", Kind: DeviceNetwork, BusID: "usb0", Identity: DeviceIdentity{StableID: PrivacySafeDeviceID("usb", "1", "2"), VendorID: "1", ProductID: "2"}}
	manifest := HardwareManifest{SchemaVersion: HardwareManifestSchemaV1, Architecture: ArchARM64, ABI: "aapcs64", Endianness: EndianLittle, Graph: DeviceGraph{SchemaVersion: DeviceGraphSchemaV1, Buses: []BusDescriptor{{ID: "usb0", Kind: BusUSB}}, Devices: []DeviceNode{device}, Resources: []DeviceResource{{DeviceID: device.ID, Kind: ResourceConfig, Start: 0, Length: 0x100}}}}
	binding, err := HardwareBindingHash(manifest)
	if err != nil {
		t.Fatal(err)
	}
	source := []byte("fixture")
	build := []byte("build")
	toolchain := []byte("toolchain")
	provenance := []EvidenceReference{{ID: "ref", Digest: HashBytes([]byte("ref")), Approved: true}}
	provenanceHash, _ := CanonicalHash(provenance)
	candidate := CandidateBundle{
		Manifest: DriverManifest{SchemaVersion: DriverManifestSchemaV1, ABIVersion: DriverABIVersion1, Name: "fixture", Version: "1", Selector: DeviceSelector{DeviceID: "dev0", Kind: DeviceNetwork, VendorID: "1", ProductID: "2"}, UserMode: true, DeclaredCapabilities: []LogicalCapability{CapabilityConfig}, Service: ServiceInterface{Version: ServiceABIVersion1}, HardwareBindingHash: binding, SourceHash: HashBytes(source), BuildManifestHash: HashBytes(build), BuildArtifactHash: HashBytes([]byte("artifact")), ToolchainHash: HashBytes(toolchain), ProvenanceHash: provenanceHash},
		Source:   source, BuildManifest: build, ToolchainIdentity: toolchain, Provenance: provenance,
		RequestedCapabilities: []LogicalCapability{CapabilityConfig}, ObservedCapabilities: []LogicalCapability{CapabilityConfig},
		Tests: []TestContract{{ID: "t1", Name: "test", Required: true}}, TestEvidence: []TestEvidence{{ContractID: "t1", Passed: true, EvidenceHash: HashBytes([]byte("ok"))}},
	}
	return manifest, candidate
}

func jsonMarshal(v any) ([]byte, error) {
	return json.Marshal(v)
}
