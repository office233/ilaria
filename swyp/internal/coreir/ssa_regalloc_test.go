package coreir

import (
	"sort"
	"testing"
)

func TestSSARegisterAllocationReusesRepeatedSlotVersions(t *testing.T) {
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
	plan, err := AllocateSSARegisters(ssa, 2, 0)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Spills != 0 {
		t.Fatalf("unexpected spill: %+v", plan)
	}
	if plan.GPRUsed > 2 {
		t.Fatalf("gpr used=%d", plan.GPRUsed)
	}
}

func TestSSALivenessPhiUsesLiveOnIncomingEdges(t *testing.T) {
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
	live, err := AnalyzeSSALiveness(ssa)
	if err != nil {
		t.Fatal(err)
	}
	phi := ssa.Blocks[3].Phis[0]
	for _, input := range phi.Inputs {
		if !live.Blocks[input.Predecessor].LiveOut[input.Value] {
			t.Fatalf("phi input %d not live out of predecessor %d", input.Value, input.Predecessor)
		}
	}
}

func TestSSARegisterAllocationSpillsUnderPressure(t *testing.T) {
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
	ssa, err := BuildSSA(f)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := AllocateSSARegisters(ssa, 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Spills == 0 {
		t.Fatalf("expected spill: %+v", plan)
	}
}

func TestSSAInterferenceSparseMatchesDenseView(t *testing.T) {
	f := Function{
		Name:   "mix",
		Params: []Parameter{{Name: "a", Type: I64}, {Name: "b", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: true},
				{Op: "mul", Dest: 3, Args: []int{2, 1}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 3},
		}},
	}
	ssa, err := BuildSSA(f)
	if err != nil {
		t.Fatal(err)
	}
	adj, err := ssaInterferenceAdjacency(ssa)
	if err != nil {
		t.Fatal(err)
	}
	dense, err := SSAInterferenceGraph(ssa)
	if err != nil {
		t.Fatal(err)
	}
	for i := range dense {
		for j := range dense[i] {
			index := sort.SearchInts(adj[i], j)
			sparse := index < len(adj[i]) && adj[i][index] == j
			if dense[i][j] != sparse {
				t.Fatalf("edge %d-%d dense=%v sparse=%v", i, j, dense[i][j], sparse)
			}
		}
	}
}

func benchmarkLargeSparseSSA(b testing.TB) SSAFunction {
	b.Helper()
	const operations = 1024
	slots := make([]Type, operations+2)
	for i := range slots {
		slots[i] = I64
	}
	one := Literal{Type: I64, Value: "1"}
	instructions := make([]Instruction, 0, operations+1)
	instructions = append(instructions, Instruction{Op: "const", Dest: 1, Constant: &one})
	for i := 0; i < operations; i++ {
		source := 0
		if i > 0 {
			source = i + 1
		}
		instructions = append(instructions, Instruction{
			Op:      "add",
			Dest:    i + 2,
			Args:    []int{source, 1},
			MayTrap: true,
		})
	}
	f := Function{
		Name:   "chain",
		Params: []Parameter{{Name: "x", Type: I64}},
		Result: I64,
		Slots:  slots,
		Blocks: []Block{{
			Instructions: instructions,
			Terminator:   Terminator{Op: "return", Value: operations + 1},
		}},
	}
	ssa, err := BuildSSA(f)
	if err != nil {
		b.Fatal(err)
	}
	return ssa
}

func BenchmarkAllocateSSARegistersLargeSparseChain(b *testing.B) {
	ssa := benchmarkLargeSparseSSA(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := AllocateSSARegisters(ssa, X64LeafRegisterCount(), 0); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkSSAInterferenceGraphDenseViewLargeSparseChain(b *testing.B) {
	ssa := benchmarkLargeSparseSSA(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := SSAInterferenceGraph(ssa); err != nil {
			b.Fatal(err)
		}
	}
}
