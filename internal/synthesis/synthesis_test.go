package synthesis_test

import (
	"bytes"
	"context"
	"math"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"swyp-lang/internal/swyplang"
	"swyp-lang/internal/synthesis"
)

// runSwypPredict parses, type-checks, and executes the generated Swyp program
// with the given input argument x, returning the parsed float64 output.
func runSwypPredict(t *testing.T, source string, x float64) float64 {
	t.Helper()
	prog, err := swyplang.Parse("generated_predict.swyp", source)
	if err != nil {
		t.Fatalf("swyplang.Parse failed on generated source: %v\nSource:\n%s", err, source)
	}
	if err := prog.Check(); err != nil {
		t.Fatalf("swyplang.Check failed on generated program: %v\nSource:\n%s", err, source)
	}

	var out bytes.Buffer
	if err := prog.RunArgs(&out, 10000, []float64{x}); err != nil {
		t.Fatalf("swyplang.RunArgs failed for input %v: %v\nSource:\n%s", x, err, source)
	}

	trimmed := strings.TrimSpace(out.String())
	val, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		t.Fatalf("failed to parse program output %q as float64: %v", trimmed, err)
	}
	return val
}

// verifyDocumentedSourceContract asserts compliance with documented source template:
// fn predict(x: number) -> number { return EXPR; }
// fn main(){print(predict(arg(0)));}
func verifyDocumentedSourceContract(t *testing.T, res synthesis.Result) {
	t.Helper()
	if strings.TrimSpace(res.Expression) == "" {
		t.Fatalf("Result.Expression must not be empty")
	}
	if strings.TrimSpace(res.Source) == "" {
		t.Fatalf("Result.Source must not be empty")
	}
	if !strings.Contains(res.Source, "fn predict(x: number) -> number") {
		t.Errorf("Result.Source missing documented function signature 'fn predict(x: number) -> number':\n%s", res.Source)
	}
	if !strings.Contains(res.Source, "predict(arg(0))") {
		t.Errorf("Result.Source missing documented call 'predict(arg(0))':\n%s", res.Source)
	}
	if !strings.Contains(res.Source, "main") {
		t.Errorf("Result.Source missing fn main declaration:\n%s", res.Source)
	}
	if !strings.Contains(res.Source, res.Expression) {
		t.Errorf("Result.Source does not contain Expression %q:\n%s", res.Expression, res.Source)
	}

	// Must parse and type-check cleanly in swyplang
	prog, err := swyplang.Parse("contract_check.swyp", res.Source)
	if err != nil {
		t.Fatalf("generated source failed swyplang.Parse: %v\nSource:\n%s", err, res.Source)
	}
	if err := prog.Check(); err != nil {
		t.Fatalf("generated source failed swyplang.Check: %v\nSource:\n%s", err, res.Source)
	}
}

// TestSharedApiContract ensures type definitions and JSON struct tags strictly match shared spec.
func TestSharedApiContract(t *testing.T) {
	// Example struct tags
	exType := reflect.TypeOf(synthesis.Example{})
	expectTag(t, exType, "X", `json:"x"`)
	expectTag(t, exType, "Y", `json:"y"`)

	// Spec struct tags
	specType := reflect.TypeOf(synthesis.Spec{})
	expectTag(t, specType, "Examples", `json:"examples"`)
	expectTag(t, specType, "Constants", `json:"constants"`)
	expectTag(t, specType, "MaxNodes", `json:"max_nodes"`)
	expectTag(t, specType, "MaxCandidates", `json:"max_candidates"`)

	// Result struct tags
	resType := reflect.TypeOf(synthesis.Result{})
	expectTag(t, resType, "Expression", `json:"expression"`)
	expectTag(t, resType, "Source", `json:"source"`)
	expectTag(t, resType, "Candidates", `json:"candidates"`)
}

func expectTag(t *testing.T, typ reflect.Type, fieldName, expectedTag string) {
	t.Helper()
	field, ok := typ.FieldByName(fieldName)
	if !ok {
		t.Fatalf("type %s missing required field %q", typ.Name(), fieldName)
	}
	tag := string(field.Tag)
	if !strings.Contains(tag, expectedTag) {
		t.Errorf("field %s.%s tag %q does not match expected %q", typ.Name(), fieldName, tag, expectedTag)
	}
}

