package main

import (
	"bytes"
	"fmt"
	"math"
	"strconv"
	"strings"

	"swyp-lang/internal/swyplang"
)

// ----------------------------------------------------------------------------
// 1. Scalar Arithmetic AST & Pure Evaluator
// ----------------------------------------------------------------------------

type Expr interface {
	String() string
	Eval(env map[string]float64, fuel *int) (float64, error)
	NodeCount() int
	FindFault(env map[string]float64, fuel *int) (Expr, error)
}

var (
	ErrDivZero       = fmt.Errorf("division by zero")
	ErrModZero       = fmt.Errorf("remainder by zero")
	ErrNonFinite     = fmt.Errorf("non-finite numeric result")
	ErrFuelExhausted = fmt.Errorf("eval fuel exhausted")
)

type Lit struct {
	Val float64
}

func (l *Lit) String() string {
	if l.Val == math.Trunc(l.Val) && !math.IsNaN(l.Val) && !math.IsInf(l.Val, 0) {
		return strconv.FormatFloat(l.Val, 'f', 0, 64)
	}
	return strconv.FormatFloat(l.Val, 'g', 10, 64)
}

func (l *Lit) Eval(env map[string]float64, fuel *int) (float64, error) {
	if *fuel <= 0 {
		return 0, ErrFuelExhausted
	}
	*fuel--
	if math.IsNaN(l.Val) || math.IsInf(l.Val, 0) {
		return 0, ErrNonFinite
	}
	return l.Val, nil
}

func (l *Lit) NodeCount() int { return 1 }

func (l *Lit) FindFault(env map[string]float64, fuel *int) (Expr, error) {
	_, err := l.Eval(env, fuel)
	if err != nil {
		return l, err
	}
	return nil, nil
}

type Var struct {
	Name string
}

func (v *Var) String() string { return v.Name }

func (v *Var) Eval(env map[string]float64, fuel *int) (float64, error) {
	if *fuel <= 0 {
		return 0, ErrFuelExhausted
	}
	*fuel--
	val, ok := env[v.Name]
	if !ok {
		return 0, fmt.Errorf("undefined variable: %s", v.Name)
	}
	if math.IsNaN(val) || math.IsInf(val, 0) {
		return 0, ErrNonFinite
	}
	return val, nil
}

func (v *Var) NodeCount() int { return 1 }

func (v *Var) FindFault(env map[string]float64, fuel *int) (Expr, error) {
	_, err := v.Eval(env, fuel)
	if err != nil {
		return v, err
	}
	return nil, nil
}

type Binary struct {
	Op    string
	Left  Expr
	Right Expr
}

func (b *Binary) String() string {
	return fmt.Sprintf("(%s %s %s)", b.Left.String(), b.Op, b.Right.String())
}

func (b *Binary) NodeCount() int {
	return 1 + b.Left.NodeCount() + b.Right.NodeCount()
}

func (b *Binary) Eval(env map[string]float64, fuel *int) (float64, error) {
	if *fuel <= 0 {
		return 0, ErrFuelExhausted
	}
	*fuel--

	l, err := b.Left.Eval(env, fuel)
	if err != nil {
		return 0, err
	}
	r, err := b.Right.Eval(env, fuel)
	if err != nil {
		return 0, err
	}

	var res float64
	switch b.Op {
	case "+":
		res = l + r
	case "-":
		res = l - r
	case "*":
		res = l * r
	case "/":
		if r == 0 {
			return 0, ErrDivZero
		}
		res = l / r
	case "%":
		if r == 0 {
			return 0, ErrModZero
		}
		res = math.Mod(l, r)
	default:
		return 0, fmt.Errorf("unsupported operator: %s", b.Op)
	}

	if math.IsNaN(res) || math.IsInf(res, 0) {
		return 0, ErrNonFinite
	}
	return res, nil
}

