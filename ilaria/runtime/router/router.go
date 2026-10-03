package router

import (
	"fmt"

	"ilaria/runtime/connectome"
	"ilaria/runtime/protocol"
)

type Config struct {
	FallbackExpertID string
	TopK             int
	MinScore         int64
}

func (c Config) Validate() error {
	if err := protocol.ValidateIdentifier("fallback_expert_id", c.FallbackExpertID); err != nil {
		return err
	}
	if c.TopK < 1 {
		return fmt.Errorf("router: top_k must be positive")
	}
	return nil
}

type Router struct {
	graph  *connectome.Graph
	config Config
}

func New(graph *connectome.Graph, config Config) (*Router, error) {
	if graph == nil {
		return nil, fmt.Errorf("router: nil connectome")
	}
	if err := config.Validate(); err != nil {
		return nil, err
	}
	return &Router{graph: graph, config: config}, nil
}

type Candidate struct {
	ExpertID string
	Score    int64
}

type Decision struct {
	Domain       string
	Candidates   []Candidate
	UsedFallback bool
}

func (r *Router) Route(sourceExpertID, domainSignature string) (Decision, error) {
	ranked, err := r.graph.Rank(sourceExpertID, domainSignature, r.config.TopK)
	if err != nil {
		return Decision{}, err
	}
	decision := Decision{Domain: domainSignature}
	for _, edge := range ranked {
		if edge.Score < r.config.MinScore {
			continue
		}
		decision.Candidates = append(decision.Candidates, Candidate{
			ExpertID: edge.Edge.TargetExpertID,
			Score:    edge.Score,
		})
	}
	if len(decision.Candidates) == 0 {
		decision.Candidates = []Candidate{{ExpertID: r.config.FallbackExpertID}}
		decision.UsedFallback = true
	}
	return decision, nil
}
