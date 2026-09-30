package coreir

import "testing"

func TestBuildSSABranchCreatesPhi(t *testing.T) {
	f := Function{
		Name:   "choose",
		Params: []Parameter{{Name: "cond", Type: Bool}, {Name: "x", Type: I64}},
		Result: I64,
		Slots:  []Type{Bool, I64, I64},
		Blocks: []Block{
			{Terminator: Terminator{Op: "branch", Value: 0, Targets: []int{1, 2}}},
			{
				Instructions: []Instruction{{Op: "const", Dest: 2, Constant: &Literal{Type: I64, Value: "7"}}},
				Terminator:   Terminator{Op: "jump", Value: -1, Targets: []int{3}},
			},
			{
				Instructions: []Instruction{{Op: "move", Dest: 2, Args: []int{1}}},
				Terminator:   Terminator{Op: "jump", Value: -1, Targets: []int{3}},
			},
			{Terminator: Terminator{Op: "return", Value: 2}},
		},
	}
	ssa, err := BuildSSA(f)
	if err != nil {
		t.Fatal(err)
	}
	if len(ssa.Blocks[3].Phis) != 1 {
		t.Fatalf("join phis=%+v", ssa.Blocks[3].Phis)
	}
	phi := ssa.Blocks[3].Phis[0]
	if phi.Slot != 2 || len(phi.Inputs) != 2 || ssa.Blocks[3].Terminator.Value != phi.Dest {
		t.Fatalf("phi=%+v term=%+v", phi, ssa.Blocks[3].Terminator)
	}
}

func TestBuildSSALoopCreatesHeaderPhi(t *testing.T) {
	f := Function{
		Name:   "count",
		Params: []Parameter{{Name: "n", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64, I64, Bool},
		Blocks: []Block{
			{
				Instructions: []Instruction{{Op: "const", Dest: 1, Constant: &Literal{Type: I64, Value: "0"}}},
				Terminator:   Terminator{Op: "jump", Value: -1, Targets: []int{1}},
			},
			{
				Instructions: []Instruction{{Op: "lt", Dest: 3, Args: []int{1, 0}}},
				Terminator:   Terminator{Op: "branch", Value: 3, Targets: []int{2, 3}},
			},
			{
				Instructions: []Instruction{
					{Op: "const", Dest: 2, Constant: &Literal{Type: I64, Value: "1"}},
					{Op: "add", Dest: 1, Args: []int{1, 2}, MayTrap: true},
				},
				Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{1}},
			},
			{Terminator: Terminator{Op: "return", Value: 1}},
		},
	}
	ssa, err := BuildSSA(f)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, phi := range ssa.Blocks[1].Phis {
		if phi.Slot == 1 {
			found = true
			if len(phi.Inputs) != 2 {
				t.Fatalf("loop phi inputs=%+v", phi.Inputs)
			}
		}
	}
	if !found {
		t.Fatalf("header phis=%+v", ssa.Blocks[1].Phis)
	}
}

func TestBuildSSAVersionsRepeatedWrites(t *testing.T) {
	f := Function{
		Name:   "twice",
		Params: []Parameter{{Name: "x", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "const", Dest: 1, Constant: &Literal{Type: I64, Value: "1"}},
				{Op: "add", Dest: 0, Args: []int{0, 1}, MayTrap: true},
				{Op: "add", Dest: 0, Args: []int{0, 1}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 0},
		}},
	}
	ssa, err := BuildSSA(f)
	if err != nil {
		t.Fatal(err)
	}
	ins := ssa.Blocks[0].Instructions
	if ins[1].Dest == ins[2].Dest || ins[2].Args[0] != ins[1].Dest {
		t.Fatalf("versions=%+v", ins)
	}
	if ssa.Blocks[0].Terminator.Value != ins[2].Dest {
		t.Fatalf("return=%d last=%d", ssa.Blocks[0].Terminator.Value, ins[2].Dest)
	}
}