func (b *Binary) FindFault(env map[string]float64, fuel *int) (Expr, error) {
	if *fuel <= 0 {
		return b, ErrFuelExhausted
	}
	*fuel--

	// Check left
	if fault, err := b.Left.FindFault(env, fuel); err != nil {
		return fault, err
	}
	// Check right
	if fault, err := b.Right.FindFault(env, fuel); err != nil {
		return fault, err
	}

	// Check self
	_, err := b.Eval(env, fuel)
	if err != nil {
		return b, err
	}
	return nil, nil
}

// ----------------------------------------------------------------------------
// 2. Repair Engine Definitions & Types
// ----------------------------------------------------------------------------

type Example struct {
	X float64
	Y float64
}

type RepairType string

const (
	RepairSemanticsPreserving RepairType = "Semantics-Preserving"
	RepairSemanticsChanging   RepairType = "Semantics-Changing"
	RepairGuardedPiecewise    RepairType = "Guarded-Piecewise"
	RepairUnsatisfiable       RepairType = "Unsatisfiable"
)

type RepairConfig struct {
	MaxCandidates int
	MaxNodes      int
	Constants     []float64
	FuelPerEval   int
}

type RepairResult struct {
	Name                string
	Original            string
	Repaired            string
	SwypSource          string
	Type                RepairType
	CandidatesEvaluated int
	FuelRemaining       int
	Solved              bool
	Diagnostic          string
}

// ----------------------------------------------------------------------------
// 3. Repair Strategies
// ----------------------------------------------------------------------------

// Check if candidate matches all examples
func satisfiesAll(e Expr, examples []Example, fuelPerEval int) bool {
	for _, ex := range examples {
		f := fuelPerEval
		val, err := e.Eval(map[string]float64{"x": ex.X}, &f)
		if err != nil {
			return false
		}
		if val != ex.Y {
			return false
		}
	}
	return true
}

// Check equivalence on non-singular points
func isEquivalentOnDefined(e1, e2 Expr, definedInputs []float64, fuelPerEval int) bool {
	for _, x := range definedInputs {
		f1, f2 := fuelPerEval, fuelPerEval
		v1, err1 := e1.Eval(map[string]float64{"x": x}, &f1)
		v2, err2 := e2.Eval(map[string]float64{"x": x}, &f2)
		if err1 == nil && err2 == nil {
			if v1 != v2 {
				return false
			}
		}
	}
	return true
}

// Strategy 1: Operator Mutation
// Mutates binary operators (+, -, *, /, %) to find an alternative satisfying examples
func tryOperatorMutation(e Expr, examples []Example, cfg RepairConfig, cCount *int) (Expr, bool) {
	bin, ok := e.(*Binary)
	if !ok {
		return nil, false
	}

	ops := []string{"+", "-", "*", "/", "%"}
	for _, op := range ops {
		if op == bin.Op {
			continue
		}
		(*cCount)++
		cand := &Binary{Op: op, Left: bin.Left, Right: bin.Right}
		if satisfiesAll(cand, examples, cfg.FuelPerEval) {
			return cand, true
		}
	}

	// Recursively check children
	if leftRep, ok := tryOperatorMutation(bin.Left, examples, cfg, cCount); ok {
		return &Binary{Op: bin.Op, Left: leftRep, Right: bin.Right}, true
	}
	if rightRep, ok := tryOperatorMutation(bin.Right, examples, cfg, cCount); ok {
		return &Binary{Op: bin.Op, Left: bin.Left, Right: rightRep}, true
	}

	return nil, false
}

// Strategy 2: Operand Inversion
// Swaps Left and Right operands in asymmetric operators (/, -, %)
func tryOperandInversion(e Expr, examples []Example, cfg RepairConfig, cCount *int) (Expr, bool) {
	bin, ok := e.(*Binary)
	if !ok {
		return nil, false
	}

	if bin.Op == "/" || bin.Op == "-" || bin.Op == "%" {
		(*cCount)++
		cand := &Binary{Op: bin.Op, Left: bin.Right, Right: bin.Left}
		if satisfiesAll(cand, examples, cfg.FuelPerEval) {
			return cand, true
		}
	}

	if leftRep, ok := tryOperandInversion(bin.Left, examples, cfg, cCount); ok {
		return &Binary{Op: bin.Op, Left: leftRep, Right: bin.Right}, true
	}
	if rightRep, ok := tryOperandInversion(bin.Right, examples, cfg, cCount); ok {
		return &Binary{Op: bin.Op, Left: bin.Left, Right: rightRep}, true
	}

	return nil, false
}

