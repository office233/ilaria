package coreir

import (
	"context"
	"testing"
)

func TestOptimizeFoldsConstantsAndRemovesDeadValues(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name:   "calc",
		Result: I64,
		Slots:  []Type{I64, I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "const", Dest: 0, Constant: &Literal{Type: I64, Value: "2"}},
				{Op: "const", Dest: 1, Constant: &Literal{Type: I64, Value: "3"}},
				{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: true},
				{Op: "const", Dest: 3, Constant: &Literal{Type: I64, Value: "99"}},
			},
			Terminator: Terminator{Op: "return", Value: 2},
		}},
	}}}
	got, report, err := Optimize(m)
	if err != nil {
		t.Fatal(err)
	}
	ins := got.Functions[0].Blocks[0].Instructions
	if len(ins) != 1 || ins[0].Op != "const" || ins[0].Dest != 0 || ins[0].Constant.Value != "5" {
		t.Fatalf("optimized instructions=%+v", ins)
	}
	if report.FoldedConstants != 1 || report.DeadInstructions != 3 || report.CompactedSlots != 3 {
		t.Fatalf("report=%+v", report)
	}

	before, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	after, err := Prepare(got)
	if err != nil {
		t.Fatal(err)
	}
	br, err := before.Run(context.Background(), "calc", nil, 100)
	if err != nil {
		t.Fatal(err)
	}
	ar, err := after.Run(context.Background(), "calc", nil, 100)
	if err != nil {
		t.Fatal(err)
	}
	if br.Value.Literal() != ar.Value.Literal() {
		t.Fatalf("before=%v after=%v", br.Value.Literal(), ar.Value.Literal())
	}
}

func TestOptimizeConstantBranchRemovesUnreachableBlock(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name: "choose", Result: I64,
		Slots: []Type{Bool, I64, I64},
		Blocks: []Block{
			{
				Instructions: []Instruction{{Op: "const", Dest: 0, Constant: &Literal{Type: Bool, Value: "true"}}},
				Terminator:   Terminator{Op: "branch", Value: 0, Targets: []int{1, 2}},
			},
			{
				Instructions: []Instruction{{Op: "const", Dest: 1, Constant: &Literal{Type: I64, Value: "7"}}},
				Terminator:   Terminator{Op: "return", Value: 1},
			},
			{
				Instructions: []Instruction{{Op: "const", Dest: 2, Constant: &Literal{Type: I64, Value: "9"}}},
				Terminator:   Terminator{Op: "return", Value: 2},
			},
		},
	}}}
	got, report, err := Optimize(m)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Functions[0].Blocks) != 2 {
		t.Fatalf("blocks=%d report=%+v", len(got.Functions[0].Blocks), report)
	}
	entry := got.Functions[0].Blocks[0]
	if entry.Terminator.Op != "jump" || len(entry.Terminator.Targets) != 1 || entry.Terminator.Targets[0] != 1 {
		t.Fatalf("entry terminator=%+v", entry.Terminator)
	}
	if report.SimplifiedBranches != 1 || report.RemovedBlocks != 1 {
		t.Fatalf("report=%+v", report)
	}

	exe, err := Prepare(got)
	if err != nil {
		t.Fatal(err)
	}
	result, err := exe.Run(context.Background(), "choose", nil, 100)
	if err != nil {
		t.Fatal(err)
	}
	if result.Value.Literal().Value != "7" {
		t.Fatalf("result=%v", result.Value.Literal())
	}
}

func TestOptimizePreservesConstantTrap(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name: "overflow", Result: I64,
		Slots: []Type{I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "const", Dest: 0, Constant: &Literal{Type: I64, Value: "9223372036854775807"}},
				{Op: "const", Dest: 1, Constant: &Literal{Type: I64, Value: "1"}},
				{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 2},
		}},
	}}}
	got, report, err := Optimize(m)
	if err != nil {
		t.Fatal(err)
	}
	ins := got.Functions[0].Blocks[0].Instructions
	foundAdd := false
	for _, op := range ins {
		if op.Op == "add" {
			foundAdd = true
		}
	}
	if !foundAdd {
		t.Fatalf("trapping add was folded: %+v report=%+v", ins, report)
	}
	exe, err := Prepare(got)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := exe.Run(context.Background(), "overflow", nil, 100); errorCode(err) != "overflow" {
		t.Fatalf("err=%v", err)
	}
}

