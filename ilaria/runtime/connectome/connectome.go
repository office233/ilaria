package connectome

import (
	"fmt"
	"math/bits"
	"sort"
	"sync"

	"ilaria/generated/myriad"
	"ilaria/runtime/protocol"
)

type Policy struct {
	TrustWeightPPM          uint64
	GainWeightPPM           uint64
	LatencyPenaltyWeightPPM uint64
	ComputePenaltyWeightPPM uint64
	LatencyBudgetMicros     uint64
	ComputeBudget           uint64
	MinObservations         uint64
}

func (p Policy) Validate() error {
	for field, value := range map[string]uint64{
		"trust_weight_ppm":           p.TrustWeightPPM,
		"gain_weight_ppm":            p.GainWeightPPM,
		"latency_penalty_weight_ppm": p.LatencyPenaltyWeightPPM,
		"compute_penalty_weight_ppm": p.ComputePenaltyWeightPPM,
	} {
		if err := protocol.ValidatePPM(field, value); err != nil {
			return err
		}
	}
	if p.TrustWeightPPM == 0 && p.GainWeightPPM == 0 {
		return fmt.Errorf("connectome: at least one positive quality weight is required")
	}
	if p.LatencyPenaltyWeightPPM > 0 && p.LatencyBudgetMicros == 0 {
		return fmt.Errorf("connectome: latency budget is required when latency penalty is enabled")
	}
	if p.ComputePenaltyWeightPPM > 0 && p.ComputeBudget == 0 {
		return fmt.Errorf("connectome: compute budget is required when compute penalty is enabled")
	}
	if p.MinObservations == 0 {
		return fmt.Errorf("connectome: min observations must be positive")
	}
	return nil
}

type edgeKey struct {
	source string
	target string
	domain string
}

type Graph struct {
	mu     sync.RWMutex
	policy Policy
	edges  map[edgeKey]myriad.ConnectomeEdge
}

func New(policy Policy) (*Graph, error) {
	if err := policy.Validate(); err != nil {
		return nil, err
	}
	return &Graph{policy: policy, edges: make(map[edgeKey]myriad.ConnectomeEdge)}, nil
}

func ValidateObservation(obs myriad.SynapseObservation) error {
	if err := protocol.ValidateVersion(obs.ProtocolVersion); err != nil {
		return err
	}
	if err := protocol.ValidateIdentifier("source_expert_id", obs.SourceExpertID); err != nil {
		return err
	}
	if err := protocol.ValidateIdentifier("target_expert_id", obs.TargetExpertID); err != nil {
		return err
	}
	if obs.SourceExpertID == obs.TargetExpertID {
		return fmt.Errorf("connectome: self edge is not allowed")
	}
	if err := protocol.ValidateIdentifier("domain_signature", obs.DomainSignature); err != nil {
		return err
	}
	if err := protocol.ValidateIdentifier("target_expert_version", obs.TargetExpertVersion); err != nil {
		return err
	}
	if err := protocol.ValidateIdentifier("verifier_evidence_ref", obs.VerifierEvidenceRef); err != nil {
		return err
	}
	if err := protocol.ValidatePPM("verified_gain_ppm", obs.VerifiedGainPPM); err != nil {
		return err
	}
	if !obs.VerifiedSuccess && obs.VerifiedGainPPM != 0 {
		return fmt.Errorf("connectome: failed handoff cannot report positive verified gain")
	}
	return nil
}