// Strategy 3: Algebraic Cancellation / Removable Singularity Elimination
// Detects patterns like (x * c) / x -> c or (x * x - 1) / (x - 1) -> (x + 1)
func tryAlgebraicCancellation(e Expr, examples []Example, cfg RepairConfig, cCount *int) (Expr, bool) {
	bin, ok := e.(*Binary)
	if !ok || bin.Op != "/" {
		return nil, false
	}

	// Pattern: (A * B) / A -> B
	if leftBin, ok := bin.Left.(*Binary); ok && leftBin.Op == "*" {
		(*cCount)++
		if leftBin.Left.String() == bin.Right.String() {
			if satisfiesAll(leftBin.Right, examples, cfg.FuelPerEval) {
				return leftBin.Right, true
			}
		}
		(*cCount)++
		if leftBin.Right.String() == bin.Right.String() {
			if satisfiesAll(leftBin.Left, examples, cfg.FuelPerEval) {
				return leftBin.Left, true
			}
		}
	}

	// Pattern: (x * x - c^2) / (x - c) -> (x + c)
	if leftBin, ok := bin.Left.(*Binary); ok && leftBin.Op == "-" {
		if leftSq, ok := leftBin.Left.(*Binary); ok && leftSq.Op == "*" && leftSq.Left.String() == leftSq.Right.String() {
			if rightBin, ok := bin.Right.(*Binary); ok && rightBin.Op == "-" {
				if rightBin.Left.String() == leftSq.Left.String() {
					// Check if right constant squared equals left constant
					if cLit, ok := rightBin.Right.(*Lit); ok {
						if cSqLit, ok := leftBin.Right.(*Lit); ok {
							if math.Abs(cLit.Val*cLit.Val-cSqLit.Val) < 1e-9 {
								(*cCount)++
								cand := &Binary{Op: "+", Left: rightBin.Left, Right: cLit}
								if satisfiesAll(cand, examples, cfg.FuelPerEval) {
									return cand, true
								}
							}
						}
					}
				}
			}
		}
	}

	return nil, false
}

// Signature for observational equivalence pruning
func evalSig(e Expr, examples []Example, fuel int) (string, bool) {
	var b strings.Builder
	for _, ex := range examples {
		f := fuel
		val, err := e.Eval(map[string]float64{"x": ex.X}, &f)
		if err != nil {
			return "", false
		}
		b.WriteString(strconv.FormatFloat(val, 'g', 10, 64))
		b.WriteByte(';')
	}
	return b.String(), true
}

