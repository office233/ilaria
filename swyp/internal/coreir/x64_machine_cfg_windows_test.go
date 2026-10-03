//go:build windows && amd64

package coreir

import (
	"runtime"
	"syscall"
	"testing"
	"unsafe"
)

const (
	memCommit            = 0x1000
	memReserve           = 0x2000
	memRelease           = 0x8000
	pageExecuteReadWrite = 0x40
)

var (
	kernel32Test           = syscall.NewLazyDLL("kernel32.dll")
	virtualAllocTest       = kernel32Test.NewProc("VirtualAlloc")
	virtualFreeTest        = kernel32Test.NewProc("VirtualFree")
	getCurrentProcessTest  = kernel32Test.NewProc("GetCurrentProcess")
	writeProcessMemoryTest = kernel32Test.NewProc("WriteProcessMemory")
)

func runX64MachineCodeForTest(t *testing.T, code []byte, args ...uintptr) (uintptr, uint64) {
	t.Helper()
	if len(code) == 0 {
		t.Fatal("empty machine code")
	}
	addr, _, allocErr := virtualAllocTest.Call(
		0,
		uintptr(len(code)),
		memCommit|memReserve,
		pageExecuteReadWrite,
	)
	if addr == 0 {
		t.Fatalf("VirtualAlloc: %v", allocErr)
	}
	defer func() {
		if ok, _, err := virtualFreeTest.Call(addr, 0, memRelease); ok == 0 {
			t.Errorf("VirtualFree: %v", err)
		}
	}()
	process, _, _ := getCurrentProcessTest.Call()
	var written uintptr
	ok, _, writeErr := writeProcessMemoryTest.Call(
		process,
		addr,
		uintptr(unsafe.Pointer(&code[0])),
		uintptr(len(code)),
		uintptr(unsafe.Pointer(&written)),
	)
	runtime.KeepAlive(code)
	if ok == 0 || written != uintptr(len(code)) {
		t.Fatalf("WriteProcessMemory: wrote=%d/%d err=%v", written, len(code), writeErr)
	}
	var status uint64
	callArgs := append([]uintptr(nil), args...)
	callArgs = append(callArgs, uintptr(unsafe.Pointer(&status)))
	result, _, _ := syscall.SyscallN(addr, callArgs...)
	return result, status
}

func TestX64CFGMachineCodeExecutesBranch(t *testing.T) {
	f := Function{
		Name:   "choose",
		Params: []Parameter{{Name: "c", Type: Bool}, {Name: "x", Type: I64}, {Name: "y", Type: I64}},
		Result: I64,
		Slots:  []Type{Bool, I64, I64},
		Blocks: []Block{
			{Terminator: Terminator{Op: "branch", Value: 0, Targets: []int{1, 2}}},
			{Terminator: Terminator{Op: "return", Value: 1}},
			{Terminator: Terminator{Op: "return", Value: 2}},
		},
	}
	code := mustX64CFGCode(t, f, X64LeafRegisterCount())
	for _, tc := range []struct {
		cond uintptr
		want uintptr
	}{{1, 7}, {0, 9}} {
		got, status := runX64MachineCodeForTest(t, code, tc.cond, 7, 9)
		if status != 0 || got != tc.want {
			t.Fatalf("cond=%d got=%d status=%d want=%d", tc.cond, got, status, tc.want)
		}
	}
}

