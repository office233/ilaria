package synthesis_test

import (
	"context"
	"errors"
	"math"
	"testing"

	"swyp-lang/internal/synthesis"
)

func TestRefinementUsesCounterexample(t *testing.T) {
	spec := synthesis.Spec{Examples: []synthesis.Example{{X: 0, Y: 0}, {X: 1, Y: 1}}}
	validation := []synthesis.Example{{X: 2, Y: 4}, {X: -3, Y: 9}, {X: 0.5, Y: 0.25}}
	r, err := synthesis.SynthesizeWithValidation(context.Background(), spec, validation)
	if err != nil {
		t.Fatal(err)
	}
	if r.Rounds < 2 || r.AddedExamples < 1 || r.VerifiedPoints != len(validation) {
		t.Fatalf("no refinement: %+v", r)
	}
	for _, e := range validation {
		if y := runSwypPredict(t, r.Source, e.X); y != e.Y {
			t.Fatalf("%g: %g != %g", e.X, y, e.Y)
		}
	}
	if len(spec.Examples) != 2 {
		t.Fatal("mutated caller specification")
	}
}

func TestRefinementTotalBudget(t *testing.T) {
	spec := synthesis.Spec{Examples: []synthesis.Example{{X: 0, Y: 0}, {X: 1, Y: 1}}, MaxCandidates: 2}
	r, err := synthesis.SynthesizeWithValidation(context.Background(), spec, []synthesis.Example{{X: 2, Y: 4}})
	if !errors.Is(err, synthesis.ErrExhausted) || r.Candidates != 2 || r.Source != "" {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestRefinementRestartsAfterObservationalClassesSplit(t *testing.T) {
	// x and 0 agree on the initial point. Keeping only old representatives
	// across rounds would lose the constant needed by the expanded example set.
	spec := synthesis.Spec{Examples: []synthesis.Example{{X: 0, Y: 0}}}
	r, err := synthesis.SynthesizeWithValidation(context.Background(), spec,
		[]synthesis.Example{{X: 1, Y: 0}, {X: 2, Y: 0}})
	if err != nil {
		t.Fatal(err)
	}
	if r.Rounds != 2 || r.Candidates != 4 || r.AddedExamples != 1 {
		t.Fatalf("%+v", r)
	}
	if y := runSwypPredict(t, r.Source, 2); y != 0 {
		t.Fatal(y)
	}
}

func TestRefinementInvalidAndCancelled(t *testing.T) {
	spec := synthesis.Spec{Examples: []synthesis.Example{{X: 0, Y: 0}}}
	for _, validation := range [][]synthesis.Example{{{X: 0, Y: 1}}, {{X: math.Inf(1), Y: 0}}} {
		_, err := synthesis.SynthesizeWithValidation(context.Background(), spec, validation)
		if !errors.Is(err, synthesis.ErrInvalidSpec) {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := synthesis.SynthesizeWithValidation(ctx, spec, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestContradictoryTrainingRejectedBeforeSearch(t *testing.T) {
	r, err := synthesis.Synthesize(context.Background(), synthesis.Spec{Examples: []synthesis.Example{{X: 1, Y: 2}, {X: 1, Y: 3}}})
	if !errors.Is(err, synthesis.ErrInvalidSpec) || r.Candidates != 0 {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestRefinementInputLimitAndZeroConsistency(t *testing.T) {
	training := []synthesis.Example{{X: 0, Y: 0}}
	validation := make([]synthesis.Example, 64)
	for i := range validation {
		validation[i] = synthesis.Example{X: float64(i + 1), Y: 0}
	}
	_, err := synthesis.SynthesizeWithValidation(context.Background(), synthesis.Spec{Examples: training}, validation)
	if !errors.Is(err, synthesis.ErrInvalidSpec) {
		t.Fatalf("expected combined-point bound, got %v", err)
	}
	_, err = synthesis.SynthesizeWithValidation(context.Background(), synthesis.Spec{Examples: training},
		[]synthesis.Example{{X: math.Copysign(0, -1), Y: 1}})
	if !errors.Is(err, synthesis.ErrInvalidSpec) {
		t.Fatalf("expected contradictory numeric-zero outputs, got %v", err)
	}
}
