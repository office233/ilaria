//go:build windows && amd64

package coreir

import "testing"

func TestX64SysVThunkExecutesMixedIEEE64(t *testing.T) {
	f := Function{
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
	ssa, err := BuildSSA(f)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := AllocateSSARegisters(ssa, X64LeafRegisterCount(), X64FPRegisterCount())
	if err != nil {
		t.Fatal(err)
	}
	inner, err := EmitX64CFGMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	wrapped, err := WrapX64SysVEntry(ssa, inner)
	if err != nil {
		t.Fatal(err)
	}
	stdout := runPackedFPHarness(t, wrapped, `
typedef double (__attribute__((sysv_abi)) *swyp_fn)(uint64_t,double,double,uint64_t*);
uint64_t s1=99,s2=99;
double a=((swyp_fn)p)(1,7.25,9.5,&s1);
double b=((swyp_fn)p)(0,7.25,9.5,&s2);
printf("%.17g %llu %.17g %llu\n",a,(unsigned long long)s1,b,(unsigned long long)s2);
`)
	if stdout != "7.25 0 9.5 0" {
		t.Fatalf("output=%q", stdout)
	}
}

func TestX64SysVThunkExecutesFourGPRArguments(t *testing.T) {
	f := Function{
		Name: "sum4",
		Params: []Parameter{
			{Name: "a", Type: I64}, {Name: "b", Type: I64}, {Name: "c", Type: I64}, {Name: "d", Type: I64},
		},
		Result: I64,
		Slots:  []Type{I64, I64, I64, I64, I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "add", Dest: 4, Args: []int{0, 1}, MayTrap: true},
				{Op: "add", Dest: 5, Args: []int{2, 3}, MayTrap: true},
				{Op: "add", Dest: 6, Args: []int{4, 5}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 6},
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
	inner, err := EmitX64CFGMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	wrapped, err := WrapX64SysVEntry(ssa, inner)
	if err != nil {
		t.Fatal(err)
	}
	stdout := runPackedFPHarness(t, wrapped, `
typedef uint64_t (__attribute__((sysv_abi)) *swyp_fn)(uint64_t,uint64_t,uint64_t,uint64_t,uint64_t*);
uint64_t status=99;
uint64_t value=((swyp_fn)p)(10,20,30,40,&status);
printf("%llu %llu\n",(unsigned long long)value,(unsigned long long)status);
`)
	if stdout != "100 0" {
		t.Fatalf("output=%q", stdout)
	}
}
