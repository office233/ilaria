package synthesis

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"strconv"

	"swyp-lang/internal/coreir"
)

type contractPoint struct {
	input    coreir.Value
	expected *coreir.Value // nil for counterexample-derived relational constraints.
}
type contractCandidate struct {
	text    string
	outputs []coreir.Value
}
type contractSearch struct {
	ctx         context.Context
	spec        ContractSpec
	points      []contractPoint
	constants   []coreir.Value
	constraints *coreir.Constraints
	report      *ContractResult
	variable    string
}

func (s *contractSearch) beginCandidate() error {
	if err := s.ctx.Err(); err != nil {
		return err
	}
	if s.report.Candidates >= s.spec.MaxCandidates {
		return fmt.Errorf("%w: shared candidate budget", ErrExhausted)
	}
	s.report.Candidates++
	return nil
}

// One evaluation unit is a candidate value at one input or one full point
// constraint check. Contract predicate size is independently bounded to 256
// nodes. These units are NOT Core IR instructions or benchmark timings.
func (s *contractSearch) evaluation() error {
	if err := s.ctx.Err(); err != nil {
		return err
	}
	if s.report.Evaluations >= s.spec.MaxEvaluations {
		return fmt.Errorf("%w: shared evaluation budget", ErrExhausted)
	}
	s.report.Evaluations++
	return nil
}
func (s *contractSearch) matches(outputs []coreir.Value) (bool, error) {
	for i, p := range s.points {
		if err := s.evaluation(); err != nil {
			return false, err
		}
		if p.expected != nil && !contractEqual(outputs[i], *p.expected) {
			return false, nil
		}
		ok, err := s.constraints.Check([]coreir.Value{p.input}, outputs[i])
		if err != nil {
			return false, fmt.Errorf("%w: %v", ErrContractIncomplete, err)
		}
		if !ok {
			return false, nil
		}
	}
	return true, nil
}
func contractVectorKey(values []coreir.Value) string {
	key := make([]byte, len(values)*8)
	for i, v := range values {
		var bits uint64
		if n, ok := v.Int64(); ok {
			bits = uint64(n)
		} else {
			n, _ := v.Float64()
			bits = math.Float64bits(n)
		}
		binary.LittleEndian.PutUint64(key[8*i:], bits)
	}
	return string(key)
}
func contractConstant(v coreir.Value) string {
	text := v.Literal().Value
	if n, ok := v.Float64(); ok {
		text = strconv.FormatFloat(n, 'f', -1, 64)
	}
	// Source parsing does not rely on exponent syntax or implicit float conversion.
	if len(text) > 0 && text[0] == '-' {
		return "(" + text + ")"
	}
	return text
}

func (s *contractSearch) run() (contractCandidate, error) {
	pool := map[int][]contractCandidate{}
	seen := map[string]bool{}
	offer := func(nodes int, c contractCandidate) (bool, error) {
		match, err := s.matches(c.outputs)
		if err != nil || match {
			return match, err
		}
		key := contractVectorKey(c.outputs)
		if !seen[key] {
			if len(seen) >= MaxContractPool {
				return false, fmt.Errorf("%w: retained candidate pool limit %d", ErrExhausted, MaxContractPool)
			}
			seen[key] = true
			pool[nodes] = append(pool[nodes], c)
		}
		return false, nil
	}
	for terminal := -1; terminal < len(s.constants); terminal++ {
		if err := s.beginCandidate(); err != nil {
			return contractCandidate{}, err
		}
		c := contractCandidate{text: s.variable, outputs: make([]coreir.Value, len(s.points))}
		if terminal >= 0 {
			c.text = contractConstant(s.constants[terminal])
		}
		for i, p := range s.points {
			if err := s.evaluation(); err != nil {
				return contractCandidate{}, err
			}
			c.outputs[i] = p.input
			if terminal >= 0 {
				c.outputs[i] = s.constants[terminal]
			}
		}
		match, err := offer(1, c)
		if err != nil {
			return contractCandidate{}, err
		}
		if match {
			return c, nil
		}
	}
	ops := []struct{ code, source string }{{"add", "+"}, {"sub", "-"}, {"mul", "*"}}
	for nodes := 3; nodes <= s.spec.MaxNodes; nodes += 2 {
		for leftNodes := 1; leftNodes < nodes; leftNodes += 2 {
			rightNodes := nodes - 1 - leftNodes
			for _, op := range ops {
				for _, left := range pool[leftNodes] {
					for _, right := range pool[rightNodes] {
						if err := s.beginCandidate(); err != nil {
							return contractCandidate{}, err
						}
						outputs := make([]coreir.Value, len(s.points))
						valid := true
						for i := range outputs {
							if err := s.evaluation(); err != nil {
								return contractCandidate{}, err
							}
							var err error
							outputs[i], err = coreir.Apply(op.code, left.outputs[i], right.outputs[i])
							if err != nil {
								valid = false
								break
							}
						}
						// A trapped intermediate cannot be hidden by a later operation.
						if !valid {
							continue
						}
						c := contractCandidate{text: "(" + left.text + " " + op.source + " " + right.text + ")", outputs: outputs}
						match, err := offer(nodes, c)
						if err != nil {
							return contractCandidate{}, err
						}
						if match {
							return c, nil
						}
					}
				}
			}
		}
	}
	return contractCandidate{}, fmt.Errorf("%w: grammar up to %d nodes exhausted; not an impossibility proof", ErrExhausted, s.spec.MaxNodes)
}
