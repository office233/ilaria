package coreir

import (
	"bytes"
	"strings"
	"testing"
)

func TestEmitARM64LeafSSAAddWithOverflowStatus(t *testing.T) {
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
	plan, err := AllocateSSARegisters(ssa, ARM64LeafRegisterCount(), 0)
	if err != nil {
		t.Fatal(err)
	}
	asm, err := EmitARM64LeafSSA(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		".global swyp_core_add",
		"mov x16, x2",
		"adds ",
		"b.vs .Lswyp_arm64_overflow",
		"str x17, [x16]",
		"ret",
	} {
		if !bytes.Contains(asm, []byte(want)) {
			t.Fatalf("assembly missing %q:\n%s", want, asm)
		}
	}
}

func TestEmitARM64LeafSSAMultiplyChecksHighBits(t *testing.T) {
	f := Function{
		Name:   "mul",
		Params: []Parameter{{Name: "x", Type: I64}, {Name: "y", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "mul", Dest: 2, Args: []int{0, 1}, MayTrap: true}},
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
	asm, err := EmitARM64LeafSSA(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	text := string(asm)
	for _, want := range []string{"mul ", "smulh x9", "asr x10", "b.ne .Lswyp_arm64_overflow"} {
		if !strings.Contains(text, want) {
			t.Fatalf("assembly missing %q:\n%s", want, text)
		}
	}
}

func TestEmitARM64LeafSSARejectsBranch(t *testing.T) {
	ssa := SSAFunction{
		Name:       "branch",
		Result:     I64,
		ValueTypes: []Type{Bool, I64},
		Blocks: []SSABlock{
			{Reachable: true, Terminator: SSATerminator{Op: "branch", Value: 0, Targets: []int{1, 2}}},
			{Reachable: true, Terminator: SSATerminator{Op: "return", Value: 1}},
			{Reachable: true, Terminator: SSATerminator{Op: "return", Value: 1}},
		},
	}
	plan := SSARegisterPlan{Locations: []RegisterLocation{
		{Class: RegisterGPR, Register: 0, Spill: -1},
		{Class: RegisterGPR, Register: 1, Spill: -1},
	}}
	if _, err := EmitARM64LeafSSA(ssa, plan); err == nil {
		t.Fatal("branch unexpectedly accepted by ARM64 leaf backend")
	}
}

func TestEmitARM64LeafSSAIEEE64(t *testing.T) {
	f := Function{
		Name:   "mulfp",
		Params: []Parameter{{Name: "x", Type: IEEE64}, {Name: "y", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{IEEE64, IEEE64, IEEE64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "mul", Dest: 2, Args: []int{0, 1}, MayTrap: false}},
			Terminator:   Terminator{Op: "return", Value: 2},
		}},
	}
	ssa, err := BuildSSA(f)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := AllocateSSARegisters(ssa, ARM64LeafRegisterCount(), ARM64FPRegisterCount())
	if err != nil {
		t.Fatal(err)
	}
	asm, err := EmitARM64LeafSSA(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	text := string(asm)
	for _, want := range []string{"mov x16, x0", "fmov d8, d0", "fmul ", "fmov d0, ", "str d", "ldr d"} {
		if !strings.Contains(text, want) {
			t.Fatalf("assembly missing %q:\n%s", want, text)
		}
	}
}

func TestEmitARM64LeafSSARejectsStrictF64(t *testing.T) {
	f := Function{
		Name:   "strict",
		Params: []Parameter{{Name: "x", Type: F64}},
		Result: F64,
		Slots:  []Type{F64},
		Blocks: []Block{{Terminator: Terminator{Op: "return", Value: 0}}},
	}
	ssa, err := BuildSSA(f)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := AllocateSSARegisters(ssa, ARM64LeafRegisterCount(), ARM64FPRegisterCount())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := EmitARM64LeafSSA(ssa, plan); err == nil || !strings.Contains(err.Error(), "strict f64") {
		t.Fatalf("err=%v", err)
	}
}
