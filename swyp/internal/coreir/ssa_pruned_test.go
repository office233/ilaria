package coreir

import (
	"context"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// The optional stage bypasses the short-circuit merge. Its temporary is read
// at block 4 but dead at the loop header, including the initial entry edge.
// Placing the right definition after the merge also exercises version changes
// during fixed-point iteration instead of only a forward branch join.
func prunedSSALoopFixture() Module {
	return Module{Version: Version, Functions: []Function{{
		Name: "entry",
		Params: []Parameter{
			{Name: "stage", Type: Bool}, {Name: "left", Type: Bool},
			{Name: "right", Type: Bool}, {Name: "n", Type: U64},
		},
		Result: U64,
		Slots:  []Type{Bool, Bool, Bool, U64, U64, U64, Bool, Bool},
		Blocks: []Block{
			{Instructions: []Instruction{snapshotConst(4, 0), snapshotConst(5, 1)},
				Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{1}}},
			{Instructions: []Instruction{{Op: "lt", Dest: 6, Args: []int{4, 3}}},
				Terminator: Terminator{Op: "branch", Value: 6, Targets: []int{2, 8}}},
			{Terminator: Terminator{Op: "branch", Value: 0, Targets: []int{9, 7}}},
			{Instructions: []Instruction{{Op: "move", Dest: 7, Args: []int{1}}},
				Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{4}}},
			{Terminator: Terminator{Op: "branch", Value: 7, Targets: []int{6, 7}}},
			{Instructions: []Instruction{{Op: "move", Dest: 7, Args: []int{2}}},
				Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{4}}},
			{Instructions: []Instruction{
				{Op: "add", Dest: 4, Args: []int{4, 5}},
				{Op: "add", Dest: 4, Args: []int{4, 5}},
			}, Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{1}}},
			{Instructions: []Instruction{{Op: "add", Dest: 4, Args: []int{4, 5}}},
				Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{1}}},
			{Terminator: Terminator{Op: "return", Value: 4}},
			{Terminator: Terminator{Op: "branch", Value: 1, Targets: []int{3, 5}}},
		},
	}}}
}

