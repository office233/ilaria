package coreir

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestEmitX64LeafSSAAddWithOverflowStatus(t *testing.T) {
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
	plan, err := AllocateSSARegisters(ssa, X64LeafRegisterCount(), 0)
	if err != nil {
		t.Fatal(err)
	}
	asm, err := EmitX64LeafSSA(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		".intel_syntax noprefix",
		".globl swyp_core_add",
		"call swyp_core_add_raw",
		"mov QWORD PTR [r10], rdx",
		"jo .Lswyp_overflow",
		"mov edx, 1",
		"xor edx, edx",
		"ret",
	} {
		if !bytes.Contains(asm, []byte(want)) {
			t.Fatalf("assembly missing %q:\n%s", want, asm)
		}
	}
}

func TestEmitX64LeafSSAExecutableViaAssemblerLinker(t *testing.T) {
	gcc, err := exec.LookPath("gcc")
	if err != nil {
		t.Skip("gcc unavailable")
	}
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
	plan, err := AllocateSSARegisters(ssa, X64LeafRegisterCount(), 0)
	if err != nil {
		t.Fatal(err)
	}
	assembly, err := EmitX64LeafSSA(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	asmPath := filepath.Join(dir, "add.s")
	cPath := filepath.Join(dir, "main.c")
	exePath := filepath.Join(dir, "add.exe")
	if err := os.WriteFile(asmPath, assembly, 0600); err != nil {
		t.Fatal(err)
	}
	const harness = `
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
extern int64_t swyp_core_add(int64_t x, int64_t y, uint64_t *status);
int main(int argc, char **argv) {
    if (argc != 3) return 2;
    uint64_t status = 99;
    int64_t value = swyp_core_add(strtoll(argv[1], 0, 10), strtoll(argv[2], 0, 10), &status);
    printf("%lld %llu\n", (long long)value, (unsigned long long)status);
    return 0;
}
`
	if err := os.WriteFile(cPath, []byte(harness), 0600); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(gcc, "-O2", asmPath, cPath, "-o", exePath).CombinedOutput(); err != nil {
		t.Fatalf("link: %v\n%s\n%s", err, output, assembly)
	}
	output, err := exec.Command(exePath, "20", "22").CombinedOutput()
	if err != nil || strings.TrimSpace(string(output)) != "42 0" {
		t.Fatalf("normal err=%v output=%q", err, output)
	}
	output, err = exec.Command(exePath, "9223372036854775807", "1").CombinedOutput()
	if err != nil || strings.TrimSpace(string(output)) != "0 1" {
		t.Fatalf("overflow err=%v output=%q", err, output)
	}
}

func TestEmitX64LeafSSAComparison(t *testing.T) {
	f := Function{
		Name:   "less",
		Params: []Parameter{{Name: "x", Type: I64}, {Name: "y", Type: I64}},
		Result: Bool,
		Slots:  []Type{I64, I64, Bool},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "lt", Dest: 2, Args: []int{0, 1}}},
			Terminator:   Terminator{Op: "return", Value: 2},
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
	asm, err := EmitX64LeafSSA(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(asm), "setl ") {
		t.Fatalf("assembly:\n%s", asm)
	}
}

func TestEmitX64LeafSSARejectsBranch(t *testing.T) {
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
	if _, err := EmitX64LeafSSA(ssa, plan); err == nil {
		t.Fatal("branch unexpectedly accepted by leaf backend")
	}
}