// TestValidation_InvalidParameters verifies input validation rules:
// max nodes 1..9, candidates 1..100000, examples 1..64, constants <= 16, and finite inputs.
func TestValidation_InvalidParameters(t *testing.T) {
	validExamples := []synthesis.Example{{X: 0, Y: 0}, {X: 1, Y: 1}}

	tests := []struct {
		name string
		spec synthesis.Spec
	}{
		{
			name: "MaxNodes negative",
			spec: synthesis.Spec{
				Examples: validExamples,
				MaxNodes: -1,
			},
		},
		{
			name: "MaxNodes exceeds 9",
			spec: synthesis.Spec{
				Examples: validExamples,
				MaxNodes: 10,
			},
		},
		{
			name: "MaxCandidates negative",
			spec: synthesis.Spec{
				Examples:      validExamples,
				MaxCandidates: -1,
			},
		},
		{
			name: "MaxCandidates exceeds 100000",
			spec: synthesis.Spec{
				Examples:      validExamples,
				MaxCandidates: 100001,
			},
		},
		{
			name: "Examples empty (0 examples)",
			spec: synthesis.Spec{
				Examples: nil,
			},
		},
		{
			name: "Examples exceeds 64",
			spec: synthesis.Spec{
				Examples: make([]synthesis.Example, 65),
			},
		},
		{
			name: "Constants exceeds 16",
			spec: synthesis.Spec{
				Examples:  validExamples,
				Constants: make([]float64, 17),
			},
		},
		{
			name: "Non-finite Example X (NaN)",
			spec: synthesis.Spec{
				Examples: []synthesis.Example{{X: math.NaN(), Y: 1}},
			},
		},
		{
			name: "Non-finite Example X (+Inf)",
			spec: synthesis.Spec{
				Examples: []synthesis.Example{{X: math.Inf(1), Y: 1}},
			},
		},
		{
			name: "Non-finite Example X (-Inf)",
			spec: synthesis.Spec{
				Examples: []synthesis.Example{{X: math.Inf(-1), Y: 1}},
			},
		},
		{
			name: "Non-finite Example Y (NaN)",
			spec: synthesis.Spec{
				Examples: []synthesis.Example{{X: 1, Y: math.NaN()}},
			},
		},
		{
			name: "Non-finite Example Y (+Inf)",
			spec: synthesis.Spec{
				Examples: []synthesis.Example{{X: 1, Y: math.Inf(1)}},
			},
		},
		{
			name: "Non-finite Example Y (-Inf)",
			spec: synthesis.Spec{
				Examples: []synthesis.Example{{X: 1, Y: math.Inf(-1)}},
			},
		},
		{
			name: "Non-finite Constant (NaN)",
			spec: synthesis.Spec{
				Examples:  validExamples,
				Constants: []float64{0, math.NaN(), 1},
			},
		},
		{
			name: "Non-finite Constant (+Inf)",
			spec: synthesis.Spec{
				Examples:  validExamples,
				Constants: []float64{0, math.Inf(1), 1},
			},
		},
		{
			name: "Non-finite Constant (-Inf)",
			spec: synthesis.Spec{
				Examples:  validExamples,
				Constants: []float64{0, math.Inf(-1), 1},
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := synthesis.Synthesize(context.Background(), tc.spec)
			if err == nil {
				t.Fatalf("expected validation error for case %q, but got nil", tc.name)
			}
		})
	}
}

