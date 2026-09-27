package swyplang

import (
	"encoding/json"
	"math"
	"testing"
)

func TestGraphDAGRoundTrip(t *testing.T) {
	p, err := Parse("graph.swyp", `fn predict(x:number)->number{return (x+1)*(x+1);}fn main(){print(predict(arg(0)));}`)
	if err != nil {
		t.Fatal(err)
	}
	g, err := p.ExpressionGraph("predict")
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Nodes) != 4 {
		t.Fatalf("expected shared subtree, got %d nodes", len(g.Nodes))
	}
	encoded, err := json.Marshal(g)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Graph
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	for i := -32; i <= 32; i++ {
		x := float64(i) / 4
		y, err := decoded.Evaluate(x, 4)
		if err != nil || y != (x+1)*(x+1) {
			t.Fatalf("%g: %g %v", x, y, err)
		}
	}
	if _, err := decoded.Evaluate(1, 3); err == nil {
		t.Fatal("ignored budget")
	}
	if _, err := decoded.Evaluate(math.MaxFloat64, 4); err == nil {
		t.Fatal("ignored overflow")
	}
}

func TestGraphRejectsInvalidShapesAndSideEffects(t *testing.T) {
	for _, g := range []Graph{
		{Version: 2, Nodes: []GraphNode{{Op: 0}}},
		{Version: 1, Nodes: []GraphNode{{Op: 7}}},
		{Version: 1, Nodes: []GraphNode{{Op: 2, Inputs: []int{0, 0}}}},
		{Version: 1, Nodes: []GraphNode{{Op: 1, Value: math.Inf(1)}}},
		{Version: 1, Nodes: []GraphNode{{Op: 0}}, Output: 1},
	} {
		if err := g.Validate(); err == nil {
			t.Fatalf("accepted %+v", g)
		}
	}
	for _, code := range []string{
		`fn predict(x:number)->number{return clock();}fn main(){}`,
		`fn predict(x:bool)->bool{return x;}fn main(){}`,
		`fn predict(x:number)->number{print(x);return x;}fn main(){}`,
	} {
		p, err := Parse("badgraph.swyp", code)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := p.ExpressionGraph("predict"); err == nil {
			t.Fatal("accepted unsupported graph")
		}
	}
}

func TestGraphSignedZeroEncoding(t *testing.T) {
	g := Graph{Version: 1, Nodes: []GraphNode{{Op: 1, Value: math.Copysign(0, -1)}}}
	data, err := json.Marshal(g)
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip Graph
	if err := json.Unmarshal(data, &roundTrip); err != nil {
		t.Fatal(err)
	}
	y, err := roundTrip.Evaluate(1, 1)
	if err != nil || !math.Signbit(y) {
		t.Fatalf("lost signed zero: %s", data)
	}
}
