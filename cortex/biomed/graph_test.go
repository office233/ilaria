package biomed

import (
	"path/filepath"
	"testing"
	"time"
)

func TestKnowledgeGraph_DuplicateEdgeMergesEvidence(t *testing.T) {
	g := NewKnowledgeGraph()
	g.AddEntity(Entity{ID: "rxcui:328134", Name: "gefitinib", Kind: "drug"})
	g.AddEntity(Entity{ID: "chembl:CHEMBL203", Name: "EGFR", Kind: "target"})
	e1 := Evidence{Source: "chembl", ID: "mec_id:244", URL: "u1", Retrieved: time.Now()}
	e2 := Evidence{Source: "openfda", ID: "set", URL: "u2", Retrieved: time.Now()}
	g.AddEdge(Edge{From: "rxcui:328134", To: "chembl:CHEMBL203", Relation: "targets", Evidence: []Evidence{e1}})
	g.AddEdge(Edge{From: "rxcui:328134", To: "chembl:CHEMBL203", Relation: "targets", Evidence: []Evidence{e2}})
	g.AddEdge(Edge{From: "rxcui:328134", To: "chembl:CHEMBL203", Relation: "targets", Evidence: []Evidence{e1}}) // exact duplicate
	if len(g.Edges) != 1 {
		t.Fatalf("edges = %d, want 1 (merged)", len(g.Edges))
	}
	if len(g.Edges[0].Evidence) != 2 {
		t.Fatalf("evidence = %d, want 2 (deduped by source+id)", len(g.Edges[0].Evidence))
	}
	if len(g.Entities) != 2 {
		t.Fatalf("entities = %d", len(g.Entities))
	}
}

func TestKnowledgeGraph_NeighborsFilterByRelation(t *testing.T) {
	g := NewKnowledgeGraph()
	g.AddEdge(Edge{From: "a", To: "b", Relation: "targets"})
	g.AddEdge(Edge{From: "a", To: "c", Relation: "interacts_with"})
	g.AddEdge(Edge{From: "d", To: "a", Relation: "targets"})
	if n := g.Neighbors("a", "targets"); len(n) != 2 { // both directions
		t.Fatalf("neighbors(a,targets) = %+v", n)
	}
	if n := g.Neighbors("a", ""); len(n) != 3 {
		t.Fatalf("neighbors(a,any) = %+v", n)
	}
	if n := g.Neighbors("zzz", ""); len(n) != 0 {
		t.Fatalf("neighbors(unknown) = %+v", n)
	}
}

func TestKnowledgeGraph_SaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.json")
	g := NewKnowledgeGraph()
	g.AddEntity(Entity{ID: "rxcui:1", Name: "x", Kind: "drug"})
	score := 0.85
	g.AddEdge(Edge{From: "rxcui:1", To: "mondo:M", Relation: "associated_with", Score: &score,
		Evidence: []Evidence{{Source: "opentargets", ID: "M", URL: "u", Retrieved: time.Unix(0, 0).UTC()}}})
	if err := g.Save(path); err != nil {
		t.Fatal(err)
	}
	g2, err := LoadKnowledgeGraph(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(g2.Entities) != 1 || len(g2.Edges) != 1 || g2.Edges[0].Score == nil || *g2.Edges[0].Score != 0.85 || g2.Edges[0].Evidence[0].Source != "opentargets" {
		t.Fatalf("round-trip mismatch: %+v", g2)
	}
}

func TestLoadKnowledgeGraph_MissingFileIsEmptyGraph(t *testing.T) {
	g, err := LoadKnowledgeGraph(filepath.Join(t.TempDir(), "nope.json"))
	if err != nil {
		t.Fatal(err)
	}
	if g == nil || len(g.Entities) != 0 || len(g.Edges) != 0 {
		t.Fatalf("expected empty graph, got %+v", g)
	}
}
