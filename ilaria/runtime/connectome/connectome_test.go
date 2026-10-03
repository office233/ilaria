package connectome

import (
	"testing"

	"ilaria/generated/myriad"
	"ilaria/runtime/protocol"
)

func policy() Policy {
	return Policy{
		TrustWeightPPM:          500_000,
		GainWeightPPM:           500_000,
		LatencyPenaltyWeightPPM: 100_000,
		ComputePenaltyWeightPPM: 100_000,
		LatencyBudgetMicros:     1_000,
		ComputeBudget:           1_000,
		MinObservations:         1,
	}
}

func observation(target string, success bool, gain, latency, cost uint64) myriad.SynapseObservation {
	return myriad.SynapseObservation{
		ProtocolVersion:     protocol.Version,
		SourceExpertID:      "ThalamusRouter",
		TargetExpertID:      target,
		DomainSignature:     "code.go",
		VerifiedSuccess:     success,
		VerifiedGainPPM:     gain,
		LatencyMicros:       latency,
		ComputeCost:         cost,
		TargetExpertVersion: "v1",
		VerifierEvidenceRef: "verify:test-suite-1",
	}
}

func TestConnectomeRequiresVerifierEvidence(t *testing.T) {
	g, err := New(policy())
	if err != nil {
		t.Fatal(err)
	}
	obs := observation("CodeCortex", true, 800_000, 100, 100)
	obs.VerifierEvidenceRef = ""
	if _, err := g.Observe(obs); err == nil {
		t.Fatal("unverified edge update must be rejected")
	}
	if len(g.Snapshot()) != 0 {
		t.Fatal("rejected observation mutated the graph")
	}
}

func TestConnectomeStrengthensOnlyVerifiedSuccess(t *testing.T) {
	g, err := New(policy())
	if err != nil {
		t.Fatal(err)
	}
	edge, err := g.Observe(observation("CodeCortex", true, 800_000, 100, 100))
	if err != nil {
		t.Fatal(err)
	}
	if edge.TrustPPM != protocol.MaxPPM || edge.SuccessfulHandoffs != 1 {
		t.Fatalf("unexpected first edge: %+v", edge)
	}
	edge, err = g.Observe(observation("CodeCortex", false, 0, 100, 100))
	if err != nil {
		t.Fatal(err)
	}
	if edge.TrustPPM != 500_000 || edge.FailedHandoffs != 1 {
		t.Fatalf("failure did not reduce trust: %+v", edge)
	}
}

func TestConnectomeRankUsesConfiguredQualityAndCost(t *testing.T) {
	g, err := New(policy())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Observe(observation("CodeCortex", true, 900_000, 100, 100)); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Observe(observation("GeneralCortex", true, 400_000, 900, 900)); err != nil {
		t.Fatal(err)
	}
	ranked, err := g.Rank("ThalamusRouter", "code.go", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(ranked) != 2 {
		t.Fatalf("got %d edges, want 2", len(ranked))
	}
	if ranked[0].Edge.TargetExpertID != "CodeCortex" {
		t.Fatalf("ranked %s first, want CodeCortex: %+v", ranked[0].Edge.TargetExpertID, ranked)
	}
}
