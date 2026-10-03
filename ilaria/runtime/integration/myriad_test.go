package integration

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"

	"ilaria/generated/myriad"
	"ilaria/runtime/connectome"
	"ilaria/runtime/pce"
	"ilaria/runtime/protocol"
	"ilaria/runtime/router"
)

const genesisHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestCellATeachesCellBAndConnectomeStrengthens(t *testing.T) {
	event := myriad.WorldEvent{
		ProtocolVersion: protocol.Version,
		EventID:         "evt-vehicle-a-1",
		DeviceClass:     "vehicle",
		SourceNamespace: "obd2-replay",
		ObservationType: "diagnostic",
		Features:        map[string]string{"dtc": "P0301", "rpm": "820"},
		Action:          "inspect-cylinder-1",
		Result:          "misfire confirmed",
		Verifier:        "obd-replay-v1",
		ConfidencePPM:   990_000,
		PrivacyClass:    string(protocol.PrivacyDeviceNonPersonal),
	}
	capsule, err := pce.NewFromWorldEvent(event, pce.Options{
		CapsuleID:            "capsule-vehicle-a-1",
		SourceCellID:         "cell-a",
		SourceExpertID:       "DeviceCortex",
		AncestryHash:         genesisHash,
		Domain:               "automotive.diagnostics",
		ObservationSchema:    "world-event-v1",
		AbstractState:        "single-cylinder misfire signature",
		ActionOrHypothesis:   "inspect cylinder 1",
		RewardPPM:            950_000,
		VerifierEvidenceHash: genesisHash,
		ProvenanceRefs:       []string{"replay:obd-fixture-v1"},
		ReplayRecipe:         pce.ReplayRecipeSupervisedV1,
		CreatedUnixMS:        1_800_000_000_000,
	})
	if err != nil {
		t.Fatal(err)
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := pce.Sign(&capsule, "cell-a-key-1", priv); err != nil {
		t.Fatal(err)
	}
	if err := pce.VerifyForReplay(capsule, pub, genesisHash); err != nil {
		t.Fatalf("cell B rejected a valid replay: %v", err)
	}
	if err := pce.CheckReplayCompatibility(capsule, "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"); err == nil {
		t.Fatal("ancestry mismatch must reject replay")
	}

	capsuleHash, err := pce.ContentHash(capsule)
	if err != nil {
		t.Fatal(err)
	}
	graph, err := connectome.New(connectome.Policy{
		TrustWeightPPM:          500_000,
		GainWeightPPM:           500_000,
		LatencyPenaltyWeightPPM: 100_000,
		ComputePenaltyWeightPPM: 100_000,
		LatencyBudgetMicros:     100_000,
		ComputeBudget:           10_000,
		MinObservations:         1,
	})
	if err != nil {
		t.Fatal(err)
	}
	edge, err := graph.Observe(myriad.SynapseObservation{
		ProtocolVersion:     protocol.Version,
		SourceExpertID:      "ThalamusRouter",
		TargetExpertID:      "DeviceCortex",
		DomainSignature:     "automotive.diagnostics",
		VerifiedSuccess:     true,
		VerifiedGainPPM:     900_000,
		LatencyMicros:       10_000,
		ComputeCost:         1_000,
		TargetExpertVersion: "device-v1",
		VerifierEvidenceRef: "pce:" + capsuleHash,
	})
	if err != nil {
		t.Fatal(err)
	}
	if edge.TrustPPM != protocol.MaxPPM || edge.SuccessfulHandoffs != 1 {
		t.Fatalf("verified teaching did not strengthen the synapse: %+v", edge)
	}

	r, err := router.New(graph, router.Config{FallbackExpertID: "GeneralCortex", TopK: 1})
	if err != nil {
		t.Fatal(err)
	}
	decision, err := r.Route("ThalamusRouter", "automotive.diagnostics")
	if err != nil {
		t.Fatal(err)
	}
	if decision.UsedFallback || len(decision.Candidates) != 1 || decision.Candidates[0].ExpertID != "DeviceCortex" {
		t.Fatalf("learned route was not selected: %+v", decision)
	}
}
