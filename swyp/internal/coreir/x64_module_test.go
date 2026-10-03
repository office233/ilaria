package coreir

import (
	"bytes"
	"testing"
)

func TestX64ModuleRoundTripAndHash(t *testing.T) {
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
	code, err := EmitX64LeafMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	m, err := NewX64Module(ssa, code)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodeX64Module(m)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeX64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Header.Entry != "add" || !bytes.Equal(decoded.Code, code) {
		t.Fatalf("decoded=%+v", decoded.Header)
	}
	encoded[len(encoded)-1] ^= 0xff
	if _, err := DecodeX64Module(encoded); err == nil {
		t.Fatal("corrupted module unexpectedly accepted")
	}
}

func TestX64ModuleRejectsInvalidSignatureMetadata(t *testing.T) {
	m := X64Module{
		Header: X64ModuleHeader{
			Version:    1,
			ABI:        X64LeafABI,
			Entry:      "../bad",
			Params:     []Type{I64},
			Result:     I64,
			CodeSHA256: "00",
		},
		Code: []byte{0xc3},
	}
	if _, err := EncodeX64Module(m); err == nil {
		t.Fatal("invalid module header unexpectedly encoded")
	}
}

func TestX64CFGModuleRoundTrip(t *testing.T) {
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
	m, err := NewX64CFGModule(ssa, code)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodeX64Module(m)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeX64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Header.ABI != X64CFGMachineABI || decoded.Header.Entry != "choose" {
		t.Fatalf("header=%+v", decoded.Header)
	}
	if !bytes.Equal(decoded.Code, code) {
		t.Fatal("decoded CFG machine code changed")
	}
}

func TestX64CFGCallsModuleRoundTripAndRejectsRecursion(t *testing.T) {
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
	functions := make([]SSAFunction, 0, 2)
	plans := make(map[string]SSARegisterPlan, 2)
	for _, f := range []Function{callee, caller} {
		ssa, err := BuildSSA(f)
		if err != nil {
			t.Fatal(err)
		}
		plan, err := AllocateSSARegisters(ssa, X64LeafRegisterCount(), 0)
		if err != nil {
			t.Fatal(err)
		}
		functions = append(functions, ssa)
		plans[f.Name] = plan
	}
	code, err := EmitX64CFGMachineModule(functions, plans, "entry")
	if err != nil {
		t.Fatal(err)
	}
	entrySSA := functions[1]
	m, err := NewX64CFGCallsModule(entrySSA, code)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodeX64Module(m)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeX64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Header.ABI != X64CFGMachineCallsABI || decoded.Header.Entry != "entry" || !bytes.Equal(decoded.Code, code) {
		t.Fatalf("decoded=%+v", decoded.Header)
	}

	recur := Function{
		Name:   "recur",
		Params: []Parameter{{Name: "x", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "call", Dest: 1, Args: []int{0}, Callee: "recur", MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 1},
		}},
	}
	ssa, err := BuildSSA(recur)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := AllocateSSARegisters(ssa, X64LeafRegisterCount(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := EmitX64CFGMachineModule([]SSAFunction{ssa}, map[string]SSARegisterPlan{"recur": plan}, "recur"); err == nil {
		t.Fatal("recursive packed module unexpectedly accepted")
	}
}

func TestX64CFGFPModuleRoundTrip(t *testing.T) {
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
	code, err := EmitX64CFGMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	m, err := NewX64CFGModule(ssa, code)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodeX64Module(m)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeX64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Header.ABI != X64CFGMachineFPABI || decoded.Header.Result != IEEE64 {
		t.Fatalf("header=%+v", decoded.Header)
	}
	if len(decoded.Header.Params) != 2 || decoded.Header.Params[0] != IEEE64 || decoded.Header.Params[1] != IEEE64 {
		t.Fatalf("params=%v", decoded.Header.Params)
	}
}

func TestX64CFGFPCallsModuleRoundTrip(t *testing.T) {
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
	functions := make([]SSAFunction, 0, 2)
	plans := make(map[string]SSARegisterPlan, 2)
	for _, f := range []Function{callee, caller} {
		ssa, err := BuildSSA(f)
		if err != nil {
			t.Fatal(err)
		}
		plan, err := AllocateSSARegisters(ssa, X64LeafRegisterCount(), 0)
		if err != nil {
			t.Fatal(err)
		}
		functions = append(functions, ssa)
		plans[f.Name] = plan
	}
	code, err := EmitX64CFGMachineModule(functions, plans, "entry")
	if err != nil {
		t.Fatal(err)
	}
	m, err := NewX64CFGFPCallsModule(functions[1], code)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodeX64Module(m)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeX64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Header.ABI != X64CFGMachineFPCallsABI || decoded.Header.Result != IEEE64 || !bytes.Equal(decoded.Code, code) {
		t.Fatalf("header=%+v", decoded.Header)
	}
}
