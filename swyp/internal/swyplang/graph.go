package swyplang

import (
	"fmt"
	"math"
)

// Graph is a versioned, numerical operation DAG. Opcodes: 0=input, 1=constant,
// 2=add, 3=subtract, 4=multiply, 5=negate. It is not an embedding or a model.
type Graph struct {
	Version int         `json:"version"`
	Nodes   []GraphNode `json:"nodes"`
	Output  int         `json:"output"`
}
type GraphNode struct {
	Op     int     `json:"op"`
	Value  float64 `json:"value"`
	Inputs []int   `json:"inputs,omitempty"`
}

// ExpressionGraph exports a checked one-argument function consisting of a
// single pure arithmetic return. Only identical structural subtrees are shared;
// no reassociation or algebraic float64 rewrites are performed.
func (p *Program) ExpressionGraph(name string) (Graph, error) {
	g := Graph{Version: 1}
	checked, err := p.check()
	if err != nil {
		return g, err
	}
	f, ok := p.functions[name]
	if !ok || len(f.params) != 1 || len(f.body) != 1 || f.body[0].kind != "return" {
		return g, fmt.Errorf("graph requires a single-argument arithmetic return function")
	}
	sig := checked.signatures[name]
	if sig.params[0].root().mask != numType || sig.result.root().mask != numType {
		return g, fmt.Errorf("graph input and result must be numbers")
	}
	seen := map[string]int{}
	var emit func(*expr) (int, error)
	emit = func(e *expr) (int, error) {
		n := GraphNode{}
		switch e.kind {
		case "variable":
			if e.name != f.params[0] {
				return 0, fmt.Errorf("unsupported graph variable")
			}
		case "literal":
			value, ok := e.value.(float64)
			if !ok {
				return 0, fmt.Errorf("graph supports numbers only")
			}
			n.Op = 1
			n.Value = value
		case "unary", "binary":
			switch e.name {
			case "+":
				n.Op = 2
			case "-":
				n.Op = 3
				if e.kind == "unary" {
					n.Op = 5
				}
			case "*":
				n.Op = 4
			default:
				return 0, fmt.Errorf("unsupported graph operator %s", e.name)
			}
			for _, a := range e.args {
				id, err := emit(a)
				if err != nil {
					return 0, err
				}
				n.Inputs = append(n.Inputs, id)
			}
		default:
			return 0, fmt.Errorf("graph rejects calls and side effects")
		}
		key := fmt.Sprintf("%d:%x:%v", n.Op, math.Float64bits(n.Value), n.Inputs)
		if id, ok := seen[key]; ok {
			return id, nil
		}
		if len(g.Nodes) >= 64 {
			return 0, fmt.Errorf("graph exceeds 64 nodes")
		}
		id := len(g.Nodes)
		seen[key] = id
		g.Nodes = append(g.Nodes, n)
		return id, nil
	}
	id, err := emit(f.body[0].value)
	g.Output = id
	if err != nil {
		return Graph{}, err
	}
	if err := g.Validate(); err != nil {
		return Graph{}, err
	}
	return g, nil
}

func (g Graph) Validate() error {
	if g.Version != 1 || len(g.Nodes) < 1 || len(g.Nodes) > 64 || g.Output < 0 || g.Output >= len(g.Nodes) {
		return fmt.Errorf("invalid graph version, size or output")
	}
	for id, n := range g.Nodes {
		arity := 0
		switch n.Op {
		case 0, 1:
		case 2, 3, 4:
			arity = 2
		case 5:
			arity = 1
		default:
			return fmt.Errorf("unknown graph opcode %d", n.Op)
		}
		if len(n.Inputs) != arity || math.IsNaN(n.Value) || math.IsInf(n.Value, 0) {
			return fmt.Errorf("invalid graph node %d", id)
		}
		if n.Op != 1 && n.Value != 0 {
			return fmt.Errorf("unexpected value on graph node %d", id)
		}
		for _, input := range n.Inputs {
			if input < 0 || input >= id {
				return fmt.Errorf("graph node %d has cyclic or forward input", id)
			}
		}
	}
	return nil
}

// Evaluate consumes exactly one unit per node. The caller supplies the budget;
// graph accounting is distinct from the source interpreter's expression ticks.
func (g Graph) Evaluate(x float64, budget int) (float64, error) {
	if err := g.Validate(); err != nil {
		return 0, err
	}
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return 0, fmt.Errorf("non-finite graph input")
	}
	if budget < len(g.Nodes) {
		return 0, fmt.Errorf("graph node budget exceeded")
	}
	values := make([]float64, len(g.Nodes))
	for id, n := range g.Nodes {
		var v float64
		switch n.Op {
		case 0:
			v = x
		case 1:
			v = n.Value
		case 2:
			v = values[n.Inputs[0]] + values[n.Inputs[1]]
		case 3:
			v = values[n.Inputs[0]] - values[n.Inputs[1]]
		case 4:
			v = values[n.Inputs[0]] * values[n.Inputs[1]]
		case 5:
			v = -values[n.Inputs[0]]
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return 0, fmt.Errorf("non-finite graph result at node %d", id)
		}
		values[id] = v
	}
	return values[g.Output], nil
}