func TestBuildSSAPrunesOptionalLoopTemporary(t *testing.T) {
	m := prunedSSALoopFixture()
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	live, err := AnalyzeLiveness(m.Functions[0])
	if err != nil {
		t.Fatal(err)
	}
	if live.Blocks[1].LiveIn[7] || !live.Blocks[4].LiveIn[7] {
		t.Fatal("fixture must have a dead header temporary and a live short-circuit join")
	}
	for _, optimize := range []bool{false, true} {
		t.Run("optimized="+strconv.FormatBool(optimize), func(t *testing.T) {
			module := cloneModule(m)
			if optimize {
				module, _, err = Optimize(module)
				if err != nil {
					t.Fatal(err)
				}
			}
			original := cloneModule(module)
			ssa, err := BuildSSA(module.Functions[0])
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(module, original) {
				t.Fatal("SSA construction mutated its input")
			}
			live, err := AnalyzeLiveness(module.Functions[0])
			if err != nil {
				t.Fatal(err)
			}
			count := 0
			for bi, block := range ssa.Blocks {
				for _, phi := range block.Phis {
					count++
					if !live.Blocks[bi].LiveIn[phi.Slot] {
						t.Fatalf("block %d has a phi for dead slot %d", bi, phi.Slot)
					}
					for _, input := range phi.Inputs {
						if input.Value == NoSSAValue {
							t.Fatalf("block %d has an undefined live phi input", bi)
						}
					}
				}
			}
			if count < 2 {
				t.Fatalf("lost live loop-counter or expression phis: %d", count)
			}
			if _, err := AnalyzeSSALiveness(ssa); err != nil {
				t.Fatal(err)
			}
			for _, registers := range []int{1, X64LeafRegisterCount()} {
				if _, err := AllocateSSARegisters(ssa, registers, 0); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestBuildSSARejectsLiveUndefinedPaths(t *testing.T) {
	for _, tc := range []struct {
		name string
		f    Function
	}{
		{"one-defined-predecessor", Function{
			Name: "bad", Params: []Parameter{{Name: "choice", Type: Bool}}, Result: U64, Slots: []Type{Bool, U64},
			Blocks: []Block{
				{Terminator: Terminator{Op: "branch", Value: 0, Targets: []int{1, 2}}},
				{Instructions: []Instruction{snapshotConst(1, 7)}, Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{3}}},
				{Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{3}}},
				{Terminator: Terminator{Op: "return", Value: 1}},
			},
		}},
		{"use-before-local-definition", Function{
			Name: "bad", Result: U64, Slots: []Type{U64, U64},
			Blocks: []Block{{Instructions: []Instruction{
				{Op: "move", Dest: 1, Args: []int{0}}, snapshotConst(0, 7),
			}, Terminator: Terminator{Op: "return", Value: 1}}},
		}},
		{"loop-entry-undefined", Function{
			Name: "bad", Params: []Parameter{{Name: "again", Type: Bool}}, Result: U64, Slots: []Type{Bool, U64},
			Blocks: []Block{
				{Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{1}}},
				{Terminator: Terminator{Op: "branch", Value: 0, Targets: []int{2, 3}}},
				{Instructions: []Instruction{snapshotConst(1, 7)}, Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{1}}},
				{Terminator: Terminator{Op: "return", Value: 1}},
			},
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := (Module{Version: Version, Functions: []Function{tc.f}}).Validate(); err == nil {
				t.Fatal("fixture must be genuinely uninitialized")
			}
			_, err := BuildSSA(tc.f)
			if err == nil || (!strings.Contains(err.Error(), "undefined") && !strings.Contains(err.Error(), "uninitialized")) {
				t.Fatalf("live undefined read accepted: %v", err)
			}
		})
	}
}

func TestBuildSSASuppliedCompilerRepro(t *testing.T) {
	path := os.Getenv("SWYP_SSA_REPRO")
	if path == "" {
		t.Skip("SWYP_SSA_REPRO public Core fixture not supplied")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	m, err := Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range m.Functions {
		ssa, err := BuildSSA(f)
		if err != nil {
			t.Fatalf("%s: %v", f.Name, err)
		}
		live, err := AnalyzeLiveness(f)
		if err != nil {
			t.Fatal(err)
		}
		for bi, block := range ssa.Blocks {
			for _, phi := range block.Phis {
				if !live.Blocks[bi].LiveIn[phi.Slot] {
					t.Fatalf("%s block %d has a dead phi for slot %d", f.Name, bi, phi.Slot)
				}
			}
		}
		if _, err := AllocateSSARegisters(ssa, X64LeafRegisterCount(), X64FPRegisterCount()); err != nil {
			t.Fatalf("%s x64 allocation: %v", f.Name, err)
		}
		if _, err := AllocateSSARegisters(ssa, ARM64MachineRegisterCount(), ARM64MachineFPRegisterCount()); err != nil {
			t.Fatalf("%s arm64 allocation: %v", f.Name, err)
		}
	}
}

func TestBuildSSAPruningKeepsUnreachableReadsInert(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name: "entry", Result: U64, Slots: []Type{U64, U64},
		Blocks: []Block{
			{Instructions: []Instruction{snapshotConst(0, 7)}, Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{1}}},
			{Terminator: Terminator{Op: "return", Value: 0}},
			{Terminator: Terminator{Op: "return", Value: 1}},
		},
	}}}
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	ssa, err := BuildSSA(m.Functions[0])
	if err != nil {
		t.Fatal(err)
	}
	if ssa.Blocks[2].Reachable || len(ssa.Blocks[2].Instructions) != 0 || len(ssa.Blocks[2].Phis) != 0 {
		t.Fatal("unreachable undefined read was promoted into SSA")
	}
}

func TestPrunedSSALoopExecutorAndNativeParity(t *testing.T) {
	m := prunedSSALoopFixture()
	cases := []struct {
		stage, left, right bool
		n, want            uint64
	}{
		{false, false, false, 7, 7},
		{false, true, true, 7, 7},
		{true, false, false, 7, 7},
		{true, true, false, 7, 8},
		{true, false, true, 7, 8},
		{true, true, true, 0, 0},
	}
	e, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		for name, run := range snapshotRunners(e) {
			result, err := run(context.Background(), "entry", []Value{
				Boolean(tc.stage), Boolean(tc.left), Boolean(tc.right), Uint(tc.n),
			}, 1000)
			if err != nil || result.Value.u != tc.want {
				t.Fatalf("%s case=%+v result=%v err=%v", name, tc, result.Value, err)
			}
		}
	}
	for _, optimize := range []bool{false, true} {
		module := cloneModule(m)
		if optimize {
			module, _, err = Optimize(module)
			if err != nil {
				t.Fatal(err)
			}
		}
		for _, target := range snapshotNativeTargets(t) {
			for _, registers := range []int{0, 1} {
				t.Run(target+"-registers"+strconv.Itoa(registers)+"-optimized"+strconv.FormatBool(optimize), func(t *testing.T) {
					image := snapshotProcessImage(t, module, target, target != "pe", 8, registers)
					for _, tc := range cases {
						runSnapshotProcess(t, image, target, []string{
							strconv.FormatBool(tc.stage), strconv.FormatBool(tc.left), strconv.FormatBool(tc.right), strconv.FormatUint(tc.n, 10),
						}, nil, int(tc.want), nil)
					}
				})
			}
		}
	}
}