func (g *Graph) Observe(obs myriad.SynapseObservation) (myriad.ConnectomeEdge, error) {
	if err := ValidateObservation(obs); err != nil {
		return myriad.ConnectomeEdge{}, err
	}
	key := edgeKey{source: obs.SourceExpertID, target: obs.TargetExpertID, domain: obs.DomainSignature}

	g.mu.Lock()
	defer g.mu.Unlock()

	edge := g.edges[key]
	previousTotal := edge.SuccessfulHandoffs + edge.FailedHandoffs
	if edge.ProtocolVersion == 0 {
		edge.ProtocolVersion = protocol.Version
		edge.SourceExpertID = obs.SourceExpertID
		edge.TargetExpertID = obs.TargetExpertID
		edge.DomainSignature = obs.DomainSignature
	}
	if obs.VerifiedSuccess {
		edge.SuccessfulHandoffs++
	} else {
		edge.FailedHandoffs++
	}
	edge.VerifiedGainPPM = runningMean(edge.VerifiedGainPPM, obs.VerifiedGainPPM, previousTotal)
	edge.LatencyMicros = runningMean(edge.LatencyMicros, obs.LatencyMicros, previousTotal)
	edge.ComputeCost = runningMean(edge.ComputeCost, obs.ComputeCost, previousTotal)
	edge.LastExpertVersion = obs.TargetExpertVersion
	total := edge.SuccessfulHandoffs + edge.FailedHandoffs
	edge.TrustPPM = ratioPPM(edge.SuccessfulHandoffs, total)
	g.edges[key] = edge
	return edge, nil
}

func runningMean(previous, sample, previousCount uint64) uint64 {
	denom := previousCount + 1
	if sample >= previous {
		return previous + (sample-previous)/denom
	}
	return previous - (previous-sample)/denom
}

func ratioPPM(part, total uint64) uint64 {
	return scaledRatio(part, total, protocol.MaxPPM)
}

type RankedEdge struct {
	Edge  myriad.ConnectomeEdge
	Score int64
}

func (g *Graph) Rank(sourceExpertID, domainSignature string, limit int) ([]RankedEdge, error) {
	if err := protocol.ValidateIdentifier("source_expert_id", sourceExpertID); err != nil {
		return nil, err
	}
	if err := protocol.ValidateIdentifier("domain_signature", domainSignature); err != nil {
		return nil, err
	}
	if limit < 1 {
		return nil, fmt.Errorf("connectome: rank limit must be positive")
	}

	g.mu.RLock()
	defer g.mu.RUnlock()

	out := make([]RankedEdge, 0)
	for _, edge := range g.edges {
		if edge.SourceExpertID != sourceExpertID || edge.DomainSignature != domainSignature {
			continue
		}
		if edge.SuccessfulHandoffs+edge.FailedHandoffs < g.policy.MinObservations {
			continue
		}
		out = append(out, RankedEdge{Edge: edge, Score: g.score(edge)})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].Edge.TargetExpertID < out[j].Edge.TargetExpertID
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (g *Graph) score(edge myriad.ConnectomeEdge) int64 {
	positive := weighted(edge.TrustPPM, g.policy.TrustWeightPPM) +
		weighted(edge.VerifiedGainPPM, g.policy.GainWeightPPM)
	latencyPenalty := weighted(normalizedPenalty(edge.LatencyMicros, g.policy.LatencyBudgetMicros), g.policy.LatencyPenaltyWeightPPM)
	computePenalty := weighted(normalizedPenalty(edge.ComputeCost, g.policy.ComputeBudget), g.policy.ComputePenaltyWeightPPM)
	return int64(positive) - int64(latencyPenalty) - int64(computePenalty)
}

func weighted(valuePPM, weightPPM uint64) uint64 {
	return (valuePPM * weightPPM) / protocol.MaxPPM
}

func normalizedPenalty(value, budget uint64) uint64 {
	if value == 0 || budget == 0 {
		return 0
	}
	if value >= budget {
		return protocol.MaxPPM
	}
	return scaledRatio(value, budget, protocol.MaxPPM)
}

func scaledRatio(part, total, scale uint64) uint64 {
	if total == 0 || part == 0 {
		return 0
	}
	if part >= total {
		return scale
	}
	hi, lo := bits.Mul64(part, scale)
	quotient, _ := bits.Div64(hi, lo, total)
	return quotient
}

func (g *Graph) Snapshot() []myriad.ConnectomeEdge {
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make([]myriad.ConnectomeEdge, 0, len(g.edges))
	for _, edge := range g.edges {
		out = append(out, edge)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].SourceExpertID != out[j].SourceExpertID {
			return out[i].SourceExpertID < out[j].SourceExpertID
		}
		if out[i].DomainSignature != out[j].DomainSignature {
			return out[i].DomainSignature < out[j].DomainSignature
		}
		return out[i].TargetExpertID < out[j].TargetExpertID
	})
	return out
}
