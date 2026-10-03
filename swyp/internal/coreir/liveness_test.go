package coreir

import (
	"context"
	"testing"
)

func TestAnalyzeLivenessAcrossBranchJoin(t *testing.T) {
	f := Function{
		Name:   "choose",
		Params: []Parameter{{Name: "cond", Type: Bool}, {Name: "x", Type: I64}},
		Result: I64,
		Slots:  []Type{Bool, I64, I64, I64},
		Blocks: []Block{
			{Terminator: Terminator{Op: "branch", Value: 0, Targets: []int{1, 2}}},
			{
				Instructions: []Instruction{{Op: "move", Dest: 2, Args: []int{1}}},
				Terminator:   Terminator{Op: "jump", Value: -1, Targets: []int{3}},
			},
			{
				Instructions: []Instruction{{Op: "move", Dest: 2, Args: []int{1}}},
				Terminator:   Terminator{Op: "jump", Value: -1, Targets: []int{3}},
			},
			{
				Instructions: []Instruction{{Op: "move", Dest: 3, Args: []int{2}}},
				Terminator:   Terminator{Op: "return", Value: 3},
			},
		},
	}
	live, err := AnalyzeLiveness(f)
	if err != nil {
		t.Fatal(err)
	}
	if !live.Blocks[0].LiveOut[1] {
		t.Fatal("x must be live out of entry")
	}
	if !live.Blocks[1].LiveOut[2] || !live.Blocks[2].LiveOut[2] {
		t.Fatal("joined value must be live out of both predecessor blocks")
	}
	if live.Blocks[3].LiveOut[3] {
		t.Fatal("returned value is consumed in the block and not live out")
	}
}

func TestOptimizeCompactsDeadSlotHoles(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name:   "calc",
		Params: []Parameter{{Name: "x", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64, I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "const", Dest: 1, Constant: &Literal{Type: I64, Value: "1"}},
				{Op: "add", Dest: 4, Args: []int{0, 1}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 4},
		}},
	}}}
	got, report, err := Optimize(m)
	if err != nil {
		t.Fatal(err)
	}
	f := got.Functions[0]
	if len(f.Slots) != 3 {
		t.Fatalf("slots=%d want 3: %+v", len(f.Slots), f.Slots)
	}
	if report.CompactedSlots != 2 {
		t.Fatalf("report=%+v", report)
	}
	if f.Blocks[0].Instructions[1].Dest != 2 || f.Blocks[0].Terminator.Value != 2 {
		t.Fatalf("slot remap failed: %+v", f.Blocks[0])
	}
	before, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	after, err := Prepare(got)
	if err != nil {
		t.Fatal(err)
	}
	args := []Value{Int(41)}
	br, err := before.RunFast(context.Background(), "calc", args, 100)
	if err != nil {
		t.Fatal(err)
	}
	ar, err := after.RunFast(context.Background(), "calc", args, 100)
	if err != nil {
		t.Fatal(err)
	}
	if br.Value.Literal() != ar.Value.Literal() {
		t.Fatalf("before=%+v after=%+v", br.Value, ar.Value)
	}
}