func TestOptimizeInlinesSmallPureHelper(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{
		{
			Name:   "inc",
			Params: []Parameter{{Name: "x", Type: I64}},
			Result: I64,
			Slots:  []Type{I64, I64, I64},
			Blocks: []Block{{
				Instructions: []Instruction{
					{Op: "const", Dest: 1, Constant: &Literal{Type: I64, Value: "1"}, MayTrap: false},
					{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: true},
				},
				Terminator: Terminator{Op: "return", Value: 2},
			}},
		},
		{
			Name:   "answer",
			Params: []Parameter{{Name: "x", Type: I64}},
			Result: I64,
			Slots:  []Type{I64, I64, I64},
			Blocks: []Block{{
				Instructions: []Instruction{
					{Op: "call", Dest: 1, Args: []int{0}, Callee: "inc", MayTrap: true},
					{Op: "call", Dest: 2, Args: []int{0}, Callee: "inc", MayTrap: true},
					{Op: "add", Dest: 1, Args: []int{1, 2}, MayTrap: true},
				},
				Terminator: Terminator{Op: "return", Value: 1},
			}},
		},
	}}
	before, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	got, report, err := Optimize(m)
	if err != nil {
		t.Fatal(err)
	}
	if report.InlinedCalls != 2 {
		t.Fatalf("inlined=%d report=%+v", report.InlinedCalls, report)
	}
	var answer Function
	for _, f := range got.Functions {
		if f.Name == "answer" {
			answer = f
		}
	}
	for _, ins := range answer.Blocks[0].Instructions {
		if ins.Op == "call" {
			t.Fatalf("call remained after inlining: %+v", answer.Blocks[0].Instructions)
		}
	}
	after, err := Prepare(got)
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []int64{-10, 0, 20, 99} {
		br, err := before.Run(context.Background(), "answer", []Value{Int(input)}, 100)
		if err != nil {
			t.Fatal(err)
		}
		ar, err := after.Run(context.Background(), "answer", []Value{Int(input)}, 100)
		if err != nil {
			t.Fatal(err)
		}
		if br.Value.Literal() != ar.Value.Literal() {
			t.Fatalf("input=%d before=%v after=%v", input, br.Value.Literal(), ar.Value.Literal())
		}
	}
}

func TestOptimizeDoesNotInlineEffectfulHelper(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{
		{
			Name:                 "read",
			Params:               []Parameter{{Name: "x", Type: I64}},
			Result:               I64,
			EffectVersion:        EffectVersion,
			Effects:              []string{"fs.read"},
			RequiredCapabilities: []CapabilityRequirement{{Effect: "fs.read", Name: "workspace_read"}},
			Slots:                []Type{I64},
			Blocks:               []Block{{Terminator: Terminator{Op: "return", Value: 0}}},
		},
		{
			Name:                 "caller",
			Params:               []Parameter{{Name: "x", Type: I64}},
			Result:               I64,
			EffectVersion:        EffectVersion,
			Effects:              []string{"fs.read"},
			RequiredCapabilities: []CapabilityRequirement{{Effect: "fs.read", Name: "workspace_read"}},
			Slots:                []Type{I64, I64},
			Blocks: []Block{{
				Instructions: []Instruction{{Op: "call", Dest: 1, Args: []int{0}, Callee: "read", MayTrap: true}},
				Terminator:   Terminator{Op: "return", Value: 1},
			}},
		},
	}}
	got, report, err := Optimize(m)
	if err != nil {
		t.Fatal(err)
	}
	if report.InlinedCalls != 0 || got.Functions[1].Blocks[0].Instructions[0].Op != "call" {
		t.Fatalf("effectful call was inlined: report=%+v ins=%+v", report, got.Functions[1].Blocks[0].Instructions)
	}
}

func TestOptimizeInliningPreservesCallByValueParameters(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{
		{
			Name:   "bump",
			Params: []Parameter{{Name: "x", Type: I64}},
			Result: I64,
			Slots:  []Type{I64, I64},
			Blocks: []Block{{
				Instructions: []Instruction{
					{Op: "const", Dest: 1, Constant: &Literal{Type: I64, Value: "1"}, MayTrap: false},
					{Op: "add", Dest: 0, Args: []int{0, 1}, MayTrap: true},
				},
				Terminator: Terminator{Op: "return", Value: 0},
			}},
		},
		{
			Name:   "caller",
			Params: []Parameter{{Name: "x", Type: I64}},
			Result: I64,
			Slots:  []Type{I64, I64, I64},
			Blocks: []Block{{
				Instructions: []Instruction{
					{Op: "call", Dest: 1, Args: []int{0}, Callee: "bump", MayTrap: true},
					{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: true},
				},
				Terminator: Terminator{Op: "return", Value: 2},
			}},
		},
	}}
	before, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	got, report, err := Optimize(m)
	if err != nil {
		t.Fatal(err)
	}
	if report.InlinedCalls != 1 {
		t.Fatalf("inlined=%d report=%+v", report.InlinedCalls, report)
	}
	after, err := Prepare(got)
	if err != nil {
		t.Fatal(err)
	}
	args := []Value{Int(10)}
	br, err := before.Run(context.Background(), "caller", args, 100)
	if err != nil {
		t.Fatal(err)
	}
	ar, err := after.Run(context.Background(), "caller", args, 100)
	if err != nil {
		t.Fatal(err)
	}
	if br.Value.Literal() != ar.Value.Literal() || ar.Value.Literal().Value != "21" {
		t.Fatalf("before=%v after=%v want 21", br.Value.Literal(), ar.Value.Literal())
	}
}

