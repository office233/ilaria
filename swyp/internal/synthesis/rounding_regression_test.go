package synthesis_test

import (
	"context"
	"errors"
	"testing"

	"swyp-lang/internal/synthesis"
)

// Agent 003 confused exact Go constant arithmetic with runtime float64
// arithmetic. This corrected test checks the actual language behavior.
func TestSynthesisRuntimeRounding(t *testing.T) {
	x, c := 0.1, 0.2
	spec := synthesis.Spec{Examples: []synthesis.Example{{X: x, Y: x + c}}, Constants: []float64{c}, MaxNodes: 3}
	r, err := synthesis.Synthesize(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	if got := runSwypPredict(t, r.Source, x); got != x+c {
		t.Fatalf("got %.17g, want %.17g", got, x+c)
	}
	spec.Examples[0].Y = 0.3
	if _, err := synthesis.Synthesize(context.Background(), spec); !errors.Is(err, synthesis.ErrExhausted) {
		t.Fatalf("rounded decimal target was accepted: %v", err)
	}
}