// TestValidation_BoundariesAndDefaults verifies valid boundaries:
// MaxNodes in [1..9], MaxCandidates in [1..100000], Examples in [1..64], Constants <= 16.
func TestValidation_BoundariesAndDefaults(t *testing.T) {
	tests := []struct {
		name string
		spec synthesis.Spec
	}{
		{
			name: "Min MaxNodes 1",
			spec: synthesis.Spec{
				Examples: []synthesis.Example{{X: 1, Y: 1}},
				MaxNodes: 1,
			},
		},
		{
			name: "Max MaxNodes 9",
			spec: synthesis.Spec{
				Examples: []synthesis.Example{{X: 1, Y: 1}},
				MaxNodes: 9,
			},
		},
		{
			name: "Default MaxNodes 0 and MaxCandidates 0",
			spec: synthesis.Spec{
				Examples: []synthesis.Example{{X: 0, Y: 0}, {X: 1, Y: 1}},
			},
		},
		{
			name: "MaxCandidates boundary 100000",
			spec: synthesis.Spec{
				Examples:      []synthesis.Example{{X: 1, Y: 1}},
				MaxCandidates: 100000,
			},
		},
		{
			name: "Single example boundary (1 example)",
			spec: synthesis.Spec{
				Examples: []synthesis.Example{{X: 2, Y: 2}},
			},
		},
		{
			name: "Max examples boundary (64 examples)",
			spec: func() synthesis.Spec {
				exs := make([]synthesis.Example, 64)
				for i := range exs {
					exs[i] = synthesis.Example{X: float64(i), Y: float64(i)}
				}
				return synthesis.Spec{Examples: exs}
			}(),
		},
		{
			name: "Max constants boundary (16 constants)",
			spec: func() synthesis.Spec {
				consts := make([]float64, 16)
				for i := range consts {
					consts[i] = float64(i)
				}
				return synthesis.Spec{
					Examples:  []synthesis.Example{{X: 0, Y: 0}},
					Constants: consts,
				}
			}(),
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res, err := synthesis.Synthesize(context.Background(), tc.spec)
			if err != nil {
				t.Fatalf("expected valid boundary/defaults to succeed, got error: %v", err)
			}
			if res.Candidates <= 0 {
				t.Errorf("expected Candidates > 0, got %d", res.Candidates)
			}
		})
	}
}

// TestContextCancellation ensures immediate and mid-search context cancellation halts execution.
func TestContextCancellation(t *testing.T) {
	spec := synthesis.Spec{
		Examples: []synthesis.Example{
			{X: 1, Y: 2},
			{X: 2, Y: 4},
		},
	}

	t.Run("Already cancelled context", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		_, err := synthesis.Synthesize(ctx, spec)
		if err == nil {
			t.Fatalf("expected error on cancelled context, got nil")
		}
	})

	t.Run("Context canceled during search", func(t *testing.T) {
		// Provide a harder/impossible task with max budget to ensure search attempts work
		hardSpec := synthesis.Spec{
			Examples: []synthesis.Example{
				{X: 1, Y: 12345},
				{X: 2, Y: 67890},
			},
			MaxNodes:      9,
			MaxCandidates: 100000,
		}

		ctx, cancel := context.WithTimeout(context.Background(), 1*time.Millisecond)
		defer cancel()

		_, err := synthesis.Synthesize(ctx, hardSpec)
		if err == nil {
			t.Fatalf("expected error on timed out context, got nil")
		}
	})
}

// TestDeterminism verifies that repeated synthesis invocations return identical results.
func TestDeterminism(t *testing.T) {
	spec := synthesis.Spec{
		Examples: []synthesis.Example{
			{X: 0, Y: 1},
			{X: 1, Y: 3},
			{X: 2, Y: 5},
		},
		MaxNodes:      5,
		MaxCandidates: 10000,
	}

	res1, err1 := synthesis.Synthesize(context.Background(), spec)
	if err1 != nil {
		t.Fatalf("first Synthesize run failed: %v", err1)
	}

	res2, err2 := synthesis.Synthesize(context.Background(), spec)
	if err2 != nil {
		t.Fatalf("second Synthesize run failed: %v", err2)
	}

	if res1.Expression != res2.Expression {
		t.Errorf("determinism violation: Expression mismatch %q vs %q", res1.Expression, res2.Expression)
	}
	if res1.Source != res2.Source {
		t.Errorf("determinism violation: Source mismatch %q vs %q", res1.Source, res2.Source)
	}
	if res1.Candidates != res2.Candidates {
		t.Errorf("determinism violation: Candidates count mismatch %d vs %d", res1.Candidates, res2.Candidates)
	}
}

// TestBoundedImpossibleTask verifies that an unsatisfiable specification terminates
// deterministically when candidates/nodes are exhausted without hanging, respecting MaxCandidates.
func TestBoundedImpossibleTask(t *testing.T) {
	spec := synthesis.Spec{
		Examples: []synthesis.Example{
			{X: 1, Y: 999999},
			{X: 2, Y: 888888},
		},
		Constants:     []float64{0, 1},
		MaxNodes:      3,
		MaxCandidates: 50,
	}

	res, err := synthesis.Synthesize(context.Background(), spec)
	if err == nil {
		t.Fatalf("expected error for impossible specification, got expression: %s", res.Expression)
	}

	if res.Candidates > spec.MaxCandidates {
		t.Errorf("evaluated candidates (%d) exceeded MaxCandidates boundary (%d)", res.Candidates, spec.MaxCandidates)
	}
}