// Strategy 4: Localized Sub-tree Synthesis (Bounded Enumeration with Observational Equivalence)
// Replaces a failing subtree with expressions synthesized under node bounds
func synthesizeSubtree(targetNodes int, examples []Example, constants []float64, cfg RepairConfig, cCount *int) (Expr, bool) {
	terminals := []Expr{&Var{Name: "x"}}
	for _, c := range constants {
		terminals = append(terminals, &Lit{Val: c})
	}

	seenSigs := make(map[string]bool)

	// Bottom-up level generation: pool[nodeCount] = []Expr
	pool := make(map[int][]Expr)
	pool[1] = terminals

	for _, t := range terminals {
		(*cCount)++
		if *cCount > cfg.MaxCandidates {
			return nil, false
		}
		if satisfiesAll(t, examples, cfg.FuelPerEval) {
			return t, true
		}
		if sig, ok := evalSig(t, examples, cfg.FuelPerEval); ok {
			seenSigs[sig] = true
		}
	}

	ops := []string{"+", "-", "*", "/"}
	for n := 3; n <= targetNodes; n += 2 {
		for lSize := 1; lSize < n-1; lSize += 2 {
			rSize := n - 1 - lSize
			for _, left := range pool[lSize] {
				for _, right := range pool[rSize] {
					for _, op := range ops {
						(*cCount)++
						if *cCount > cfg.MaxCandidates {
							return nil, false
						}
						cand := &Binary{Op: op, Left: left, Right: right}
						if satisfiesAll(cand, examples, cfg.FuelPerEval) {
							return cand, true
						}
						if sig, ok := evalSig(cand, examples, cfg.FuelPerEval); ok {
							if !seenSigs[sig] {
								seenSigs[sig] = true
								pool[n] = append(pool[n], cand)
							}
						}
					}
				}
			}
		}
	}

	return nil, false
}

// Strategy 5: Guarded Piecewise Function Synthesis
// Generates a Swyp conditional: if (denominator == 0) { return fallback; } else { return expr; }
func tryGuardedPiecewise(e Expr, examples []Example, cfg RepairConfig) (string, bool) {
	bin, ok := e.(*Binary)
	if !ok || (bin.Op != "/" && bin.Op != "%") {
		return "", false
	}

	// Find zero denominator inputs
	var zeroInputs []Example
	var nonZeroInputs []Example
	for _, ex := range examples {
		f := cfg.FuelPerEval
		denVal, err := bin.Right.Eval(map[string]float64{"x": ex.X}, &f)
		if err != nil || denVal == 0 {
			zeroInputs = append(zeroInputs, ex)
		} else {
			nonZeroInputs = append(nonZeroInputs, ex)
		}
	}

	if len(zeroInputs) == 0 {
		return "", false
	}

	// Ensure non-zero inputs satisfy the original expression
	for _, nz := range nonZeroInputs {
		f := cfg.FuelPerEval
		val, err := bin.Eval(map[string]float64{"x": nz.X}, &f)
		if err != nil || val != nz.Y {
			return "", false
		}
	}

	// If all zero inputs share a common expected Y or single point
	fallbackVal := zeroInputs[0].Y
	for _, zi := range zeroInputs {
		if zi.Y != fallbackVal {
			// Inconsistent fallback requirements
			return "", false
		}
	}

	// Build safe conditional Swyp function
	cond := fmt.Sprintf("%s == 0", bin.Right.String())
	source := fmt.Sprintf(`fn predict(x: number) -> number {
    if (%s) {
        return %s;
    }
    return %s;
}

fn main() {
    print(predict(arg(0)));
}`, cond, strconv.FormatFloat(fallbackVal, 'g', 10, 64), bin.String())

	return source, true
}

// ----------------------------------------------------------------------------
// 4. Main Repair Pipeline
// ----------------------------------------------------------------------------