func TestX64CFGMachineSkipsDeadPhiCopySharingLiveRegister(t *testing.T) {
	// value 2 is a dead phi allocated to the same register as the live phi 3.
	// Materializing value 2 would overwrite value 0 before phi 3's no-op edge
	// copy, returning the second argument instead of the first.
	f := SSAFunction{
		Name:       "dead_phi",
		Params:     []SSAValue{0, 1},
		ParamNames: []string{"live", "dead_source"},
		Result:     U64,
		ValueTypes: []Type{U64, U64, U64, U64},
		Blocks: []SSABlock{
			{Reachable: true, Terminator: SSATerminator{Op: "jump", Targets: []int{1}, Value: NoSSAValue}},
			{
				Reachable: true,
				Phis: []SSAPhi{
					{Dest: 2, Slot: 0, Inputs: []SSAPhiInput{{Predecessor: 0, Value: 1}}},
					{Dest: 3, Slot: 1, Inputs: []SSAPhiInput{{Predecessor: 0, Value: 0}}},
				},
				Terminator: SSATerminator{Op: "return", Value: 3},
			},
		},
	}
	plan := SSARegisterPlan{Locations: []RegisterLocation{
		{Class: RegisterGPR, Register: 0, Spill: -1},
		{Class: RegisterGPR, Register: 1, Spill: -1},
		{Class: RegisterGPR, Register: 0, Spill: -1}, // dead phi
		{Class: RegisterGPR, Register: 0, Spill: -1}, // live phi
	}}
	code, err := EmitX64CFGMachineCode(f, plan)
	if err != nil {
		t.Fatal(err)
	}
	got, status := runX64MachineCodeForTest(t, code, 7, 9)
	if status != 0 || got != 7 {
		t.Fatalf("got=%d status=%d want=7", got, status)
	}
}

func TestX64CFGMachineCodeExecutesSpills(t *testing.T) {
	f := Function{
		Name:   "pressure",
		Params: []Parameter{{Name: "a", Type: I64}, {Name: "b", Type: I64}, {Name: "c", Type: I64}, {Name: "d", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64, I64, I64, I64, I64, I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "add", Dest: 4, Args: []int{0, 1}, MayTrap: true},
				{Op: "add", Dest: 5, Args: []int{2, 3}, MayTrap: true},
				{Op: "add", Dest: 6, Args: []int{0, 2}, MayTrap: true},
				{Op: "add", Dest: 7, Args: []int{1, 3}, MayTrap: true},
				{Op: "add", Dest: 8, Args: []int{4, 5}, MayTrap: true},
				{Op: "add", Dest: 8, Args: []int{8, 6}, MayTrap: true},
				{Op: "add", Dest: 8, Args: []int{8, 7}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 8},
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
	if plan.Spills == 0 {
		t.Fatalf("fixture did not force spills: %+v", plan)
	}
	code, err := EmitX64CFGMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	got, status := runX64MachineCodeForTest(t, code, 1, 2, 3, 4)
	if status != 0 || got != 20 {
		t.Fatalf("got=%d status=%d want=20", got, status)
	}
}

func TestX64CFGMachineModuleExecutesScalarCall(t *testing.T) {
	callee := Function{
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
	}
	caller := Function{
		Name:   "entry",
		Params: []Parameter{{Name: "x", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "call", Dest: 1, Args: []int{0}, Callee: "inc", MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 1},
		}},
	}
	code := mustX64CFGModuleCode(t, []Function{callee, caller}, "entry", X64LeafRegisterCount())
	got, status := runX64MachineCodeForTest(t, code, 41)
	if status != 0 || got != 42 {
		t.Fatalf("got=%d status=%d want=42/0", got, status)
	}
	got, status = runX64MachineCodeForTest(t, code, uintptr(^uint64(0)>>1))
	if status != 1 || got != 0 {
		t.Fatalf("overflow got=%d status=%d want=0/1", got, status)
	}
}

func TestX64CFGMachineUnreachableReturnsBoundsStatus(t *testing.T) {
	f := Function{
		Name:   "entry",
		Result: I64,
		Blocks: []Block{{Terminator: Terminator{Op: "unreachable", Value: -1}}},
	}
	code := mustX64CFGModuleCode(t, []Function{f}, "entry", X64LeafRegisterCount())
	got, status := runX64MachineCodeForTest(t, code)
	if got != 0 || status != 3 {
		t.Fatalf("unreachable got=%d status=%d want=0/3", got, status)
	}
}

func TestX64CFGMachineModuleExecutesFourArgumentCall(t *testing.T) {
	callee := Function{
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
	caller := Function{
		Name: "entry",
		Params: []Parameter{
			{Name: "a", Type: I64}, {Name: "b", Type: I64}, {Name: "c", Type: I64}, {Name: "d", Type: I64},
		},
		Result: I64,
		Slots:  []Type{I64, I64, I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "call", Dest: 4, Args: []int{0, 1, 2, 3}, Callee: "sum4", MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 4},
		}},
	}
	code := mustX64CFGModuleCode(t, []Function{callee, caller}, "entry", X64LeafRegisterCount())
	got, status := runX64MachineCodeForTest(t, code, 10, 20, 30, 40)
	if status != 0 || got != 100 {
		t.Fatalf("got=%d status=%d want=100/0", got, status)
	}
}