func TestOptimizeIterativelyInlinesHelperChain(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{
		{
			Name:   "leaf",
			Params: []Parameter{{Name: "x", Type: I64}},
			Result: I64,
			Slots:  []Type{I64, I64, I64},
			Blocks: []Block{{
				Instructions: []Instruction{
					{Op: "const", Dest: 1, Constant: &Literal{Type: I64, Value: "1"}},
					{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: true},
				},
				Terminator: Terminator{Op: "return", Value: 2},
			}},
		},
		{
			Name:   "middle",
			Params: []Parameter{{Name: "x", Type: I64}},
			Result: I64,
			Slots:  []Type{I64, I64},
			Blocks: []Block{{
				Instructions: []Instruction{{Op: "call", Dest: 1, Args: []int{0}, Callee: "leaf", MayTrap: true}},
				Terminator:   Terminator{Op: "return", Value: 1},
			}},
		},
		{
			Name:   "top",
			Params: []Parameter{{Name: "x", Type: I64}},
			Result: I64,
			Slots:  []Type{I64, I64},
			Blocks: []Block{{
				Instructions: []Instruction{{Op: "call", Dest: 1, Args: []int{0}, Callee: "middle", MayTrap: true}},
				Terminator:   Terminator{Op: "return", Value: 1},
			}},
		},
	}}
	got, report, err := Optimize(m)
	if err != nil {
		t.Fatal(err)
	}
	if report.InlinedCalls != 2 {
		t.Fatalf("inlined=%d want 2 report=%+v", report.InlinedCalls, report)
	}
	var top Function
	for _, f := range got.Functions {
		if f.Name == "top" {
			top = f
		}
	}
	for _, ins := range top.Blocks[0].Instructions {
		if ins.Op == "call" {
			t.Fatalf("nested call remained after iterative inlining: %+v", top.Blocks[0].Instructions)
		}
	}
	exe, err := Prepare(got)
	if err != nil {
		t.Fatal(err)
	}
	result, err := exe.Run(context.Background(), "top", []Value{Int(41)}, 100)
	if err != nil {
		t.Fatal(err)
	}
	if got := result.Value.Literal().Value; got != "42" {
		t.Fatalf("value=%s want 42", got)
	}
}

func TestOptimizeInlinesSmallPureCFGHelper(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{
		{
			Name:   "choose",
			Params: []Parameter{{Name: "cond", Type: Bool}, {Name: "x", Type: I64}, {Name: "y", Type: I64}},
			Result: I64,
			Slots:  []Type{Bool, I64, I64},
			Blocks: []Block{
				{Terminator: Terminator{Op: "branch", Value: 0, Targets: []int{1, 2}}},
				{Terminator: Terminator{Op: "return", Value: 1}},
				{Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{3}}},
				{Terminator: Terminator{Op: "return", Value: 2}},
			},
		},
		{
			Name:   "answer",
			Params: []Parameter{{Name: "cond", Type: Bool}, {Name: "x", Type: I64}, {Name: "y", Type: I64}},
			Result: I64,
			Slots:  []Type{Bool, I64, I64, I64},
			Blocks: []Block{{
				Instructions: []Instruction{{Op: "call", Dest: 3, Args: []int{0, 1, 2}, Callee: "choose", MayTrap: true}},
				Terminator:   Terminator{Op: "return", Value: 3},
			}},
		},
	}}
	before, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	got, report, err := Optimize(m)
	if err != nil {
		t.Fatal(err)
	}
	if report.InlinedCalls != 1 {
		t.Fatalf("inlined=%d want 1 report=%+v", report.InlinedCalls, report)
	}
	if report.ThreadedJumps == 0 {
		t.Fatalf("expected source-lowering jump threading: report=%+v", report)
	}
	var answer Function
	for _, f := range got.Functions {
		if f.Name == "answer" {
			answer = f
		}
	}
	for _, block := range answer.Blocks {
		for _, ins := range block.Instructions {
			if ins.Op == "call" {
				t.Fatalf("CFG helper call remained after inlining: %+v", answer.Blocks)
			}
		}
	}
	after, err := Prepare(got)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		cond bool
		want int64
	}{
		{true, 7},
		{false, 9},
	} {
		args := []Value{Boolean(tc.cond), Int(7), Int(9)}
		br, err := before.Run(context.Background(), "answer", args, 100)
		if err != nil {
			t.Fatal(err)
		}
		ar, err := after.Run(context.Background(), "answer", args, 100)
		if err != nil {
			t.Fatal(err)
		}
		bv, _ := br.Value.Int64()
		av, _ := ar.Value.Int64()
		if bv != tc.want || av != tc.want {
			t.Fatalf("cond=%v before=%d after=%d want=%d", tc.cond, bv, av, tc.want)
		}
	}
}