func RepairExpression(name string, orig Expr, examples []Example, cfg RepairConfig) RepairResult {
	res := RepairResult{
		Name:          name,
		Original:      orig.String(),
		FuelRemaining: cfg.MaxCandidates,
	}

	// 1. Initial Evaluation & Diagnostics
	fTest := cfg.FuelPerEval
	var faultExpr Expr
	var faultErr error
	var definedInputs []float64

	for _, ex := range examples {
		f := fTest
		val, err := orig.Eval(map[string]float64{"x": ex.X}, &f)
		if err != nil {
			if faultErr == nil {
				faultErr = err
				fDiag := fTest
				faultExpr, _ = orig.FindFault(map[string]float64{"x": ex.X}, &fDiag)
			}
		} else {
			definedInputs = append(definedInputs, ex.X)
			if val != ex.Y && faultErr == nil {
				faultErr = fmt.Errorf("wrong output for x=%g: got %g, want %g", ex.X, val, ex.Y)
				faultExpr = orig
			}
		}
	}

	if faultErr == nil {
		res.Repaired = orig.String()
		res.Solved = true
		res.Type = RepairSemanticsPreserving
		res.Diagnostic = "Expression already satisfies all examples."
		res.SwypSource = formatSwypSource(orig.String())
		return res
	}

	res.Diagnostic = fmt.Sprintf("Fault: %v at sub-expression %s", faultErr, faultExpr)

	cCount := 0

	// 2. Try Algebraic Cancellation (Semantics Preserving on Defined Inputs)
	if rep, ok := tryAlgebraicCancellation(orig, examples, cfg, &cCount); ok {
		res.Solved = true
		res.Repaired = rep.String()
		res.CandidatesEvaluated = cCount
		res.FuelRemaining = cfg.MaxCandidates - cCount
		res.Type = RepairSemanticsPreserving
		res.SwypSource = formatSwypSource(rep.String())
		return res
	}

	// 3. Try Operand Inversion
	if rep, ok := tryOperandInversion(orig, examples, cfg, &cCount); ok {
		res.Solved = true
		res.Repaired = rep.String()
		res.CandidatesEvaluated = cCount
		res.FuelRemaining = cfg.MaxCandidates - cCount
		if isEquivalentOnDefined(orig, rep, definedInputs, cfg.FuelPerEval) {
			res.Type = RepairSemanticsPreserving
		} else {
			res.Type = RepairSemanticsChanging
		}
		res.SwypSource = formatSwypSource(rep.String())
		return res
	}

	// 4. Try Operator Mutation
	if rep, ok := tryOperatorMutation(orig, examples, cfg, &cCount); ok {
		res.Solved = true
		res.Repaired = rep.String()
		res.CandidatesEvaluated = cCount
		res.FuelRemaining = cfg.MaxCandidates - cCount
		if isEquivalentOnDefined(orig, rep, definedInputs, cfg.FuelPerEval) {
			res.Type = RepairSemanticsPreserving
		} else {
			res.Type = RepairSemanticsChanging
		}
		res.SwypSource = formatSwypSource(rep.String())
		return res
	}

	// 5. Try Localized Sub-tree Synthesis
	if rep, ok := synthesizeSubtree(cfg.MaxNodes, examples, cfg.Constants, cfg, &cCount); ok {
		res.Solved = true
		res.Repaired = rep.String()
		res.CandidatesEvaluated = cCount
		res.FuelRemaining = remainingFuel(cfg.MaxCandidates, cCount)
		if isEquivalentOnDefined(orig, rep, definedInputs, cfg.FuelPerEval) {
			res.Type = RepairSemanticsPreserving
		} else {
			res.Type = RepairSemanticsChanging
		}
		res.SwypSource = formatSwypSource(rep.String())
		return res
	}

	// 6. Try Guarded Piecewise Wrapper
	if guardedSrc, ok := tryGuardedPiecewise(orig, examples, cfg); ok {
		res.Solved = true
		res.Repaired = "piecewise guard conditional"
		res.CandidatesEvaluated = cCount + 1
		res.FuelRemaining = remainingFuel(cfg.MaxCandidates, cCount+1)
		res.Type = RepairGuardedPiecewise
		res.SwypSource = guardedSrc
		return res
	}

	// 7. Unsatisfiable / Budget Exhausted
	res.Solved = false
	res.CandidatesEvaluated = cCount
	res.FuelRemaining = remainingFuel(cfg.MaxCandidates, cCount)
	res.Type = RepairUnsatisfiable
	res.Repaired = "<none>"
	return res
}

func remainingFuel(maxC, used int) int {
	if used >= maxC {
		return 0
	}
	return maxC - used
}

func formatSwypSource(exprStr string) string {
	return fmt.Sprintf(`fn predict(x: number) -> number {
    return %s;
}

fn main() {
    print(predict(arg(0)));
}`, exprStr)
}

// ----------------------------------------------------------------------------
// 5. Toy Test Suite Execution & Validation
// ----------------------------------------------------------------------------