// TestMaxCandidateBoundaries verifies strict search candidate boundary enforcement.
func TestMaxCandidateBoundaries(t *testing.T) {
	// Set MaxCandidates to 1 on a task whose 1st candidate is not a match
	spec := synthesis.Spec{
		Examples: []synthesis.Example{
			{X: 5, Y: 125},
			{X: 6, Y: 216},
		},
		MaxCandidates: 1,
		MaxNodes:      5,
	}

	res, err := synthesis.Synthesize(context.Background(), spec)
	if err == nil {
		// If by chance candidate 1 matched, it must still satisfy candidate limit
		if res.Candidates > 1 {
			t.Errorf("Candidates %d exceeded MaxCandidates 1", res.Candidates)
		}
	} else {
		// When no solution found within 1 candidate, candidates evaluated must be <= 1
		if res.Candidates > 1 {
			t.Errorf("Candidates count %d exceeded MaxCandidates 1", res.Candidates)
		}
	}
}

// TestOverflowHandling verifies that intermediate float64 overflow (Inf / NaN) during
// evaluation does not panic or crash the synthesis search.
func TestOverflowHandling(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Synthesize panicked during overflow evaluation: %v", r)
		}
	}()

	spec := synthesis.Spec{
		Examples: []synthesis.Example{
			{X: 1e150, Y: 1e150},
			{X: 1e200, Y: 1e200},
		},
		Constants:     []float64{1e200, 1e250},
		MaxNodes:      5,
		MaxCandidates: 500,
	}

	// Should handle overflow gracefully (discarding candidate or returning err/res) without panic
	_, _ = synthesis.Synthesize(context.Background(), spec)
}

// TestSynthesize_Identity synthesizes the identity function (f(x) = x),
// verifies exact float64 equality on supplied examples, and evaluates held-out points
// using swyplang Parse, Check, and RunArgs.
func TestSynthesize_Identity(t *testing.T) {
	examples := []synthesis.Example{
		{X: 0, Y: 0},
		{X: 1, Y: 1},
		{X: 2, Y: 2},
	}

	spec := synthesis.Spec{
		Examples: examples,
		MaxNodes: 3,
	}

	res, err := synthesis.Synthesize(context.Background(), spec)
	if err != nil {
		t.Fatalf("Synthesize failed for identity: %v", err)
	}

	verifyDocumentedSourceContract(t, res)

	// Verify exact float64 equality on supplied training examples
	for _, ex := range examples {
		got := runSwypPredict(t, res.Source, ex.X)
		if got != ex.Y {
			t.Errorf("training example mismatch for X=%v: got %v, want %v", ex.X, got, ex.Y)
		}
	}

	// Held-out test points
	heldOut := []struct {
		x float64
		y float64
	}{
		{x: -10, y: -10},
		{x: 42.5, y: 42.5},
		{x: 100, y: 100},
		{x: -0.5, y: -0.5},
	}

	for _, ho := range heldOut {
		got := runSwypPredict(t, res.Source, ho.x)
		if got != ho.y {
			t.Errorf("held-out mismatch for X=%v: got %v, want %v", ho.x, got, ho.y)
		}
	}
}

// TestSynthesize_Linear_2xPlus1 synthesizes f(x) = 2*x + 1,
// verifies exact float64 equality on supplied examples, and evaluates held-out points
// using swyplang Parse, Check, and RunArgs.
func TestSynthesize_Linear_2xPlus1(t *testing.T) {
	examples := []synthesis.Example{
		{X: 0, Y: 1},
		{X: 1, Y: 3},
		{X: 2, Y: 5},
	}

	spec := synthesis.Spec{
		Examples: examples,
	}

	res, err := synthesis.Synthesize(context.Background(), spec)
	if err != nil {
		t.Fatalf("Synthesize failed for 2*x+1: %v", err)
	}

	verifyDocumentedSourceContract(t, res)

	// Verify exact float64 equality on supplied training examples
	for _, ex := range examples {
		got := runSwypPredict(t, res.Source, ex.X)
		if got != ex.Y {
			t.Errorf("training example mismatch for X=%v: got %v, want %v", ex.X, got, ex.Y)
		}
	}

	// Held-out test points
	heldOut := []struct {
		x float64
		y float64
	}{
		{x: 3, y: 7},
		{x: -2, y: -3},
		{x: 10, y: 21},
		{x: -5, y: -9},
	}

	for _, ho := range heldOut {
		got := runSwypPredict(t, res.Source, ho.x)
		if got != ho.y {
			t.Errorf("held-out mismatch for X=%v: got %v, want %v", ho.x, got, ho.y)
		}
	}
}

