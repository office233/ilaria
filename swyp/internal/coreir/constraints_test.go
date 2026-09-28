package coreir

import (
	"context"
	"sync"
	"testing"
)

func constraintFixture(t *testing.T) (*Executable, Contract) {
	t.Helper()
	e, err := Prepare(Module{Version: 1, Functions: []Function{{Name: "f", Params: []Parameter{{Name: "x", Type: I64}}, Result: I64, Slots: []Type{I64}, Blocks: []Block{{Terminator: Terminator{Op: "return", Value: 0}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	c := Contract{Version: 1, Entry: "f", Inputs: []Domain{{Name: "x", Type: I64, Min: "-3", Max: "3"}}, Ensures: []Predicate{{Op: "eq", Args: []Predicate{{Variable: "result"}, {Variable: "x"}}}}, MaxSteps: 100}
	return e, c
}

func TestConstraintsValidationAndNoVacuity(t *testing.T) {
	e, c := constraintFixture(t)
	c.Requires = []Predicate{{Op: "ge", Args: []Predicate{{Variable: "x"}, {Constant: &Literal{Type: I64, Value: "0"}}}}}
	constraints, err := PrepareConstraints(e, c)
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []int64{-4, -1, 4} {
		ok, err := constraints.Check([]Value{Int(n)}, Int(n))
		if err != nil || ok {
			t.Fatalf("nonadmissible %d: %v, %v", n, ok, err)
		}
	}
	for _, n := range []int64{0, 1, 3} {
		ok, err := constraints.Check([]Value{Int(n)}, Int(n))
		if err != nil || !ok {
			t.Fatalf("admissible %d: %v, %v", n, ok, err)
		}
	}
	for _, args := range [][]Value{nil, {Boolean(true)}, {Int(1), Int(2)}} {
		if _, err := constraints.Check(args, Int(1)); err == nil {
			t.Fatalf("accepted incorrect inputs %v", args)
		}
	}
	if _, err := constraints.Check([]Value{Int(1)}, Boolean(true)); err == nil {
		t.Fatal("accepted wrong output type")
	}
	if _, err := (*Constraints)(nil).Check(nil, Int(1)); err == nil {
		t.Fatal("accepted nil constraints")
	}
	c.Ensures[0].Op = "host_exec"
	if _, err := PrepareConstraints(e, c); err == nil {
		t.Fatal("accepted invalid contract")
	}
}

func TestConstraintsOwnershipConcurrencyAndVerifierParity(t *testing.T) {
	e, c := constraintFixture(t)
	constraints, err := PrepareConstraints(e, c)
	if err != nil {
		t.Fatal(err)
	}
	report, err := Verify(context.Background(), e, c, DefaultVerifyOptions())
	if err != nil || report.Status != "exhaustive" || report.CasesChecked != 7 {
		t.Fatalf("%+v %v", report, err)
	}
	c.Ensures[0].Args[1].Variable = "result"
	c.Inputs[0].Min = "0"
	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n := int64(-3); n <= 3; n++ {
				ok, err := constraints.Check([]Value{Int(n)}, Int(n))
				if err != nil || !ok {
					t.Errorf("owned constraints changed: %d %v %v", n, ok, err)
				}
				ok, err = constraints.Check([]Value{Int(n)}, Int(n+1))
				if err != nil || ok {
					t.Errorf("owned constraints accepted wrong result: %d %v %v", n, ok, err)
				}
			}
		}()
	}
	wg.Wait()
}

func TestConstraintsPredicateErrorsAndShortCircuit(t *testing.T) {
	e, c := constraintFixture(t)
	bad := Predicate{Op: "eq", Args: []Predicate{{Variable: "result"}, {Op: "div", Args: []Predicate{{Variable: "x"}, {Constant: &Literal{Type: I64, Value: "0"}}}}}}
	c.Ensures = []Predicate{bad}
	constraints, err := PrepareConstraints(e, c)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := constraints.Check([]Value{Int(1)}, Int(1)); err == nil {
		t.Fatal("silently accepted predicate division by zero")
	}
	c.Ensures = []Predicate{{Op: "or", Args: []Predicate{{Constant: &Literal{Type: Bool, Value: "true"}}, bad}}}
	constraints, err = PrepareConstraints(e, c)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := constraints.Check([]Value{Int(1)}, Int(1))
	if err != nil || !ok {
		t.Fatalf("short-circuit failed: %v %v", ok, err)
	}
}
