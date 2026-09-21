package biomed

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
)

// KnowledgeGraph is Ilaria's persistent, evidence-carrying biomedical memory.
// It starts EMPTY and is populated only from source responses; every edge
// keeps the Evidence that justified it.
//
// Entity IDs are namespaced: "rxcui:328134", "chembl:CHEMBL203",
// "ensembl:ENSG00000146648", "mondo:MONDO_0005233", "variant:EGFR:T790M",
// "label:<set_id>".
type KnowledgeGraph struct {
	Entities map[string]Entity `json:"entities"`
	Edges    []Edge            `json:"edges"`
}

// Entity is a node.
type Entity struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"` // drug | target | disease | variant | label
}

// Edge is a directed, typed, evidenced relation.
type Edge struct {
	From     string     `json:"from"`
	To       string     `json:"to"`
	Relation string     `json:"relation"` // has_mechanism | targets | associated_with | candidate_for | interacts_with | mentioned_with | has_label
	Score    *float64   `json:"score,omitempty"`
	Evidence []Evidence `json:"evidence,omitempty"`
}

// NewKnowledgeGraph returns an empty graph.
func NewKnowledgeGraph() *KnowledgeGraph {
	return &KnowledgeGraph{Entities: map[string]Entity{}}
}

// AddEntity inserts or updates a node (a non-empty Name overwrites).
func (g *KnowledgeGraph) AddEntity(e Entity) {
	if e.ID == "" {
		return
	}
	if old, ok := g.Entities[e.ID]; ok && e.Name == "" {
		e.Name = old.Name
	}
	if old, ok := g.Entities[e.ID]; ok && e.Kind == "" {
		e.Kind = old.Kind
	}
	g.Entities[e.ID] = e
}

// AddEdge inserts an edge or merges its evidence into the existing edge with
// the same (From, To, Relation). Evidence is deduplicated by Source+ID.
func (g *KnowledgeGraph) AddEdge(e Edge) {
	if e.From == "" || e.To == "" {
		return
	}
	for i := range g.Edges {
		ex := &g.Edges[i]
		if ex.From != e.From || ex.To != e.To || ex.Relation != e.Relation {
			continue
		}
		if e.Score != nil {
			ex.Score = e.Score
		}
		for _, ev := range e.Evidence {
			if !hasEvidence(ex.Evidence, ev) {
				ex.Evidence = append(ex.Evidence, ev)
			}
		}
		return
	}
	// dedupe evidence inside the new edge as well
	var evs []Evidence
	for _, ev := range e.Evidence {
		if !hasEvidence(evs, ev) {
			evs = append(evs, ev)
		}
	}
	e.Evidence = evs
	g.Edges = append(g.Edges, e)
}

func hasEvidence(list []Evidence, ev Evidence) bool {
	for _, x := range list {
		if x.Source == ev.Source && x.ID == ev.ID {
			return true
		}
	}
	return false
}

// Neighbors returns the edges touching id in either direction, optionally
// filtered by relation ("" = any).
func (g *KnowledgeGraph) Neighbors(id, relation string) []Edge {
	var out []Edge
	for _, e := range g.Edges {
		if (e.From == id || e.To == id) && (relation == "" || e.Relation == relation) {
			out = append(out, e)
		}
	}
	return out
}

// Save writes the graph as JSON (atomic rename).
func (g *KnowledgeGraph) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	// deterministic output: sort edges for stable diffs
	edges := append([]Edge(nil), g.Edges...)
	sort.SliceStable(edges, func(i, j int) bool {
		if edges[i].From != edges[j].From {
			return edges[i].From < edges[j].From
		}
		if edges[i].Relation != edges[j].Relation {
			return edges[i].Relation < edges[j].Relation
		}
		return edges[i].To < edges[j].To
	})
	data, err := json.MarshalIndent(KnowledgeGraph{Entities: g.Entities, Edges: edges}, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// LoadKnowledgeGraph reads a graph; a missing file yields an empty graph.
func LoadKnowledgeGraph(path string) (*KnowledgeGraph, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return NewKnowledgeGraph(), nil
	}
	if err != nil {
		return nil, err
	}
	g := NewKnowledgeGraph()
	if err := json.Unmarshal(data, g); err != nil {
		return nil, err
	}
	if g.Entities == nil {
		g.Entities = map[string]Entity{}
	}
	return g, nil
}
