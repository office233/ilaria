package coreir

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestEmitARM64LeafMachineCodeAddGolden(t *testing.T) {
	f := SSAFunction{
		Name:       "add",
		Params:     []SSAValue{0, 1},
		ParamNames: []string{"x", "y"},
		Result:     I64,
		ValueTypes: []Type{I64, I64, I64},
		Blocks: []SSABlock{{
			Reachable: true,
			Instructions: []SSAInstruction{{
				Op:      "add",
				Dest:    2,
				Args:    []SSAValue{0, 1},
				MayTrap: true,
			}},
			Terminator: SSATerminator{Op: "return", Value: 2},
		}},
	}
	plan := SSARegisterPlan{Locations: []RegisterLocation{
		{Class: RegisterGPR, Register: 0, Spill: -1},
		{Class: RegisterGPR, Register: 1, Spill: -1},
		{Class: RegisterGPR, Register: 2, Spill: -1},
	}}
	code, err := EmitARM64LeafMachineCode(f, plan)
	if err != nil {
		t.Fatal(err)
	}
	want := []uint32{
		0xaa0203f0, // mov x16, x2 (status pointer)
		0xaa0003e9, // mov x9, x0
		0xaa0103ea, // mov x10, x1
		0xab0a012b, // adds x11, x9, x10
		0x540000a6, // b.vs overflow (+5 instructions)
		0xaa0b03e0, // mov x0, x11
		0xd2800011, // mov x17, #0
		0xf9000211, // str x17, [x16]
		0xd65f03c0, // ret
		0xd2800000, // overflow: mov x0, #0
		0xd2800031, // mov x17, #1
		0xf9000211, // str x17, [x16]
		0xd65f03c0, // ret
	}
	if len(code) != len(want)*4 {
		t.Fatalf("code bytes=%d want=%d", len(code), len(want)*4)
	}
	for i, expected := range want {
		got := binary.LittleEndian.Uint32(code[i*4:])
		if got != expected {
			t.Fatalf("word %d = 0x%08x want 0x%08x", i, got, expected)
		}
	}
}

func TestARM64ModuleRoundTripAndHash(t *testing.T) {
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
	plan, err := AllocateSSARegisters(ssa, ARM64MachineRegisterCount(), 0)
	if err != nil {
		t.Fatal(err)
	}
	code, err := EmitARM64LeafMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	m, err := NewARM64Module(ssa, code)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodeARM64Module(m)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeARM64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Header.ABI != ARM64LeafMachineABI || decoded.Header.Entry != "add" || !bytes.Equal(decoded.Code, code) {
		t.Fatalf("header=%+v", decoded.Header)
	}
	encoded[len(encoded)-1] ^= 0xff
	if _, err := DecodeARM64Module(encoded); err == nil {
		t.Fatal("corrupted ARM64 module unexpectedly accepted")
	}
}

func TestEmitARM64LeafMachineCodeRejectsCFGAndSpills(t *testing.T) {
	ssa := SSAFunction{
		Name:       "branch",
		Params:     []SSAValue{0},
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
		{Class: RegisterGPR, Register: -1, Spill: 0},
	}}
	if _, err := EmitARM64LeafMachineCode(ssa, plan); err == nil {
		t.Fatal("CFG/spilled function unexpectedly accepted by ARM64 leaf packed backend")
	}
}

