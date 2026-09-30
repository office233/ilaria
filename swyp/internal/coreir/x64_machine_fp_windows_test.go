//go:build windows && amd64

package coreir

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestX64CFGMachineCodeExecutesIEEE64WithSpills(t *testing.T) {
	f := Function{
		Name:   "mulfp",
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
	plan, err := AllocateSSARegisters(ssa, X64LeafRegisterCount(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Spills < 3 {
		t.Fatalf("fixture did not force FP spills: %+v", plan)
	}
	code, err := EmitX64CFGMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	stdout := runPackedFPHarness(t, code, `
typedef double (*swyp_fn)(double,double,uint64_t*);
uint64_t status=99;
double value=((swyp_fn)p)(1.5,2.0,&status);
printf("%.17g %llu\n",value,(unsigned long long)status);
`)
	if stdout != "3 0" {
		t.Fatalf("output=%q want=%q", stdout, "3 0")
	}
}

func TestX64CFGMachineCodeIEEE64NaNComparison(t *testing.T) {
	f := Function{
		Name:   "nefp",
		Params: []Parameter{{Name: "x", Type: IEEE64}, {Name: "y", Type: IEEE64}},
		Result: Bool,
		Slots:  []Type{IEEE64, IEEE64, Bool},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "ne", Dest: 2, Args: []int{0, 1}}},
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
	code, err := EmitX64CFGMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	stdout := runPackedFPHarness(t, code, `
typedef uint64_t (*swyp_fn)(double,double,uint64_t*);
uint64_t status=99;
double nanv=NAN;
uint64_t value=((swyp_fn)p)(nanv,nanv,&status);
printf("%llu %llu\n",(unsigned long long)value,(unsigned long long)status);
`)
	if stdout != "1 0" {
		t.Fatalf("output=%q want=%q", stdout, "1 0")
	}
}

func TestX64CFGMachineCodeIEEE64MixedPositionsAndXMMRestore(t *testing.T) {
	f := Function{
		Name:   "choosefp",
		Params: []Parameter{{Name: "cond", Type: Bool}, {Name: "x", Type: IEEE64}, {Name: "y", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{Bool, IEEE64, IEEE64},
		Blocks: []Block{
			{Terminator: Terminator{Op: "branch", Value: 0, Targets: []int{1, 2}}},
			{Terminator: Terminator{Op: "return", Value: 1}},
			{Terminator: Terminator{Op: "return", Value: 2}},
		},
	}
	ssa, err := BuildSSA(f)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := AllocateSSARegisters(ssa, X64LeafRegisterCount(), 2)
	if err != nil {
		t.Fatal(err)
	}
	if plan.FPUsed == 0 {
		t.Fatalf("fixture did not allocate XMM registers: %+v", plan)
	}
	code, err := EmitX64CFGMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	stdout := runPackedFPHarness(t, code, `
typedef double (*swyp_fn)(uint64_t,double,double,uint64_t*);
uint64_t status1=99,status2=99;
double sentinel=123.5,after=0.0;
__asm__ volatile("movsd %0, %%xmm6" :: "m"(sentinel) : "xmm6");
double a=((swyp_fn)p)(1,7.25,9.5,&status1);
__asm__ volatile("movsd %%xmm6, %0" : "=m"(after));
double b=((swyp_fn)p)(0,7.25,9.5,&status2);
printf("%.17g %llu %.17g %llu %.17g\n",a,(unsigned long long)status1,b,(unsigned long long)status2,after);
`)
	if stdout != "7.25 0 9.5 0 123.5" {
		t.Fatalf("output=%q", stdout)
	}
}

func TestX64CFGMachineModuleExecutesIEEE64Call(t *testing.T) {
	callee := Function{
		Name:   "mulfp",
		Params: []Parameter{{Name: "x", Type: IEEE64}, {Name: "y", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{IEEE64, IEEE64, IEEE64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "mul", Dest: 2, Args: []int{0, 1}}},
			Terminator:   Terminator{Op: "return", Value: 2},
		}},
	}
	caller := Function{
		Name:   "entry",
		Params: []Parameter{{Name: "x", Type: IEEE64}, {Name: "y", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{IEEE64, IEEE64, IEEE64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "call", Dest: 2, Args: []int{0, 1}, Callee: "mulfp", MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 2},
		}},
	}
	code := mustX64CFGFPModuleCode(t, []Function{callee, caller}, "entry", X64LeafRegisterCount(), X64FPRegisterCount())
	stdout := runPackedFPHarness(t, code, `
typedef double (*swyp_fn)(double,double,uint64_t*);
uint64_t status=99;
double value=((swyp_fn)p)(1.5,4.0,&status);
printf("%.17g %llu\n",value,(unsigned long long)status);
`)
	if stdout != "6 0" {
		t.Fatalf("output=%q want=%q", stdout, "6 0")
	}
}

func TestX64CFGMachineModuleExecutesMixedIEEE64Call(t *testing.T) {
	callee := Function{
		Name:   "choose",
		Params: []Parameter{{Name: "c", Type: Bool}, {Name: "x", Type: IEEE64}, {Name: "y", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{Bool, IEEE64, IEEE64},
		Blocks: []Block{
			{Terminator: Terminator{Op: "branch", Value: 0, Targets: []int{1, 2}}},
			{Terminator: Terminator{Op: "return", Value: 1}},
			{Terminator: Terminator{Op: "return", Value: 2}},
		},
	}
	caller := Function{
		Name:   "entry",
		Params: []Parameter{{Name: "c", Type: Bool}, {Name: "x", Type: IEEE64}, {Name: "y", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{Bool, IEEE64, IEEE64, IEEE64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "call", Dest: 3, Args: []int{0, 1, 2}, Callee: "choose", MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 3},
		}},
	}
	code := mustX64CFGFPModuleCode(t, []Function{callee, caller}, "entry", X64LeafRegisterCount(), X64FPRegisterCount())
	stdout := runPackedFPHarness(t, code, `
typedef double (*swyp_fn)(uint64_t,double,double,uint64_t*);
uint64_t s1=99,s2=99;
double a=((swyp_fn)p)(1,7.25,9.5,&s1);
double b=((swyp_fn)p)(0,7.25,9.5,&s2);
printf("%.17g %llu %.17g %llu\n",a,(unsigned long long)s1,b,(unsigned long long)s2);
`)
	if stdout != "7.25 0 9.5 0" {
		t.Fatalf("output=%q", stdout)
	}
}

func TestX64CFGMachineModuleIEEE64CallWithSpills(t *testing.T) {
	callee := Function{
		Name:   "mulfp",
		Params: []Parameter{{Name: "x", Type: IEEE64}, {Name: "y", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{IEEE64, IEEE64, IEEE64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "mul", Dest: 2, Args: []int{0, 1}}},
			Terminator:   Terminator{Op: "return", Value: 2},
		}},
	}
	caller := Function{
		Name:   "entry",
		Params: []Parameter{{Name: "x", Type: IEEE64}, {Name: "y", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{IEEE64, IEEE64, IEEE64, IEEE64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "call", Dest: 2, Args: []int{0, 1}, Callee: "mulfp", MayTrap: true},
				{Op: "add", Dest: 3, Args: []int{2, 0}},
			},
			Terminator: Terminator{Op: "return", Value: 3},
		}},
	}
	code := mustX64CFGFPModuleCode(t, []Function{callee, caller}, "entry", X64LeafRegisterCount(), 0)
	stdout := runPackedFPHarness(t, code, `
typedef double (*swyp_fn)(double,double,uint64_t*);
uint64_t status=99;
double value=((swyp_fn)p)(2.0,3.0,&status);
printf("%.17g %llu\n",value,(unsigned long long)status);
`)
	if stdout != "8 0" {
		t.Fatalf("output=%q want=%q", stdout, "8 0")
	}
}

func TestX64CFGMachineModuleNestedIEEE64Calls(t *testing.T) {
	leaf := Function{
		Name:   "mul2",
		Params: []Parameter{{Name: "x", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{IEEE64, IEEE64, IEEE64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "const", Dest: 1, Constant: &Literal{Type: IEEE64, Value: "2"}},
				{Op: "mul", Dest: 2, Args: []int{0, 1}},
			},
			Terminator: Terminator{Op: "return", Value: 2},
		}},
	}
	middle := Function{
		Name:   "middle",
		Params: []Parameter{{Name: "x", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{IEEE64, IEEE64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "call", Dest: 1, Args: []int{0}, Callee: "mul2", MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 1},
		}},
	}
	entry := Function{
		Name:   "entry",
		Params: []Parameter{{Name: "x", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{IEEE64, IEEE64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "call", Dest: 1, Args: []int{0}, Callee: "middle", MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 1},
		}},
	}
	code := mustX64CFGFPModuleCode(t, []Function{leaf, middle, entry}, "entry", X64LeafRegisterCount(), X64FPRegisterCount())
	stdout := runPackedFPHarness(t, code, `
typedef double (*swyp_fn)(double,uint64_t*);
uint64_t status=99;
double value=((swyp_fn)p)(3.25,&status);
printf("%.17g %llu\n",value,(unsigned long long)status);
`)
	if stdout != "6.5 0" {
		t.Fatalf("output=%q want=%q", stdout, "6.5 0")
	}
}

func mustX64CFGFPModuleCode(t *testing.T, functions []Function, entry string, gprs, fps int) []byte {
	t.Helper()
	ssaFunctions := make([]SSAFunction, 0, len(functions))
	plans := make(map[string]SSARegisterPlan, len(functions))
	for _, f := range functions {
		ssa, err := BuildSSA(f)
		if err != nil {
			t.Fatal(err)
		}
		plan, err := AllocateSSARegisters(ssa, gprs, fps)
		if err != nil {
			t.Fatal(err)
		}
		ssaFunctions = append(ssaFunctions, ssa)
		plans[f.Name] = plan
	}
	code, err := EmitX64CFGMachineModule(ssaFunctions, plans, entry)
	if err != nil {
		t.Fatal(err)
	}
	return code
}

func runPackedFPHarness(t *testing.T, code []byte, body string) string {
	t.Helper()
	gcc, err := exec.LookPath("gcc")
	if err != nil {
		t.Skip("gcc unavailable")
	}
	if len(code) == 0 {
		t.Fatal("empty machine code")
	}
	encoded := make([]string, len(code))
	for i, v := range code {
		encoded[i] = strconv.Itoa(int(v))
	}
	source := fmt.Sprintf(`#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
static const unsigned char code_bytes[] = {%s};
int main(void) {
  void *p=VirtualAlloc(0,sizeof(code_bytes),MEM_COMMIT|MEM_RESERVE,PAGE_EXECUTE_READWRITE);
  if(!p)return 3;
  memcpy(p,code_bytes,sizeof(code_bytes));
  %s
  VirtualFree(p,0,MEM_RELEASE);
  return 0;
}
`, strings.Join(encoded, ","), body)
	dir := t.TempDir()
	cPath := filepath.Join(dir, "packed_fp.c")
	exePath := filepath.Join(dir, "packed_fp.exe")
	if err := os.WriteFile(cPath, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(gcc, "-O1", cPath, "-o", exePath).CombinedOutput(); err != nil {
		t.Fatalf("compile harness: %v\n%s\n%s", err, output, source)
	}
	output, err := exec.Command(exePath).CombinedOutput()
	if err != nil {
		t.Fatalf("run harness: %v\n%s", err, output)
	}
	return strings.TrimSpace(string(output))
}
