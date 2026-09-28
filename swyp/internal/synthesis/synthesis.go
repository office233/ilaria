package synthesis

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"strconv"
)

var (
	// ErrInvalidSpec indicates that the synthesis spec violates validation constraints.
	ErrInvalidSpec = errors.New("invalid synthesis spec")
	// ErrExhausted indicates that the synthesis search space or candidate budget was exhausted without finding a matching expression.
	ErrExhausted = errors.New("synthesis exhausted without finding matching expression")
)

// Example represents an input-output pair for synthesis.
type Example struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// Spec defines constraints and parameters for program synthesis.
type Spec struct {
	Examples      []Example `json:"examples"`
	Constants     []float64 `json:"constants"`
	MaxNodes      int       `json:"max_nodes"`
	MaxCandidates int       `json:"max_candidates"`
}

// Result contains the synthesized expression, executable source code, and candidates evaluated.
type Result struct {
	Expression string `json:"expression"`
	Source     string `json:"source"`
	Candidates int    `json:"candidates"`
}

type candidate struct {
	text    string
	outputs []float64
}

type synthesizer struct {
	ctx           context.Context
	spec          Spec
	constants     []float64
	candidates    int
	seenVectors   map[string]bool
	keyBuf        []byte
	scratchOutput []float64
}

// Synthesize searches for an arithmetic expression over x and constants matching the provided examples.
func Synthesize(ctx context.Context, spec Spec) (Result, error) {
	// Validate and apply defaults
	maxNodes := spec.MaxNodes
	if maxNodes == 0 {
		maxNodes = 7
	}
	if maxNodes < 1 || maxNodes > 9 {
		return Result{}, fmt.Errorf("%w: max_nodes must be between 1 and 9, got %d", ErrInvalidSpec, maxNodes)
	}

	maxCandidates := spec.MaxCandidates
	if maxCandidates == 0 {
		maxCandidates = 20000
	}
	if maxCandidates < 1 || maxCandidates > 100000 {
		return Result{}, fmt.Errorf("%w: max_candidates must be between 1 and 100000, got %d", ErrInvalidSpec, maxCandidates)
	}

	if len(spec.Examples) < 1 || len(spec.Examples) > 64 {
		return Result{}, fmt.Errorf("%w: examples count must be between 1 and 64, got %d", ErrInvalidSpec, len(spec.Examples))
	}

	for i, ex := range spec.Examples {
		if math.IsNaN(ex.X) || math.IsInf(ex.X, 0) || math.IsNaN(ex.Y) || math.IsInf(ex.Y, 0) {
			return Result{}, fmt.Errorf("%w: example at index %d has non-finite values (x=%v, y=%v)", ErrInvalidSpec, i, ex.X, ex.Y)
		}
	}
	if err := validatePairs(spec.Examples); err != nil {
		return Result{}, err
	}

	constants := spec.Constants
	if len(constants) == 0 {
		constants = []float64{-1, 0, 1, 2}
	} else {
		if len(constants) > 16 {
			return Result{}, fmt.Errorf("%w: constants count must be at most 16, got %d", ErrInvalidSpec, len(constants))
		}
		for i, c := range constants {
			if math.IsNaN(c) || math.IsInf(c, 0) {
				return Result{}, fmt.Errorf("%w: constant at index %d is non-finite: %v", ErrInvalidSpec, i, c)
			}
		}
	}

	// Normalized constants copy (canonical zero representation)
	normConstants := make([]float64, len(constants))
	for i, c := range constants {
		if c == 0 {
			normConstants[i] = 0
		} else {
			normConstants[i] = c
		}
	}

	normSpec := Spec{
		Examples:      spec.Examples,
		Constants:     normConstants,
		MaxNodes:      maxNodes,
		MaxCandidates: maxCandidates,
	}

	s := &synthesizer{
		ctx:           ctx,
		spec:          normSpec,
		constants:     normConstants,
		seenVectors:   make(map[string]bool),
		keyBuf:        make([]byte, len(normSpec.Examples)*8),
		scratchOutput: make([]float64, len(normSpec.Examples)),
	}

	return s.run()
}

