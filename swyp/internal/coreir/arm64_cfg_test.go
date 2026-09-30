package coreir

import (
	"bytes"
	"strings"
	"testing"
)

func TestEmitARM64SSABranchAndPhiCopies(t *testing.T) {
	f := Function{
		Name:   "choose",
		Params: []Parameter{{Name: "cond", Type: Bool}, {Name: "x", Type: I64}, {Name: "y", Type: I64}},
		Result: I64,
		Slots:  []Type{Bool, I64, I64, I64},
		Blocks: []Block{
			{Terminator: Terminator{Op: "branch", Value: 0, Targets: []int{1, 2}}},
			{
				Instructions: []Instruction{{Op: "move", Dest: 3, Args: []int{1}}},
				Terminator:   Terminator{Op: "jump", Value: -1, Targets: []int{3}},
			},
			{
				Instructions: []Instruction{{Op: "move", Dest: 3, Args: []int{2}}},
				Terminator:   Terminator{Op: "jump", Value: -1, Targets: []int{3}},
			},
			{Terminator: Terminator{Op: "return", Value: 3}},
		},
	}
	ssa, err := BuildSSA(f)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := AllocateSSARegisters(ssa, ARM64LeafRegisterCount(), 0)
	if err != nil {
		t.Fatal(err)
	}
	asm, err := EmitARM64SSA(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range [][]byte{
		[]byte(".Lswyp_arm64_b0:"),
		[]byte(".Lswyp_arm64_b1:"),
		[]byte(".Lswyp_arm64_b2:"),
		[]byte(".Lswyp_arm64_b3:"),
		[]byte("cbz "),
		[]byte(".Lswyp_arm64_edge_b0_false"),
	} {
		if !bytes.Contains(asm, want) {
			t.Fatalf("assembly missing %q:\n%s", want, asm)
		}
	}
	if !bytes.Contains(asm, []byte("str ")) || !bytes.Contains(asm, []byte("ldr ")) {
		t.Fatalf("expected phi edge copies:\n%s", asm)
	}
}

func TestEmitARM64SSASpillsGPRValues(t *testing.T) {
	f := Function{
		Name:   "pressure",
		Params: []Parameter{{Name: "a", Type: I64}, {Name: "b", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64, I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: true},
				{Op: "add", Dest: 3, Args: []int{0, 2}, MayTrap: true},
				{Op: "add", Dest: 4, Args: []int{1, 3}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 4},
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
		t.Fatalf("expected spills: %+v", plan)
	}
	asm, err := EmitARM64SSA(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range [][]byte{
		[]byte("mov x29, sp"),
		[]byte("[x29, #"),
		[]byte("ldr x9, [x29, #"),
		[]byte("str x11, [x29, #"),
	} {
		if !bytes.Contains(asm, want) {
			t.Fatalf("assembly missing %q:\n%s", want, asm)
		}
	}
}

func TestEmitARM64SSAModuleNamespacesLocalLabels(t *testing.T) {
	makeFunction := func(name string) (SSAFunction, SSARegisterPlan) {
		f := Function{
			Name:   name,
			Params: []Parameter{{Name: "x", Type: I64}},
			Result: I64,
			Slots:  []Type{I64},
			Blocks: []Block{{Terminator: Terminator{Op: "return", Value: 0}}},
		}
		ssa, err := BuildSSA(f)
		if err != nil {
			t.Fatal(err)
		}
		plan, err := AllocateSSARegisters(ssa, ARM64LeafRegisterCount(), 0)
		if err != nil {
			t.Fatal(err)
		}
		return ssa, plan
	}
	a, ap := makeFunction("alpha")
	b, bp := makeFunction("beta")
	asm, err := EmitARM64SSAModule(
		[]SSAFunction{a, b},
		map[string]SSARegisterPlan{"alpha": ap, "beta": bp},
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range [][]byte{
		[]byte(".Lswyp_arm64_alpha_b0:"),
		[]byte(".Lswyp_arm64_beta_b0:"),
		[]byte("swyp_core_alpha:"),
		[]byte("swyp_core_beta:"),
	} {
		if !bytes.Contains(asm, want) {
			t.Fatalf("assembly missing %q:\n%s", want, asm)
		}
	}
	if bytes.Contains(asm, []byte("\n.Lswyp_arm64_b0:")) {
		t.Fatalf("unnamespaced ARM64 label remained:\n%s", asm)
	}
}

func TestEmitARM64SSAIEEE64Phi(t *testing.T) {
	f := Function{
		Name:   "choosefp",
		Params: []Parameter{{Name: "cond", Type: Bool}, {Name: "x", Type: IEEE64}, {Name: "y", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{Bool, IEEE64, IEEE64, IEEE64},
		Blocks: []Block{
			{Terminator: Terminator{Op: "branch", Value: 0, Targets: []int{1, 2}}},
			{Instructions: []Instruction{{Op: "move", Dest: 3, Args: []int{1}}}, Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{3}}},
			{Instructions: []Instruction{{Op: "move", Dest: 3, Args: []int{2}}}, Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{3}}},
			{Terminator: Terminator{Op: "return", Value: 3}},
		},
	}
	ssa, err := BuildSSA(f)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := AllocateSSARegisters(ssa, ARM64LeafRegisterCount(), ARM64FPRegisterCount())
	if err != nil {
		t.Fatal(err)
	}
	asm, err := EmitARM64SSA(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	text := string(asm)
	for _, want := range []string{"cbz ", "str d", "ldr d", "fmov d0, "} {
		if !strings.Contains(text, want) {
			t.Fatalf("assembly missing %q:\n%s", want, text)
		}
	}
}

func TestEmitARM64SSAIEEE64AllSpilled(t *testing.T) {
	f := Function{
		Name:   "fp_spill",
		Params: []Parameter{{Name: "x", Type: IEEE64}, {Name: "y", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{IEEE64, IEEE64, IEEE64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "mul", Dest: 2, Args: []int{0, 1}}},
			Terminator:   Terminator{Op: "return", Value: 2},
		}},
	}
	ssa, err := BuildSSA(f)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := AllocateSSARegisters(ssa, ARM64LeafRegisterCount(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Spills < 3 {
		t.Fatalf("expected FP spills: %+v", plan)
	}
	asm, err := EmitARM64SSA(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	text := string(asm)
	for _, want := range []string{
		"sub sp, sp, #32",
		"str d0, [x29, #0]",
		"str d1, [x29, #8]",
		"ldr d4, [x29, #0]",
		"ldr d5, [x29, #8]",
		"fmul d6, d4, d5",
		"str d6, [x29, #16]",
		"ldr d0, [x29, #16]",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("assembly missing %q:\n%s", want, text)
		}
	}
}

func TestEmitARM64SSAIEEE64PhiSpills(t *testing.T) {
	f := Function{
		Name:   "choose_fp_spill",
		Params: []Parameter{{Name: "cond", Type: Bool}, {Name: "x", Type: IEEE64}, {Name: "y", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{Bool, IEEE64, IEEE64, IEEE64},
		Blocks: []Block{
			{Terminator: Terminator{Op: "branch", Value: 0, Targets: []int{1, 2}}},
			{Instructions: []Instruction{{Op: "move", Dest: 3, Args: []int{1}}}, Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{3}}},
			{Instructions: []Instruction{{Op: "move", Dest: 3, Args: []int{2}}}, Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{3}}},
			{Terminator: Terminator{Op: "return", Value: 3}},
		},
	}
	ssa, err := BuildSSA(f)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := AllocateSSARegisters(ssa, ARM64LeafRegisterCount(), 0)
	if err != nil {
		t.Fatal(err)
	}
	asm, err := EmitARM64SSA(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	text := string(asm)
	for _, want := range []string{
		"ldr d6, [x29, #16]",
		"ldr d6, [x29, #24]",
		"str d6, [sp, #-16]!",
		"str d6, [x29, #32]",
		"ldr d0, [x29, #32]",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("assembly missing %q:\n%s", want, text)
		}
	}
}