func TestX64CFGMachineModulePreservesStatusAcrossNestedCalls(t *testing.T) {
	leaf := Function{
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
	}
	middle := Function{
		Name:   "middle",
		Params: []Parameter{{Name: "x", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "call", Dest: 1, Args: []int{0}, Callee: "inc", MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 1},
		}},
	}
	entry := Function{
		Name:   "entry",
		Params: []Parameter{{Name: "x", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "call", Dest: 1, Args: []int{0}, Callee: "middle", MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 1},
		}},
	}
	code := mustX64CFGModuleCode(t, []Function{leaf, middle, entry}, "entry", X64LeafRegisterCount())
	got, status := runX64MachineCodeForTest(t, code, 9)
	if status != 0 || got != 10 {
		t.Fatalf("got=%d status=%d want=10/0", got, status)
	}
	got, status = runX64MachineCodeForTest(t, code, uintptr(^uint64(0)>>1))
	if status != 1 || got != 0 {
		t.Fatalf("nested overflow got=%d status=%d want=0/1", got, status)
	}
}

func TestX64CFGMachineModuleCallPreservesSpills(t *testing.T) {
	callee := Function{
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
	}
	caller := Function{
		Name: "entry",
		Params: []Parameter{
			{Name: "a", Type: I64}, {Name: "b", Type: I64}, {Name: "c", Type: I64}, {Name: "d", Type: I64},
		},
		Result: I64,
		Slots:  []Type{I64, I64, I64, I64, I64, I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "call", Dest: 4, Args: []int{0}, Callee: "inc", MayTrap: true},
				{Op: "add", Dest: 5, Args: []int{1, 2}, MayTrap: true},
				{Op: "add", Dest: 6, Args: []int{5, 3}, MayTrap: true},
				{Op: "add", Dest: 7, Args: []int{4, 6}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 7},
		}},
	}
	code := mustX64CFGModuleCode(t, []Function{callee, caller}, "entry", 2)
	got, status := runX64MachineCodeForTest(t, code, 1, 2, 3, 4)
	if status != 0 || got != 11 {
		t.Fatalf("got=%d status=%d want=11/0", got, status)
	}
}

func mustX64CFGCode(t *testing.T, f Function, gprs int) []byte {
	t.Helper()
	ssa, err := BuildSSA(f)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := AllocateSSARegisters(ssa, gprs, 0)
	if err != nil {
		t.Fatal(err)
	}
	code, err := EmitX64CFGMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	return code
}

func mustX64CFGModuleCode(t *testing.T, functions []Function, entry string, gprs int) []byte {
	t.Helper()
	ssaFunctions := make([]SSAFunction, 0, len(functions))
	plans := make(map[string]SSARegisterPlan, len(functions))
	for _, f := range functions {
		ssa, err := BuildSSA(f)
		if err != nil {
			t.Fatal(err)
		}
		plan, err := AllocateSSARegisters(ssa, gprs, 0)
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