func main() {
	fmt.Println("REJECTED PROTOTYPE: labels and budget accounting below are not trustworthy; see docs/EXPERIMENT_REPAIR.md. Do not apply these repairs.")
	fmt.Println("==================================================================")
	fmt.Println(" Swyp Lang: Bounded Non-LLM Scalar Arithmetic Repair Benchmark")
	fmt.Println("==================================================================")

	defaultCfg := RepairConfig{
		MaxCandidates: 2000,
		MaxNodes:      5,
		Constants:     []float64{-2, -1, 0, 1, 2, 4},
		FuelPerEval:   100,
	}

	tests := []struct {
		name     string
		expr     Expr
		examples []Example
		cfg      RepairConfig
	}{
		{
			name: "Case 1: Div-by-zero repaired by Operand Inversion (2 / x -> x / 2)",
			expr: &Binary{Op: "/", Left: &Lit{Val: 2}, Right: &Var{Name: "x"}},
			examples: []Example{
				{X: 0, Y: 0},
				{X: 2, Y: 1},
				{X: 4, Y: 2},
			},
			cfg: defaultCfg,
		},
		{
			name: "Case 2: Removable Singularity via Algebraic Cancellation ((x * 2) / x -> 2)",
			expr: &Binary{
				Op:    "/",
				Left:  &Binary{Op: "*", Left: &Var{Name: "x"}, Right: &Lit{Val: 2}},
				Right: &Var{Name: "x"},
			},
			examples: []Example{
				{X: 0, Y: 2},
				{X: 1, Y: 2},
				{X: 3, Y: 2},
			},
			cfg: defaultCfg,
		},
		{
			name: "Case 3: Factorizable Singularity ((x * x - 1) / (x - 1) -> (x + 1))",
			expr: &Binary{
				Op: "/",
				Left: &Binary{
					Op:    "-",
					Left:  &Binary{Op: "*", Left: &Var{Name: "x"}, Right: &Var{Name: "x"}},
					Right: &Lit{Val: 1},
				},
				Right: &Binary{Op: "-", Left: &Var{Name: "x"}, Right: &Lit{Val: 1}},
			},
			examples: []Example{
				{X: 1, Y: 2}, // Singularity at x=1
				{X: 0, Y: 1},
				{X: 2, Y: 3},
				{X: -1, Y: 0},
			},
			cfg: defaultCfg,
		},
		{
			name: "Case 4: Div-by-zero repaired by Operator Mutation ((x + 2) / 2 -> (x + 2) * 2)",
			expr: &Binary{
				Op:    "/",
				Left:  &Binary{Op: "+", Left: &Var{Name: "x"}, Right: &Lit{Val: 2}},
				Right: &Lit{Val: 2},
			},
			examples: []Example{
				{X: 0, Y: 4}, // (0+2)*2 = 4
				{X: 1, Y: 6}, // (1+2)*2 = 6
				{X: 2, Y: 8}, // (2+2)*2 = 8
			},
			cfg: defaultCfg,
		},
		{
			name: "Case 5: Faulty Division replaced by Bounded Synthesis ((x + 2) / x -> quadratic)",
			// Original crashes at x=0. User wants parabola y = -x^2 + 2x + 2
			expr: &Binary{
				Op:    "/",
				Left:  &Binary{Op: "+", Left: &Var{Name: "x"}, Right: &Lit{Val: 2}},
				Right: &Var{Name: "x"},
			},
			examples: []Example{
				{X: 0, Y: 2},
				{X: 1, Y: 3},
				{X: 2, Y: 2},
			},
			cfg: RepairConfig{
				MaxCandidates: 5000,
				MaxNodes:      7,
				Constants:     []float64{-1, 0, 1, 2},
				FuelPerEval:   100,
			},
		},
		{
			name: "Case 6: Essential Singularity repaired by Guarded Piecewise (10 / x)",
			expr: &Binary{
				Op:    "/",
				Left:  &Lit{Val: 10},
				Right: &Var{Name: "x"},
			},
			examples: []Example{
				{X: 0, Y: 0}, // Fallback value at singularity
				{X: 1, Y: 10},
				{X: 2, Y: 5},
				{X: 5, Y: 2},
			},
			cfg: defaultCfg,
		},
		{
			name: "Case 7: Unsatisfiable due to Contradictory Specification",
			expr: &Binary{Op: "/", Left: &Lit{Val: 1}, Right: &Var{Name: "x"}},
			examples: []Example{
				{X: 0, Y: 10},
				{X: 0, Y: 20}, // Contradiction: same input, different outputs
			},
			cfg: defaultCfg,
		},
		{
			name: "Case 8: Unsatisfiable due to Fuel Budget Exhaustion",
			expr: &Binary{Op: "/", Left: &Lit{Val: 1}, Right: &Var{Name: "x"}},
			examples: []Example{
				{X: 1, Y: 100},
				{X: 2, Y: 200},
				{X: 3, Y: 300},
			},
			cfg: RepairConfig{
				MaxCandidates: 20, // Extremely tight candidate fuel
				MaxNodes:      3,
				Constants:     []float64{1, 2},
				FuelPerEval:   50,
			},
		},
	}

	passCount := 0
	failCount := 0

	for i, tt := range tests {
		fmt.Printf("\n--- Test %d: %s ---\n", i+1, tt.name)
		fmt.Printf("Original Expression: %s\n", tt.expr.String())
		fmt.Printf("Examples: %v\n", tt.examples)

		res := RepairExpression(tt.name, tt.expr, tt.examples, tt.cfg)

		fmt.Printf("Diagnostic: %s\n", res.Diagnostic)
		fmt.Printf("Outcome: Solved=%t, Type=%s, Repaired=%s\n", res.Solved, res.Type, res.Repaired)
		fmt.Printf("Search Stats: Candidates=%d, FuelRemaining=%d\n", res.CandidatesEvaluated, res.FuelRemaining)

		// Verification with Swyp compiler
		if res.Solved && res.SwypSource != "" {
			prog, err := swyplang.Parse("test_repair.swyp", res.SwypSource)
			if err != nil {
				fmt.Printf("Swyp Parse FAILED: %v\n", err)
				failCount++
				continue
			}
			if err := prog.Check(); err != nil {
				fmt.Printf("Swyp Check FAILED: %v\n", err)
				failCount++
				continue
			}

			// Run in Swyp interpreter for each example
			allPassed := true
			for _, ex := range tt.examples {
				var out bytes.Buffer
				err := prog.RunArgs(&out, 10000, []float64{ex.X})
				if err != nil {
					fmt.Printf("Swyp RunArgs FAILED for x=%g: %v\n", ex.X, err)
					allPassed = false
					break
				}
				resVal, err := strconv.ParseFloat(strings.TrimSpace(out.String()), 64)
				if err != nil || resVal != ex.Y {
					fmt.Printf("Swyp Output Mismatch for x=%g: got %g, want %g\n", ex.X, resVal, ex.Y)
					allPassed = false
					break
				}
			}
			if allPassed {
				fmt.Println("Swyp Compiler & Interpreter Verification: PASSED (100% exact float match)")
				passCount++
			} else {
				failCount++
			}
		} else if !res.Solved && (tt.name == "Case 7: Unsatisfiable due to Contradictory Specification" || tt.name == "Case 8: Unsatisfiable due to Fuel Budget Exhaustion") {
			fmt.Printf("Unsatisfiable Gate Verified: Correctly rejected as %s\n", res.Type)
			passCount++
		} else {
			fmt.Println("Test Result: FAILED")
			failCount++
		}
	}

	fmt.Println("\n==================================================================")
	fmt.Printf("Benchmark Summary: Total=%d, Passed=%d, Failed=%d\n", len(tests), passCount, failCount)
	fmt.Println("==================================================================")
}
