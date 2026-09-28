package coreir

import (
	"context"
	"encoding/json"
	"math"
	"math/rand"
	"testing"
	"time"
)

func predVar(n string) Predicate                    { return Predicate{Variable: n} }
func predOp(op string, args ...Predicate) Predicate { return Predicate{Op: op, Args: args} }
func predInt(n string) Predicate                    { return Predicate{Constant: &Literal{Type: I64, Value: n}} }
func squareContract() Contract {
	return Contract{Version: 1, Entry: "square", Inputs: []Domain{{Name: "x", Type: I64, Min: "-4", Max: "4"}}, Ensures: []Predicate{predOp("eq", predVar("result"), predOp("mul", predVar("x"), predVar("x")))}, MaxSteps: 100}
}
func squareExecutable(t *testing.T, correct bool) *Executable {
	t.Helper()
	ins := Instruction{Op: "mul", Dest: 1, Args: []int{0, 0}, MayTrap: true}
	if !correct {
		ins = Instruction{Op: "move", Dest: 1, Args: []int{0}}
	}
	m := Module{Version: 1, Functions: []Function{{Name: "square", Params: []Parameter{{Name: "x", Type: I64}}, Result: I64, Slots: []Type{I64, I64}, Blocks: []Block{{Instructions: []Instruction{ins}, Terminator: Terminator{Op: "return", Value: 1}}}}}}
	e, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	return e
}
func TestContractExhaustiveAndCounterexample(t *testing.T) {
	c := squareContract()
	options := DefaultVerifyOptions()
	r, err := Verify(context.Background(), squareExecutable(t, true), c, options)
	if err != nil || r.Status != "exhaustive" || !r.Exhaustive || r.CasesChecked != 9 || r.DomainSize != "9" {
		t.Fatal(r, err)
	}
	r, err = Verify(context.Background(), squareExecutable(t, false), c, options)
	if err != nil || r.Status != "counterexample" || r.Witness == nil || r.Witness.Inputs[0].Value.Literal().Value != "-4" || r.Witness.Result.Literal().Value != "-4" {
		t.Fatal(r, err)
	}
	c.Inputs[0].Min = "9007199254740993"
	c.Inputs[0].Max = "9007199254740995"
	c.Ensures = []Predicate{predOp("eq", predVar("result"), predVar("x"))}
	r, err = Verify(context.Background(), squareExecutable(t, false), c, options)
	if err != nil || r.Status != "exhaustive" || r.CasesChecked != 3 {
		t.Fatal(r, err)
	}
}
func TestContractCartesianEnumeration(t *testing.T) {
	m := Module{Version: 1, Functions: []Function{{Name: "sum", Params: []Parameter{{Name: "x", Type: I64}, {Name: "y", Type: I64}}, Result: I64, Slots: []Type{I64, I64, I64}, Blocks: []Block{{Instructions: []Instruction{{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: true}}, Terminator: Terminator{Op: "return", Value: 2}}}}}}
	e, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	c := Contract{Version: 1, Entry: "sum", Inputs: []Domain{{Name: "x", Type: I64, Min: "-2", Max: "2"}, {Name: "y", Type: I64, Min: "-2", Max: "2"}}, Ensures: []Predicate{predOp("eq", predVar("result"), predOp("add", predVar("x"), predVar("y")))}, MaxSteps: 100}
	r, err := Verify(context.Background(), e, c, DefaultVerifyOptions())
	if err != nil || r.CasesChecked != 25 || r.Status != "exhaustive" {
		t.Fatal(r, err)
	}
}
func TestContractNoVacuousSuccessOrFalseProof(t *testing.T) {
	e := squareExecutable(t, true)
	options := DefaultVerifyOptions()
	c := squareContract()
	c.Requires = []Predicate{predOp("gt", predVar("x"), predInt("100"))}
	r, err := Verify(context.Background(), e, c, options)
	if err != nil || r.Status != "unknown" || r.Reason != "no_admissible_inputs" || r.CasesChecked != 0 || r.CasesSkipped != 9 {
		t.Fatal(r, err)
	}
	c = squareContract()
	options.FuelPerCase = 1
	r, err = Verify(context.Background(), e, c, options)
	if err != nil || r.Status != "unknown" || r.Reason != "fuel_exhausted" {
		t.Fatal(r, err)
	}
	options = DefaultVerifyOptions()
	options.TotalFuel = 4
	r, err = Verify(context.Background(), e, c, options)
	if err != nil || r.Status != "unknown" || r.StepsConsumed > 4 {
		t.Fatal(r, err)
	}
	c = squareContract()
	c.Inputs[0].Min = "-9223372036854775808"
	c.Inputs[0].Max = "9223372036854775807"
	c.Ensures = []Predicate{predOp("eq", predVar("result"), predVar("x"))}
	options = DefaultVerifyOptions()
	options.MaxCases = 100
	r, err = Verify(context.Background(), squareExecutable(t, false), c, options)
	if err != nil || r.Status != "tested" || r.Exhaustive || r.DomainSize != "18446744073709551616" || r.CasesChecked != 100 {
		t.Fatal(r, err)
	}
	r2, err := Verify(context.Background(), squareExecutable(t, false), c, options)
	a, _ := json.Marshal(r)
	b, _ := json.Marshal(r2)
	if err != nil || string(a) != string(b) {
		t.Fatal("nondeterministic report", err)
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	r, err = Verify(ctx, e, squareContract(), options)
	if err != nil || r.Status != "timeout" || r.CasesChecked != 0 {
		t.Fatal(r, err)
	}
	ctx2, stop := context.WithCancel(context.Background())
	stop()
	r, err = Verify(ctx2, e, squareContract(), options)
	if err != nil || r.Status != "unknown" || r.Reason != "cancelled" {
		t.Fatal(r, err)
	}
}
func TestContractPredicateTrapsAndShortCircuit(t *testing.T) {
	c := squareContract()
	c.Ensures = []Predicate{predOp("eq", predVar("result"), predOp("div", predVar("x"), predInt("0")))}
	r, err := Verify(context.Background(), squareExecutable(t, true), c, DefaultVerifyOptions())
	if err != nil || r.Status != "unknown" || r.Reason != "contract_evaluation" {
		t.Fatal(r, err)
	}
	c = squareContract()
	c.Requires = []Predicate{predOp("and", predOp("ne", predVar("x"), predInt("0")), predOp("gt", predOp("div", predInt("10"), predVar("x")), predInt("0")))}
	r, err = Verify(context.Background(), squareExecutable(t, true), c, DefaultVerifyOptions())
	if err != nil || r.Status != "exhaustive" || r.CasesChecked != 4 || r.CasesSkipped != 5 {
		t.Fatal(r, err)
	}
	c = squareContract()
	c.Inputs[0].Min = "9223372036854775807"
	c.Inputs[0].Max = "9223372036854775807"
	r, err = Verify(context.Background(), squareExecutable(t, true), c, DefaultVerifyOptions())
	if err != nil || r.Status != "counterexample" || r.Reason != "runtime_error" || r.Witness.Diagnostic.Code != "overflow" {
		t.Fatal(r, err)
	}
}
func TestContractRejectsMalformedSpecifications(t *testing.T) {
	mutations := map[string]func(*Contract){
		"version":        func(c *Contract) { c.Version = 0 },
		"empty post":     func(c *Contract) { c.Ensures = nil },
		"unknown var":    func(c *Contract) { c.Ensures = []Predicate{predVar("missing")} },
		"result in pre":  func(c *Contract) { c.Requires = []Predicate{predOp("eq", predVar("result"), predInt("0"))} },
		"unknown op":     func(c *Contract) { c.Ensures = []Predicate{predOp("exec", predVar("x"))} },
		"effect":         func(c *Contract) { c.Effects = []string{"network"} },
		"wrong name":     func(c *Contract) { c.Inputs[0].Name = "y" },
		"wrong type":     func(c *Contract) { c.Inputs[0].Type = F64 },
		"null minimum":   func(c *Contract) { c.Inputs[0].Min = "" },
		"reversed range": func(c *Contract) { c.Inputs[0].Min = "100" },
		"fuel":           func(c *Contract) { c.MaxSteps = 0 },
		"numeric post":   func(c *Contract) { c.Ensures = []Predicate{predInt("1")} },
		"ambiguous node": func(c *Contract) { c.Ensures = []Predicate{{Variable: "result", Op: "not"}} },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			c := squareContract()
			mutate(&c)
			if _, err := Verify(context.Background(), squareExecutable(t, true), c, DefaultVerifyOptions()); err == nil {
				t.Fatal("accepted invalid contract")
			}
		})
	}
}
func TestContractFloatSamplingAndSubnormalBounds(t *testing.T) {
	cases := []interval{
		{low: Value{typ: F64, f: math.SmallestNonzeroFloat64}, high: Value{typ: F64, f: math.SmallestNonzeroFloat64}},
		{low: Value{typ: F64, f: -math.SmallestNonzeroFloat64}, high: Value{typ: F64, f: -math.SmallestNonzeroFloat64}},
		{low: Value{typ: F64, f: -math.MaxFloat64}, high: Value{typ: F64, f: math.MaxFloat64}},
		{low: Int(minI64), high: Int(maxI64)},
		{low: Int(maxI64 - 2), high: Int(maxI64)},
	}
	for _, b := range cases {
		rng := rand.New(rand.NewSource(42))
		for i := 0; i < 1000; i++ {
			v := sampledCase([]interval{b}, i, rng)[0]
			if !within(v, b) {
				t.Fatalf("sample escaped domain: %v [%v,%v]", v, b.low, b.high)
			}
		}
	}
	m := Module{Version: 1, Functions: []Function{{Name: "identity", Params: []Parameter{{Name: "x", Type: F64}}, Result: F64, Slots: []Type{F64}, Blocks: []Block{{Terminator: Terminator{Op: "return", Value: 0}}}}}}
	e, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	c := Contract{Version: 1, Entry: "identity", Inputs: []Domain{{Name: "x", Type: F64, Min: "0", Max: "1"}}, Ensures: []Predicate{predOp("eq", predVar("result"), predVar("x"))}, MaxSteps: 100}
	r, err := Verify(context.Background(), e, c, DefaultVerifyOptions())
	if err != nil || r.Status != "tested" || r.Exhaustive {
		t.Fatal(r, err)
	}
}
func FuzzContractDecodeAndVerify(f *testing.F) {
	data, _ := json.Marshal(squareContract())
	f.Add(data)
	f.Add([]byte(`{}`))
	f.Add([]byte(`{"version":1,"version":2}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		c, err := DecodeContract(data)
		if err != nil {
			return
		}
		options := VerifyOptions{MaxCases: 4, FuelPerCase: 16, TotalFuel: 64, Seed: 1}
		_, _ = Verify(context.Background(), squareExecutable(t, true), c, options)
	})
}