// TestSynthesize_Quadratic_xSquared synthesizes f(x) = x * x,
// verifies exact float64 equality on supplied examples, and evaluates held-out points
// using swyplang Parse, Check, and RunArgs.
func TestSynthesize_Quadratic_xSquared(t *testing.T) {
	examples := []synthesis.Example{
		{X: 0, Y: 0},
		{X: 1, Y: 1},
		{X: 2, Y: 4},
		{X: 3, Y: 9},
	}

	spec := synthesis.Spec{
		Examples: examples,
	}

	res, err := synthesis.Synthesize(context.Background(), spec)
	if err != nil {
		t.Fatalf("Synthesize failed for x*x: %v", err)
	}

	verifyDocumentedSourceContract(t, res)

	// Verify exact float64 equality on supplied training examples
	for _, ex := range examples {
		got := runSwypPredict(t, res.Source, ex.X)
		if got != ex.Y {
			t.Errorf("training example mismatch for X=%v: got %v, want %v", ex.X, got, ex.Y)
		}
	}

	// Held-out test points
	heldOut := []struct {
		x float64
		y float64
	}{
		{x: 4, y: 16},
		{x: -5, y: 25},
		{x: 10, y: 100},
		{x: -1, y: 1},
	}

	for _, ho := range heldOut {
		got := runSwypPredict(t, res.Source, ho.x)
		if got != ho.y {
			t.Errorf("held-out mismatch for X=%v: got %v, want %v", ho.x, got, ho.y)
		}
	}
}

// TestSynthesize_DefaultConstants verifies that when Constants is omitted or empty,
// default constants {-1, 0, 1, 2} are used.
func TestSynthesize_DefaultConstants(t *testing.T) {
	// Synthesize f(x) = x - 1 using default constant -1 or 1
	examples := []synthesis.Example{
		{X: 0, Y: -1},
		{X: 1, Y: 0},
		{X: 2, Y: 1},
	}

	spec := synthesis.Spec{
		Examples:  examples,
		Constants: nil, // Must use defaults {-1, 0, 1, 2}
	}

	res, err := synthesis.Synthesize(context.Background(), spec)
	if err != nil {
		t.Fatalf("Synthesize with default constants failed: %v", err)
	}

	verifyDocumentedSourceContract(t, res)

	for _, ex := range examples {
		got := runSwypPredict(t, res.Source, ex.X)
		if got != ex.Y {
			t.Errorf("training example mismatch for X=%v: got %v, want %v", ex.X, got, ex.Y)
		}
	}

	// Held-out
	gotHeldOut := runSwypPredict(t, res.Source, 10)
	if gotHeldOut != 9 {
		t.Errorf("held-out check failed: got %v, want 9", gotHeldOut)
	}
}

// TestSynthesize_CustomConstants verifies specifying custom constants.
func TestSynthesize_CustomConstants(t *testing.T) {
	// Synthesize f(x) = x + 7 with custom constants including 7
	examples := []synthesis.Example{
		{X: 0, Y: 7},
		{X: 1, Y: 8},
		{X: 2, Y: 9},
	}

	spec := synthesis.Spec{
		Examples:  examples,
		Constants: []float64{7},
	}

	res, err := synthesis.Synthesize(context.Background(), spec)
	if err != nil {
		t.Fatalf("Synthesize with custom constants failed: %v", err)
	}

	verifyDocumentedSourceContract(t, res)

	for _, ex := range examples {
		got := runSwypPredict(t, res.Source, ex.X)
		if got != ex.Y {
			t.Errorf("training example mismatch for X=%v: got %v, want %v", ex.X, got, ex.Y)
		}
	}

	gotHeldOut := runSwypPredict(t, res.Source, 5)
	if gotHeldOut != 12 {
		t.Errorf("held-out check failed: got %v, want 12", gotHeldOut)
	}
}