func TestEmitARM64CFGMachineCodeBranchEncodings(t *testing.T) {
	f := Function{
		Name:   "choose",
		Params: []Parameter{{Name: "cond", Type: Bool}, {Name: "x", Type: I64}, {Name: "y", Type: I64}},
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
	plan, err := AllocateSSARegisters(ssa, ARM64MachineRegisterCount(), 0)
	if err != nil {
		t.Fatal(err)
	}
	code, err := EmitARM64CFGMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	hasCBZ, hasB := false, false
	for i := 0; i < len(code); i += 4 {
		word := binary.LittleEndian.Uint32(code[i:])
		if word&0xff000000 == 0xb4000000 {
			hasCBZ = true
		}
		if word&0xfc000000 == 0x14000000 {
			hasB = true
		}
	}
	if !hasCBZ || !hasB {
		t.Fatalf("missing CFG branch encodings cbz=%v b=%v code=%x", hasCBZ, hasB, code)
	}
	m, err := NewARM64CFGModule(ssa, code)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodeARM64Module(m)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeARM64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Header.ABI != ARM64CFGMachineABI || !bytes.Equal(decoded.Code, code) {
		t.Fatalf("decoded=%+v", decoded.Header)
	}
}

func TestARM64MachinePhiCopiesBreakRegisterCycle(t *testing.T) {
	f := SSAFunction{
		Name:       "cycle",
		ValueTypes: []Type{I64, I64, I64, I64},
		Blocks: []SSABlock{
			{Reachable: true, Terminator: SSATerminator{Op: "jump", Targets: []int{1}}},
			{
				Reachable: true,
				Phis: []SSAPhi{
					{Dest: 2, Inputs: []SSAPhiInput{{Predecessor: 0, Value: 0}}},
					{Dest: 3, Inputs: []SSAPhiInput{{Predecessor: 0, Value: 1}}},
				},
				Terminator: SSATerminator{Op: "return", Value: 2},
			},
		},
	}
	plan := SSARegisterPlan{Locations: []RegisterLocation{
		{Class: RegisterGPR, Register: 0, Spill: -1}, // v0=x9
		{Class: RegisterGPR, Register: 1, Spill: -1}, // v1=x10
		{Class: RegisterGPR, Register: 1, Spill: -1}, // v2=x10 <- x9
		{Class: RegisterGPR, Register: 0, Spill: -1}, // v3=x9  <- x10
	}}
	b := &arm64MachineBuilder{}
	if err := emitARM64MachinePhiCopies(b, f, plan, 0, 1); err != nil {
		t.Fatal(err)
	}
	want := []uint32{
		0xaa0903e8, // mov x8, x9 (cycle scratch)
		0xaa0a03e9, // mov x9, x10
		0xaa0803ea, // mov x10, x8
	}
	if len(b.words) != len(want) {
		t.Fatalf("words=%v", b.words)
	}
	for i, expected := range want {
		if b.words[i] != expected {
			t.Fatalf("word %d=0x%08x want=0x%08x", i, b.words[i], expected)
		}
	}
}

func TestEmitARM64CFGMachineCodeSpillFrameGolden(t *testing.T) {
	f := SSAFunction{
		Name:       "identity_spill",
		Params:     []SSAValue{0},
		ParamNames: []string{"x"},
		Result:     I64,
		ValueTypes: []Type{I64},
		Blocks: []SSABlock{{
			Reachable:  true,
			Terminator: SSATerminator{Op: "return", Value: 0},
		}},
	}
	plan := SSARegisterPlan{Locations: []RegisterLocation{{Class: RegisterGPR, Register: -1, Spill: 0}}, Spills: 1}
	code, err := EmitARM64CFGMachineCode(f, plan)
	if err != nil {
		t.Fatal(err)
	}
	wantPrefix := []uint32{
		0xaa0103f0, // mov x16, x1 (status pointer)
		0xd10043ff, // sub sp, sp, #16
		0xf90003e0, // str x0, [sp]
		0xf94003e0, // ldr x0, [sp]
		0xd2800011, // mov x17, #0
		0xf9000211, // str x17, [x16]
		0x910043ff, // add sp, sp, #16
		0xd65f03c0, // ret
	}
	if len(code) < len(wantPrefix)*4 {
		t.Fatalf("code too short: %d", len(code))
	}
	for i, expected := range wantPrefix {
		got := binary.LittleEndian.Uint32(code[i*4:])
		if got != expected {
			t.Fatalf("word %d=0x%08x want=0x%08x", i, got, expected)
		}
	}
}

func TestEmitARM64CFGMachineCodeSpilledArithmetic(t *testing.T) {
	f := Function{
		Name:   "pressure",
		Params: []Parameter{{Name: "a", Type: I64}, {Name: "b", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64, I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: true},
				{Op: "add", Dest: 3, Args: []int{0, 2}, MayTrap: true},
				{Op: "mul", Dest: 4, Args: []int{1, 3}, MayTrap: true},
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
		t.Fatalf("fixture did not force spills: %+v", plan)
	}
	code, err := EmitARM64CFGMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	hasLoad, hasStore := false, false
	for i := 0; i < len(code); i += 4 {
		word := binary.LittleEndian.Uint32(code[i:])
		if word&0xffc00000 == 0xf9400000 {
			hasLoad = true
		}
		if word&0xffc00000 == 0xf9000000 {
			hasStore = true
		}
	}
	if !hasLoad || !hasStore {
		t.Fatalf("spill loads/stores missing load=%v store=%v code=%x", hasLoad, hasStore, code)
	}
}

func TestEmitARM64CFGMachineCodeIEEE64Spills(t *testing.T) {
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
	plan, err := AllocateSSARegisters(ssa, ARM64MachineRegisterCount(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Spills < 3 {
		t.Fatalf("fixture did not force FP spills: %+v", plan)
	}
	code, err := EmitARM64CFGMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	hasDStore, hasDLoad, hasFMul := false, false, false
	for i := 0; i < len(code); i += 4 {
		word := binary.LittleEndian.Uint32(code[i:])
		if word&0xffc00000 == 0xfd000000 {
			hasDStore = true
		}
		if word&0xffc00000 == 0xfd400000 {
			hasDLoad = true
		}
		if word&0xff20fc00 == 0x1e200800 {
			hasFMul = true
		}
	}
	if !hasDStore || !hasDLoad || !hasFMul {
		t.Fatalf("packed FP encoding missing store=%v load=%v fmul=%v code=%x", hasDStore, hasDLoad, hasFMul, code)
	}
	m, err := NewARM64CFGModule(ssa, code)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodeARM64Module(m)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeARM64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Header.ABI != ARM64CFGMachineFPABI || decoded.Header.Result != IEEE64 || !bytes.Equal(decoded.Code, code) {
		t.Fatalf("decoded=%+v", decoded.Header)
	}
}

func TestEmitARM64CFGMachineCodeIEEE64MixedParams(t *testing.T) {
	f := Function{
		Name:   "choosefp",
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
	plan, err := AllocateSSARegisters(ssa, ARM64MachineRegisterCount(), 2)
	if err != nil {
		t.Fatal(err)
	}
	code, err := EmitARM64CFGMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	words := make([]uint32, len(code)/4)
	for i := range words {
		words[i] = binary.LittleEndian.Uint32(code[i*4:])
	}
	if len(words) == 0 || words[0] != 0xaa0103f0 { // mov x16, x1: status after one GPR param
		t.Fatalf("status-pointer ABI word=%08x", words[0])
	}
	hasCBZ, hasFPReturn := false, false
	for _, word := range words {
		if word&0xff000000 == 0xb4000000 {
			hasCBZ = true
		}
		if word&0xfffffc00 == 0x1e604000 && word&31 == 0 { // fmov d0, dN
			hasFPReturn = true
		}
	}
	if !hasCBZ || !hasFPReturn {
		t.Fatalf("mixed packed ARM64 missing cbz=%v fpReturn=%v code=%08x", hasCBZ, hasFPReturn, words)
	}
}

func TestEmitARM64CFGMachineModuleIEEE64Calls(t *testing.T) {
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
		Params: []Parameter{{Name: "c", Type: Bool}, {Name: "x", Type: IEEE64}, {Name: "y", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{Bool, IEEE64, IEEE64, IEEE64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "call", Dest: 3, Args: []int{1, 2}, Callee: "mulfp", MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 3},
		}},
	}
	functions := make([]SSAFunction, 0, 2)
	plans := make(map[string]SSARegisterPlan, 2)
	for _, f := range []Function{callee, caller} {
		ssa, err := BuildSSA(f)
		if err != nil {
			t.Fatal(err)
		}
		plan, err := AllocateSSARegisters(ssa, ARM64MachineRegisterCount(), ARM64MachineFPRegisterCount())
		if err != nil {
			t.Fatal(err)
		}
		functions = append(functions, ssa)
		plans[f.Name] = plan
	}
	code, err := EmitARM64CFGMachineModule(functions, plans, "entry")
	if err != nil {
		t.Fatal(err)
	}
	words := make([]uint32, len(code)/4)
	for i := range words {
		words[i] = binary.LittleEndian.Uint32(code[i*4:])
	}
	hasBL, hasFPSave, hasFPRestore, hasStatusArg := false, false, false, false
	for _, word := range words {
		if word&0xfc000000 == 0x94000000 {
			hasBL = true
		}
		if word&0xffc00000 == 0xfd000000 {
			hasFPSave = true
		}
		if word&0xffc00000 == 0xfd400000 {
			hasFPRestore = true
		}
		if word&0xffc003ff == 0x910003e0 { // add xN, sp, #imm (status cell address)
			hasStatusArg = true
		}
	}
	if !hasBL || !hasFPSave || !hasFPRestore || !hasStatusArg {
		t.Fatalf("FP call encoding missing bl=%v save=%v restore=%v status=%v code=%08x", hasBL, hasFPSave, hasFPRestore, hasStatusArg, words)
	}
	m, err := NewARM64CFGFPCallsModule(functions[1], code)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodeARM64Module(m)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeARM64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Header.ABI != ARM64CFGMachineFPCallsABI || decoded.Header.Result != IEEE64 || !bytes.Equal(decoded.Code, code) {
		t.Fatalf("decoded=%+v", decoded.Header)
	}
}

func TestARM64MachinePhiCopiesIEEE64Spill(t *testing.T) {
	f := SSAFunction{
		Name:       "fp_phi",
		ValueTypes: []Type{IEEE64, IEEE64},
		Blocks: []SSABlock{
			{Reachable: true, Terminator: SSATerminator{Op: "jump", Targets: []int{1}}},
			{
				Reachable:  true,
				Phis:       []SSAPhi{{Dest: 1, Inputs: []SSAPhiInput{{Predecessor: 0, Value: 0}}}},
				Terminator: SSATerminator{Op: "return", Value: 1},
			},
		},
	}
	plan := SSARegisterPlan{Locations: []RegisterLocation{
		{Class: RegisterFP, Register: -1, Spill: 0},
		{Class: RegisterFP, Register: -1, Spill: 1},
	}, Spills: 2}
	b := &arm64MachineBuilder{}
	if err := emitARM64MachinePhiCopies(b, f, plan, 0, 1); err != nil {
		t.Fatal(err)
	}
	if len(b.words) != 2 {
		t.Fatalf("expected FP spill load/store, got %d: %08x", len(b.words), b.words)
	}
	if b.words[0]&0xffc00000 != 0xfd400000 || b.words[1]&0xffc00000 != 0xfd000000 {
		t.Fatalf("unexpected FP phi spill encoding: %08x", b.words)
	}
}

func TestARM64MachinePhiCopiesBreakRegisterSpillCycle(t *testing.T) {
	f := SSAFunction{
		Name:       "spill_cycle",
		ValueTypes: []Type{I64, I64, I64, I64},
		Blocks: []SSABlock{
			{Reachable: true, Terminator: SSATerminator{Op: "jump", Targets: []int{1}}},
			{
				Reachable: true,
				Phis: []SSAPhi{
					{Dest: 2, Inputs: []SSAPhiInput{{Predecessor: 0, Value: 0}}},
					{Dest: 3, Inputs: []SSAPhiInput{{Predecessor: 0, Value: 1}}},
				},
				Terminator: SSATerminator{Op: "return", Value: 2},
			},
		},
	}
	plan := SSARegisterPlan{Locations: []RegisterLocation{
		{Class: RegisterGPR, Register: 0, Spill: -1}, // v0=x9
		{Class: RegisterGPR, Register: -1, Spill: 0}, // v1=spill0
		{Class: RegisterGPR, Register: -1, Spill: 0}, // spill0 <- x9
		{Class: RegisterGPR, Register: 0, Spill: -1}, // x9 <- spill0
	}, Spills: 1}
	b := &arm64MachineBuilder{}
	if err := emitARM64MachinePhiCopies(b, f, plan, 0, 1); err != nil {
		t.Fatal(err)
	}
	if len(b.words) != 3 {
		t.Fatalf("expected 3 cycle-breaking instructions, got %d: %08x", len(b.words), b.words)
	}
	if b.words[0] != 0xaa0903e8 { // mov x8, x9
		t.Fatalf("scratch save=0x%08x", b.words[0])
	}
	if b.words[1]&0xffc00000 != 0xf9400000 { // ldr x9, [sp]
		t.Fatalf("spill load=0x%08x", b.words[1])
	}
	if b.words[2]&0xffc00000 != 0xf9000000 { // str x8, [sp]
		t.Fatalf("spill store=0x%08x", b.words[2])
	}
}

func TestEmitARM64CFGMachineModuleRelocatesBLAndCallFrame(t *testing.T) {
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
		plan, err := AllocateSSARegisters(ssa, ARM64MachineRegisterCount(), 0)
		if err != nil {
			t.Fatal(err)
		}
		functions = append(functions, ssa)
		plans[f.Name] = plan
	}
	code, err := EmitARM64CFGMachineModule(functions, plans, "entry")
	if err != nil {
		t.Fatal(err)
	}
	words := make([]uint32, len(code)/4)
	for i := range words {
		words[i] = binary.LittleEndian.Uint32(code[i*4:])
	}
	blIndex := -1
	for i, word := range words {
		if word&0xfc000000 == 0x94000000 {
			blIndex = i
			break
		}
	}
	if blIndex < 0 {
		t.Fatalf("BL not found: %08x", words)
	}
	imm26 := int32(words[blIndex] & 0x03ffffff)
	if imm26&(1<<25) != 0 {
		imm26 |= ^int32(0x03ffffff)
	}
	target := blIndex + int(imm26)
	if target <= blIndex || target >= len(words) {
		t.Fatalf("BL target=%d from=%d words=%d", target, blIndex, len(words))
	}
	if words[target] != 0xaa0103f0 { // callee: mov x16, x1
		t.Fatalf("callee entry word=0x%08x target=%d", words[target], target)
	}
	for _, want := range []uint32{
		0xd10143ff, // sub sp, sp, #80
		0xf9000be9, // str x9, [sp, #16]
		0x910023e1, // add x1, sp, #8 (callee status cell)
	} {
		found := false
		for _, word := range words[:target] {
			if word == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("caller encoding 0x%08x not found", want)
		}
	}
	m, err := NewARM64CFGCallsModule(functions[1], code)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodeARM64Module(m)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeARM64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Header.ABI != ARM64CFGMachineCallsABI || decoded.Header.Entry != "entry" || !bytes.Equal(decoded.Code, code) {
		t.Fatalf("decoded=%+v", decoded.Header)
	}
}

func TestARM64CFGMachineModuleNestedCallsAndRecursionGuard(t *testing.T) {
	leaf := Function{
		Name:   "leaf",
		Params: []Parameter{{Name: "x", Type: I64}},
		Result: I64,
		Slots:  []Type{I64},
		Blocks: []Block{{Terminator: Terminator{Op: "return", Value: 0}}},
	}
	middle := Function{
		Name:   "middle",
		Params: []Parameter{{Name: "x", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "call", Dest: 1, Args: []int{0}, Callee: "leaf", MayTrap: true}},
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
	functions := []Function{leaf, middle, entry}
	ssaFunctions := make([]SSAFunction, 0, len(functions))
	plans := make(map[string]SSARegisterPlan, len(functions))
	for _, f := range functions {
		ssa, err := BuildSSA(f)
		if err != nil {
			t.Fatal(err)
		}
		plan, err := AllocateSSARegisters(ssa, ARM64MachineRegisterCount(), 0)
		if err != nil {
			t.Fatal(err)
		}
		ssaFunctions = append(ssaFunctions, ssa)
		plans[f.Name] = plan
	}
	code, err := EmitARM64CFGMachineModule(ssaFunctions, plans, "entry")
	if err != nil || len(code) == 0 {
		t.Fatalf("nested module err=%v code=%d", err, len(code))
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
	plan, err := AllocateSSARegisters(ssa, ARM64MachineRegisterCount(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := EmitARM64CFGMachineModule([]SSAFunction{ssa}, map[string]SSARegisterPlan{"recur": plan}, "recur"); err == nil {
		t.Fatal("recursive ARM64 packed module unexpectedly accepted")
	}
}

func TestEmitARM64CFGMachineCodeIEEE64Golden(t *testing.T) {
	f := SSAFunction{
		Name:       "mulfp",
		Params:     []SSAValue{0, 1},
		ParamNames: []string{"x", "y"},
		Result:     IEEE64,
		ValueTypes: []Type{IEEE64, IEEE64, IEEE64},
		Blocks: []SSABlock{{
			Reachable:    true,
			Instructions: []SSAInstruction{{Op: "mul", Dest: 2, Args: []SSAValue{0, 1}}},
			Terminator:   SSATerminator{Op: "return", Value: 2},
		}},
	}
	plan := SSARegisterPlan{Locations: []RegisterLocation{
		{Class: RegisterFP, Register: 0, Spill: -1},
		{Class: RegisterFP, Register: 1, Spill: -1},
		{Class: RegisterFP, Register: 2, Spill: -1},
	}}
	code, err := EmitARM64CFGMachineCode(f, plan)
	if err != nil {
		t.Fatal(err)
	}
	want := []uint32{
		0xaa0003f0, // mov x16, x0 (status pointer; FP args use D bank)
		0x1e604010, // fmov d16, d0
		0x1e604031, // fmov d17, d1
		0x1e710a12, // fmul d18, d16, d17
		0x1e604240, // fmov d0, d18
		0xd2800011, // mov x17, #0
		0xf9000211, // str x17, [x16]
		0xd65f03c0, // ret
		0xd2800000, // overflow tail: mov x0, #0
		0x9e6703e0, // fmov d0, xzr
		0xd2800031, // mov x17, #1
		0xf9000211,
		0xd65f03c0,
	}
	if len(code) != len(want)*4 {
		t.Fatalf("code bytes=%d want=%d", len(code), len(want)*4)
	}
	for i, expected := range want {
		got := binary.LittleEndian.Uint32(code[i*4:])
		if got != expected {
			t.Fatalf("word %d=0x%08x want=0x%08x", i, got, expected)
		}
	}
	m, err := NewARM64CFGModule(f, code)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodeARM64Module(m)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeARM64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Header.ABI != ARM64CFGMachineFPABI || decoded.Header.Result != IEEE64 || !bytes.Equal(decoded.Code, code) {
		t.Fatalf("decoded=%+v", decoded.Header)
	}
}

func TestEmitARM64CFGMachineCodeIEEE64AllSpilled(t *testing.T) {
	f := Function{
		Name:   "mulfp_spill",
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
	plan, err := AllocateSSARegisters(ssa, ARM64MachineRegisterCount(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Spills < 3 {
		t.Fatalf("fixture did not force FP spills: %+v", plan)
	}
	code, err := EmitARM64CFGMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	wants := []uint32{
		0xd10083ff, // sub sp, sp, #32
		0xfd0003e0, // str d0, [sp]
		0xfd0007e1, // str d1, [sp,#8]
		0xfd4003f9, // ldr d25, [sp]
		0xfd4007fa, // ldr d26, [sp,#8]
		0x1e7a0b38, // fmul d24, d25, d26
		0xfd000bf8, // str d24, [sp,#16]
		0xfd400be0, // ldr d0, [sp,#16]
		0x910083ff, // add sp, sp, #32
	}
	for _, want := range wants {
		found := false
		for i := 0; i < len(code); i += 4 {
			if binary.LittleEndian.Uint32(code[i:]) == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("opcode 0x%08x missing from %x", want, code)
		}
	}
}

func TestEmitARM64CFGMachineCodeIEEE64NaNConditions(t *testing.T) {
	for _, tc := range []struct {
		op       string
		wantCSET uint32
	}{
		{"eq", 0x9a9f17e9},
		{"ne", 0x9a9f07e9},
		{"lt", 0x9a9f57e9},
		{"le", 0x9a9f87e9},
		{"gt", 0x9a9fd7e9},
		{"ge", 0x9a9fb7e9},
	} {
		t.Run(tc.op, func(t *testing.T) {
			f := SSAFunction{
				Name:       "cmpfp",
				Params:     []SSAValue{0, 1},
				Result:     Bool,
				ValueTypes: []Type{IEEE64, IEEE64, Bool},
				Blocks: []SSABlock{{
					Reachable:    true,
					Instructions: []SSAInstruction{{Op: tc.op, Dest: 2, Args: []SSAValue{0, 1}}},
					Terminator:   SSATerminator{Op: "return", Value: 2},
				}},
			}
			plan := SSARegisterPlan{Locations: []RegisterLocation{
				{Class: RegisterFP, Register: 0, Spill: -1},
				{Class: RegisterFP, Register: 1, Spill: -1},
				{Class: RegisterGPR, Register: 0, Spill: -1},
			}}
			code, err := EmitARM64CFGMachineCode(f, plan)
			if err != nil {
				t.Fatal(err)
			}
			foundFCMP, foundCSET := false, false
			for i := 0; i < len(code); i += 4 {
				word := binary.LittleEndian.Uint32(code[i:])
				if word == 0x1e712200 { // fcmp d16,d17
					foundFCMP = true
				}
				if word == tc.wantCSET {
					foundCSET = true
				}
			}
			if !foundFCMP || !foundCSET {
				t.Fatalf("op=%s fcmp=%v cset=%v code=%x", tc.op, foundFCMP, foundCSET, code)
			}
		})
	}
}

func TestEmitARM64CFGMachineCodeMixedGPRFPParams(t *testing.T) {
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
	plan, err := AllocateSSARegisters(ssa, ARM64MachineRegisterCount(), ARM64MachineFPRegisterCount())
	if err != nil {
		t.Fatal(err)
	}
	code, err := EmitARM64CFGMachineCode(ssa, plan)
	if err != nil {
		t.Fatal(err)
	}
	wants := []uint32{
		0xaa0103f0, // status pointer is x1: one GPR program parameter
		0xaa0003e9, // cond x0 -> x9
		0x1e604010, // d0 -> d16
		0x1e604031, // d1 -> d17
	}
	for _, want := range wants {
		found := false
		for i := 0; i < len(code); i += 4 {
			if binary.LittleEndian.Uint32(code[i:]) == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("opcode 0x%08x missing", want)
		}
	}
}
