package synthesis

import (
	"bytes"
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"

	"swyp-lang/internal/swyplang"
)

// RefinementResult records testing on an explicitly supplied finite set. It is
// not a proof for inputs outside that set. Candidates is a total across rounds.
type RefinementResult struct {
	Result
	Rounds         int `json:"rounds"`
	AddedExamples  int `json:"added_examples"`
	VerifiedPoints int `json:"verified_points"`
}

func validatePairs(examples []Example) error {
	seen := make(map[float64]float64)
	for i, e := range examples {
		if math.IsNaN(e.X) || math.IsInf(e.X, 0) || math.IsNaN(e.Y) || math.IsInf(e.Y, 0) {
			return fmt.Errorf("%w: non-finite example %d", ErrInvalidSpec, i)
		}
		if y, ok := seen[e.X]; ok && y != e.Y {
			return fmt.Errorf("%w: contradictory outputs for x=%g", ErrInvalidSpec, e.X)
		}
		seen[e.X] = e.Y
	}
	return nil
}

// SynthesizeWithValidation starts with Spec.Examples and adds the first failing
// validation point after each search. Every restart uses the remaining budget,
// never a fresh budget. Exhaustion is not an impossibility proof. No shell or
// model is used: generated arithmetic is checked by the bounded Swyp interpreter.
func SynthesizeWithValidation(ctx context.Context, spec Spec, validation []Example) (RefinementResult, error) {
	var result RefinementResult
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if len(spec.Examples) < 1 || len(spec.Examples) > 64 || len(validation) > 64 {
		return result, fmt.Errorf("%w: require 1..64 examples and at most 64 validation points", ErrInvalidSpec)
	}
	all := append(append([]Example(nil), spec.Examples...), validation...)
	if err := validatePairs(all); err != nil {
		return result, err
	}
	unique := map[float64]bool{}
	for _, e := range all {
		unique[e.X] = true
	}
	if len(unique) > 64 {
		return result, fmt.Errorf("%w: combined set exceeds 64 distinct inputs", ErrInvalidSpec)
	}
	// Deduplicate training inputs so refinement can use the full distinct-point cap.
	training := make([]Example, 0, len(unique))
	seen := map[float64]bool{}
	for _, e := range spec.Examples {
		if !seen[e.X] {
			training = append(training, e)
			seen[e.X] = true
		}
	}
	budget := spec.MaxCandidates
	if budget == 0 {
		budget = 20000
	}
	if budget < 1 || budget > 100000 {
		return result, fmt.Errorf("%w: max_candidates must be between 1 and 100000", ErrInvalidSpec)
	}
	for result.Candidates < budget {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		spec.Examples = training
		spec.MaxCandidates = budget - result.Candidates
		candidate, err := Synthesize(ctx, spec)
		result.Rounds++
		result.Candidates += candidate.Candidates
		if err != nil {
			return result, err
		}
		program, err := swyplang.Parse("synthesized.swyp", candidate.Source)
		if err != nil {
			return result, fmt.Errorf("generated source: %w", err)
		}
		if err := program.Check(); err != nil {
			return result, err
		}
		failure := -1
		for i, e := range validation {
			if err := ctx.Err(); err != nil {
				return result, err
			}
			var out bytes.Buffer
			runErr := program.RunArgs(&out, 10000, []float64{e.X})
			y, parseErr := strconv.ParseFloat(strings.TrimSpace(out.String()), 64)
			if runErr != nil || parseErr != nil || y != e.Y {
				failure = i
				break
			}
		}
		if failure < 0 {
			result.Expression = candidate.Expression
			result.Source = candidate.Source
			result.VerifiedPoints = len(validation)
			return result, nil
		}
		e := validation[failure]
		if seen[e.X] {
			return result, fmt.Errorf("internal synthesis/interpreter mismatch at x=%g", e.X)
		}
		training = append(training, e)
		seen[e.X] = true
		result.AddedExamples++
	}
	return result, fmt.Errorf("%w: total refinement budget of %d reached", ErrExhausted, budget)
}