func TestInliningRespectsGlobalInstructionBudget(t *testing.T) {
	// Keep the input just below MaxInstructions, but leave less room than the
	// small helper needs when expanded into the caller.
	fillerCount := MaxInstructions - 8
	fillerInstructions := make([]Instruction, fillerCount)
	for i := range fillerInstructions {
		fillerInstructions[i] = Instruction{
			Op:       "const",
			Dest:     0,
			Constant: &Literal{Type: I64, Value: "1"},
		}
	}
	m := Module{Version: Version, Functions: []Function{
		{
			Name:   "filler",
			Result: I64,
			Slots:  []Type{I64},
			Blocks: []Block{{
				Instructions: fillerInstructions,
				Terminator:   Terminator{Op: "return", Value: 0},
			}},
		},
		{
			Name:   "inc",
			Params: []Parameter{{Name: "x", Type: I64}},
			Result: I64,
			Slots:  []Type{I64, I64, I64},
			Blocks: []Block{{
				Instructions: []Instruction{
					{Op: "const", Dest: 1, Constant: &Literal{Type: I64, Value: "1"}},
					{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: true},
				},
				Terminator: Terminator{Op: "return", Value: 2},
			}},
		},
		{
			Name:   "caller",
			Params: []Parameter{{Name: "x", Type: I64}},
			Result: I64,
			Slots:  []Type{I64, I64},
			Blocks: []Block{{
				Instructions: []Instruction{{Op: "call", Dest: 1, Args: []int{0}, Callee: "inc", MayTrap: true}},
				Terminator:   Terminator{Op: "return", Value: 1},
			}},
		},
	}}
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	report := OptimizationReport{}
	inlineSmallPureCalls(&m, &report)
	if report.InlinedCalls != 0 {
		t.Fatalf("inlined despite global instruction budget: %+v", report)
	}
	if got := m.Functions[2].Blocks[0].Instructions[0].Op; got != "call" {
		t.Fatalf("caller instruction=%q want call", got)
	}
}

func TestOptimizePropagatesLocalCopyAndRemovesMove(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name:   "copy",
		Params: []Parameter{{Name: "x", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "move", Dest: 1, Args: []int{0}},
				{Op: "const", Dest: 2, Constant: &Literal{Type: I64, Value: "1"}},
				{Op: "add", Dest: 3, Args: []int{1, 2}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 3},
		}},
	}}}
	got, report, err := Optimize(m)
	if err != nil {
		t.Fatal(err)
	}
	if report.PropagatedCopies == 0 {
		t.Fatalf("copy was not propagated: %+v", report)
	}
	for _, ins := range got.Functions[0].Blocks[0].Instructions {
		if ins.Op == "move" {
			t.Fatalf("dead move survived: %+v", got.Functions[0].Blocks[0].Instructions)
		}
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
	br, err := before.RunFast(context.Background(), "copy", args, 100)
	if err != nil {
		t.Fatal(err)
	}
	ar, err := after.RunFast(context.Background(), "copy", args, 100)
	if err != nil {
		t.Fatal(err)
	}
	if br.Value.Literal() != ar.Value.Literal() {
		t.Fatalf("before=%v after=%v", br.Value.Literal(), ar.Value.Literal())
	}
}

func TestOptimizeDoesNotPropagateCopyPastSourceWrite(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name:   "copywrite",
		Params: []Parameter{{Name: "x", Type: I64}, {Name: "y", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "move", Dest: 2, Args: []int{0}},
				{Op: "const", Dest: 0, Constant: &Literal{Type: I64, Value: "7"}},
				{Op: "add", Dest: 3, Args: []int{2, 1}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 3},
		}},
	}}}
	got, _, err := Optimize(m)
	if err != nil {
		t.Fatal(err)
	}
	before, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	after, err := Prepare(got)
	if err != nil {
		t.Fatal(err)
	}
	args := []Value{Int(10), Int(1)}
	br, err := before.RunFast(context.Background(), "copywrite", args, 100)
	if err != nil {
		t.Fatal(err)
	}
	ar, err := after.RunFast(context.Background(), "copywrite", args, 100)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := ar.Value.Int64(); got != 11 {
		t.Fatalf("optimized result=%d want 11", got)
	}
	if br.Value.Literal() != ar.Value.Literal() {
		t.Fatalf("before=%v after=%v", br.Value.Literal(), ar.Value.Literal())
	}
}