func (s *synthesizer) run() (Result, error) {
	if err := s.ctx.Err(); err != nil {
		return Result{Candidates: s.candidates}, err
	}

	numExamples := len(s.spec.Examples)
	pool := make(map[int][]candidate)

	// Level 1: Terminals
	// 1. Terminal variable 'x'
	if err := s.ctx.Err(); err != nil {
		return Result{Candidates: s.candidates}, err
	}
	if s.candidates >= s.spec.MaxCandidates {
		return Result{Candidates: s.candidates}, fmt.Errorf("%w: candidate budget of %d reached", ErrExhausted, s.spec.MaxCandidates)
	}
	s.candidates++

	xOutputs := make([]float64, numExamples)
	for i, ex := range s.spec.Examples {
		if ex.X == 0 {
			xOutputs[i] = 0
		} else {
			xOutputs[i] = ex.X
		}
	}

	if s.matches(xOutputs) {
		return s.makeResult("x"), nil
	}
	xKey := s.vectorKey(xOutputs)
	s.seenVectors[xKey] = true
	pool[1] = append(pool[1], candidate{text: "x", outputs: xOutputs})

	// 2. Terminal constants
	for _, c := range s.constants {
		if err := s.ctx.Err(); err != nil {
			return Result{Candidates: s.candidates}, err
		}
		if s.candidates >= s.spec.MaxCandidates {
			return Result{Candidates: s.candidates}, fmt.Errorf("%w: candidate budget of %d reached", ErrExhausted, s.spec.MaxCandidates)
		}
		s.candidates++

		cOutputs := make([]float64, numExamples)
		for i := range cOutputs {
			cOutputs[i] = c
		}

		cText := formatConstant(c)
		if s.matches(cOutputs) {
			return s.makeResult(cText), nil
		}

		cKey := s.vectorKey(cOutputs)
		if !s.seenVectors[cKey] {
			s.seenVectors[cKey] = true
			pool[1] = append(pool[1], candidate{text: cText, outputs: cOutputs})
		}
	}

	// Binary Operators: +, -, *
	ops := []string{"+", "-", "*"}

	// Enumerate by expression node count: odd numbers 3, 5, 7, 9 <= MaxNodes
	for nodeCount := 3; nodeCount <= s.spec.MaxNodes; nodeCount += 2 {
		if err := s.ctx.Err(); err != nil {
			return Result{Candidates: s.candidates}, err
		}

		for leftNodes := 1; leftNodes < nodeCount; leftNodes += 2 {
			rightNodes := nodeCount - 1 - leftNodes
			if rightNodes < 1 {
				continue
			}

			leftPool := pool[leftNodes]
			rightPool := pool[rightNodes]
			if len(leftPool) == 0 || len(rightPool) == 0 {
				continue
			}

			for _, op := range ops {
				for _, left := range leftPool {
					for _, right := range rightPool {
						if err := s.ctx.Err(); err != nil {
							return Result{Candidates: s.candidates}, err
						}
						if s.candidates >= s.spec.MaxCandidates {
							return Result{Candidates: s.candidates}, fmt.Errorf("%w: candidate budget of %d reached", ErrExhausted, s.spec.MaxCandidates)
						}
						s.candidates++

						// Finite-result evaluation
						valid := true
						for i := 0; i < numExamples; i++ {
							lv := left.outputs[i]
							rv := right.outputs[i]
							var ov float64
							switch op {
							case "+":
								ov = lv + rv
							case "-":
								ov = lv - rv
							case "*":
								ov = lv * rv
							}
							if math.IsNaN(ov) || math.IsInf(ov, 0) {
								valid = false
								break
							}
							if ov == 0 {
								ov = 0
							}
							s.scratchOutput[i] = ov
						}

						if !valid {
							// Invalid result: counted in candidate budget, discarded from pool
							continue
						}

						// Check exact match on all examples
						if s.matches(s.scratchOutput) {
							exprText := fmt.Sprintf("(%s %s %s)", left.text, op, right.text)
							return s.makeResult(exprText), nil
						}

						// Semantic deduplication keyed by output vector
						vKey := s.vectorKey(s.scratchOutput)
						if s.seenVectors[vKey] {
							// Semantic duplicate: counted in candidate budget, discarded from pool
							continue
						}
						s.seenVectors[vKey] = true

						exprText := fmt.Sprintf("(%s %s %s)", left.text, op, right.text)
						savedOutputs := make([]float64, numExamples)
						copy(savedOutputs, s.scratchOutput)

						pool[nodeCount] = append(pool[nodeCount], candidate{
							text:    exprText,
							outputs: savedOutputs,
						})
					}
				}
			}
		}
	}

	return Result{Candidates: s.candidates}, fmt.Errorf("%w: search space up to max_nodes %d exhausted", ErrExhausted, s.spec.MaxNodes)
}

func (s *synthesizer) matches(outputs []float64) bool {
	for i, ex := range s.spec.Examples {
		if outputs[i] != ex.Y {
			return false
		}
	}
	return true
}

func (s *synthesizer) makeResult(expr string) Result {
	source := fmt.Sprintf("fn predict(x: number) -> number { return %s; } fn main(){print(predict(arg(0)));}", expr)
	return Result{
		Expression: expr,
		Source:     source,
		Candidates: s.candidates,
	}
}

func (s *synthesizer) vectorKey(vals []float64) string {
	b := s.keyBuf
	for i, v := range vals {
		if v == 0 {
			v = 0
		}
		binary.LittleEndian.PutUint64(b[i*8:(i+1)*8], math.Float64bits(v))
	}
	return string(b)
}

func formatConstant(c float64) string {
	if c == 0 {
		return "0"
	}
	return strconv.FormatFloat(c, 'f', -1, 64)
}
