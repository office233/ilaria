package coreir

import "testing"

func TestInterferenceGraphMarksSimultaneouslyLiveOperands(t *testing.T) {
	f := Function{
		Name:   "add",
		Params: []Parameter{{Name: "x", Type: I64}, {Name: "y", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 2},
		}},
	}
	graph, err := InterferenceGraph(f)
	if err != nil {
		t.Fatal(err)
	}
	if !graph[0][1] {
		t.Fatal("x and y must interfere before add")
	}
	if graph[0][2] && graph[1][2] {
		t.Fatal("result should be able to reuse at least one dead operand register")
	}
}

func TestAllocateRegistersReusesDeadOperandRegister(t *testing.T) {
	f := Function{
		Name:   "add",
		Params: []Parameter{{Name: "x", Type: I64}, {Name: "y", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 2},
		}},
	}
	plan, err := AllocateRegisters(f, 2, 0)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Spills != 0 || plan.GPRUsed != 2 {
		t.Fatalf("plan=%+v", plan)
	}
	if plan.Locations[0].Register == plan.Locations[1].Register {
		t.Fatalf("operands share register: %+v", plan.Locations)
	}
	resultReg := plan.Locations[2].Register
	if resultReg != plan.Locations[0].Register && resultReg != plan.Locations[1].Register {
		t.Fatalf("result did not reuse dead operand register: %+v", plan.Locations)
	}
}

func TestAllocateRegistersSpillsWhenBankTooSmall(t *testing.T) {
	f := Function{
		Name:   "add",
		Params: []Parameter{{Name: "x", Type: I64}, {Name: "y", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 2},
		}},
	}
	plan, err := AllocateRegisters(f, 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Spills == 0 {
		t.Fatalf("expected spill: %+v", plan)
	}
}

func TestAllocateRegistersSeparatesFPAndGPRBanks(t *testing.T) {
	f := Function{
		Name:   "mixed",
		Params: []Parameter{{Name: "x", Type: I64}, {Name: "f", Type: IEEE64}},
		Result: I64,
		Slots:  []Type{I64, IEEE64},
		Blocks: []Block{{Terminator: Terminator{Op: "return", Value: 0}}},
	}
	plan, err := AllocateRegisters(f, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Locations[0].Class != RegisterGPR || plan.Locations[1].Class != RegisterFP {
		t.Fatalf("classes=%+v", plan.Locations)
	}
	if plan.Spills != 0 {
		t.Fatalf("unexpected spill: %+v", plan)
	}
}

func TestUnusedParameterInterferesWithLiveParameter(t *testing.T) {
	// fn f(a:i64,b:i64)->i64{return a+1;}
	f := Function{
		Name:   "f",
		Params: []Parameter{{Name: "a", Type: I64}, {Name: "b", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "const", Dest: 2, Constant: &Literal{Type: I64, Value: "1"}},
				{Op: "add", Dest: 3, Args: []int{0, 2}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 3},
		}},
	}
	graph, err := InterferenceGraph(f)
	if err != nil {
		t.Fatal(err)
	}
	if !graph[0][1] {
		t.Fatal("parameter a (slot 0) and unused parameter b (slot 1) must interfere")
	}
	plan, err := AllocateRegisters(f, 4, 0)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Locations[0].Register == plan.Locations[1].Register {
		t.Fatalf("parameters a and b cannot share register: a=%d b=%d plan=%+v",
			plan.Locations[0].Register, plan.Locations[1].Register, plan.Locations)
	}
}
