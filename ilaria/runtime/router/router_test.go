package router

import (
	"testing"

	"ilaria/generated/myriad"
	"ilaria/runtime/connectome"
	"ilaria/runtime/protocol"
)

func graph(t *testing.T) *connectome.Graph {
	t.Helper()
	g, err := connectome.New(connectome.Policy{
		TrustWeightPPM:          500_000,
		GainWeightPPM:           500_000,
		LatencyPenaltyWeightPPM: 100_000,
		ComputePenaltyWeightPPM: 100_000,
		LatencyBudgetMicros:     10_000,
		ComputeBudget:           10_000,
		MinObservations:         1,
	})
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func observe(t *testing.T, g *connectome.Graph, target string, gain uint64) {
	t.Helper()
	_, err := g.Observe(myriad.SynapseObservation{
		ProtocolVersion:     protocol.Version,
		SourceExpertID:      "ThalamusRouter",
		TargetExpertID:      target,
		DomainSignature:     "automotive.diagnostics",
		VerifiedSuccess:     true,
		VerifiedGainPPM:     gain,
		LatencyMicros:       100,
		ComputeCost:         100,
		TargetExpertVersion: "v1",
		VerifierEvidenceRef: "verify:fixture",
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestRouterFallsBackWithoutEvidence(t *testing.T) {
	r, err := New(graph(t), Config{FallbackExpertID: "GeneralCortex", TopK: 2})
	if err != nil {
		t.Fatal(err)
	}
	decision, err := r.Route("ThalamusRouter", "automotive.diagnostics")
	if err != nil {
		t.Fatal(err)
	}
	if !decision.UsedFallback || len(decision.Candidates) != 1 || decision.Candidates[0].ExpertID != "GeneralCortex" {
		t.Fatalf("unexpected fallback decision: %+v", decision)
	}
}

func TestRouterUsesLearnedTopK(t *testing.T) {
	g := graph(t)
	observe(t, g, "DeviceCortex", 900_000)
	observe(t, g, "ReasoningCortex", 600_000)
	observe(t, g, "GeneralCortex", 200_000)

	r, err := New(g, Config{FallbackExpertID: "GeneralCortex", TopK: 2})
	if err != nil {
		t.Fatal(err)
	}
	decision, err := r.Route("ThalamusRouter", "automotive.diagnostics")
	if err != nil {
		t.Fatal(err)
	}
	if decision.UsedFallback || len(decision.Candidates) != 2 {
		t.Fatalf("unexpected decision: %+v", decision)
	}
	if decision.Candidates[0].ExpertID != "DeviceCortex" || decision.Candidates[1].ExpertID != "ReasoningCortex" {
		t.Fatalf("unexpected top-k: %+v", decision.Candidates)
	}
}
