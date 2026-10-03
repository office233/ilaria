package coreir

import (
	"bytes"
	"strings"
	"testing"
)

func TestEmitX64SSABranchAndPhiCopies(t *testing.T) {
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
	plan, err := AllocateSSARegisters(ssa, X64LeafRegisterCount(), 0)
	if err != nil {
		t.Fatal(err)
	}
	asm, err := EmitX64SSA(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range [][]byte{
		[]byte(".Lswyp_b0:"),
		[]byte(".Lswyp_b1:"),
		[]byte(".Lswyp_b2:"),
		[]byte(".Lswyp_b3:"),
		[]byte("je .Lswyp_edge_b0_false"),
		[]byte("jmp .Lswyp_b3"),
	} {
		if !bytes.Contains(asm, want) {
			t.Fatalf("assembly missing %q:\n%s", want, asm)
		}
	}
	if !bytes.Contains(asm, []byte("push ")) || !bytes.Contains(asm, []byte("pop ")) {
		t.Fatalf("expected phi edge copies in assembly:\n%s", asm)
	}
}

func TestEmitX64SSAModuleNamespacesLocalLabels(t *testing.T) {
	makeFunction := func(name string) (SSAFunction, SSARegisterPlan) {
		f := Function{
			Name:   name,
			Params: []Parameter{{Name: "x", Type: I64}},
			Result: I64,
			Slots:  []Type{I64, I64},
			Blocks: []Block{{
				Instructions: []Instruction{{
					Op:       "const",
					Dest:     1,
					Constant: &Literal{Type: I64, Value: "1"},
				}},
				Terminator: Terminator{Op: "return", Value: 0},
			}},
		}
		ssa, err := BuildSSA(f)
		if err != nil {
			t.Fatal(err)
		}
		plan, err := AllocateSSARegisters(ssa, X64LeafRegisterCount(), 0)
		if err != nil {
			t.Fatal(err)
		}
		return ssa, plan
	}
	a, ap := makeFunction("alpha")
	b, bp := makeFunction("beta")
	asm, err := EmitX64SSAModule(
		[]SSAFunction{a, b},
		map[string]SSARegisterPlan{"alpha": ap, "beta": bp},
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range [][]byte{
		[]byte(".Lswyp_alpha_b0:"),
		[]byte(".Lswyp_beta_b0:"),
		[]byte("swyp_core_alpha:"),
		[]byte("swyp_core_beta:"),
	} {
		if !bytes.Contains(asm, want) {
			t.Fatalf("assembly missing %q:\n%s", want, asm)
		}
	}
	if bytes.Contains(asm, []byte("\n.Lswyp_b0:")) {
		t.Fatalf("unnamespaced local label remained:\n%s", asm)
	}
}

func TestEmitX64SSAIEEE64AllSpilled(t *testing.T) {
	f := SSAFunction{
		Name:       "fp_spill",
		Params:     []SSAValue{0, 1},
		ParamNames: []string{"x", "y"},
		Result:     IEEE64,
		ValueTypes: []Type{IEEE64, IEEE64, IEEE64},
		Blocks: []SSABlock{{
			Reachable: true,
			Instructions: []SSAInstruction{{
				Op:      "add",
				Dest:    2,
				Args:    []SSAValue{0, 1},
				MayTrap: false,
			}},
			Terminator: SSATerminator{Op: "return", Value: 2},
		}},
	}
	plan := SSARegisterPlan{
		Locations: []RegisterLocation{
			{Class: RegisterFP, Register: -1, Spill: 0},
			{Class: RegisterFP, Register: -1, Spill: 1},
			{Class: RegisterFP, Register: -1, Spill: 2},
		},
		Spills: 3,
	}
	asm, err := EmitX64SSA(f, plan)
	if err != nil {
		t.Fatal(err)
	}
	text := string(asm)
	for _, want := range []string{
		"sub rsp, 32",
		"movsd QWORD PTR [rbp-8], xmm0",
		"movsd QWORD PTR [rbp-16], xmm1",
		"movsd xmm4, QWORD PTR [rbp-8]",
		"movsd xmm5, QWORD PTR [rbp-16]",
		"addsd xmm3, xmm5",
		"movsd QWORD PTR [rbp-24], xmm3",
		"movsd xmm0, QWORD PTR [rbp-24]",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("assembly missing %q:\n%s", want, text)
		}
	}
}

func TestEmitX64SSAIEEE64PhiSpills(t *testing.T) {
	f := SSAFunction{
		Name:       "choose_fp_spill",
		Params:     []SSAValue{0, 1, 2},
		ParamNames: []string{"cond", "x", "y"},
		Result:     IEEE64,
		ValueTypes: []Type{Bool, IEEE64, IEEE64, IEEE64},
		Blocks: []SSABlock{
			{
				Reachable:  true,
				Terminator: SSATerminator{Op: "branch", Value: 0, Targets: []int{1, 2}},
			},
			{
				Reachable:  true,
				Terminator: SSATerminator{Op: "jump", Value: NoSSAValue, Targets: []int{3}},
			},
			{
				Reachable:  true,
				Terminator: SSATerminator{Op: "jump", Value: NoSSAValue, Targets: []int{3}},
			},
			{
				Reachable: true,
				Phis: []SSAPhi{{
					Dest: 3,
					Inputs: []SSAPhiInput{
						{Predecessor: 1, Value: 1},
						{Predecessor: 2, Value: 2},
					},
				}},
				Terminator: SSATerminator{Op: "return", Value: 3},
			},
		},
	}
	plan := SSARegisterPlan{
		Locations: []RegisterLocation{
			{Class: RegisterGPR, Register: 0, Spill: -1},
			{Class: RegisterFP, Register: -1, Spill: 0},
			{Class: RegisterFP, Register: -1, Spill: 1},
			{Class: RegisterFP, Register: -1, Spill: 2},
		},
		GPRUsed: 1,
		Spills:  3,
	}
	asm, err := EmitX64SSA(f, plan)
	if err != nil {
		t.Fatal(err)
	}
	text := string(asm)
	for _, want := range []string{
		"movsd xmm5, QWORD PTR [rbp-8]",
		"movsd xmm5, QWORD PTR [rbp-16]",
		"movsd QWORD PTR [rsp], xmm5",
		"movsd QWORD PTR [rbp-24], xmm5",
		"movsd xmm0, QWORD PTR [rbp-24]",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("assembly missing %q:\n%s", want, text)
		}
	}
}
