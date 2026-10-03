package coreir

import (
	"encoding/binary"
	"fmt"
)

// ARM64CFGMachineABI extends packed AArch64 leaf-v1 with CFG,
// branches/backedges, GPR spills and SSA phi copies.
const ARM64CFGMachineABI = "swyp-arm64-cfg-machine-aapcs64-v1"

// ARM64CFGMachineFPABI extends packed CFG machine code with explicit ieee64
// values using volatile D16-D23 plus SP-relative FP spill slots. Strict f64
// remains fail-closed.
const ARM64CFGMachineFPABI = "swyp-arm64-cfg-machine-fp-aapcs64-v1"

// ARM64CFGMachineCallsABI extends packed CFG modules with closed acyclic GPR
// calls resolved as BL imm26 references inside the same code blob.
const ARM64CFGMachineCallsABI = "swyp-arm64-cfg-machine-calls-aapcs64-v1"

// ARM64CFGMachineFPCallsABI combines packed BL-relocated call graphs with
// explicit ieee64 arguments/results. GPR and FP argument banks follow AAPCS64
// independently; caller-saved x9-x15 and D16-D23 are preserved in the frame.
const ARM64CFGMachineFPCallsABI = "swyp-arm64-cfg-machine-fp-calls-aapcs64-v1"

type arm64BlockFixup struct {
	wordIndex int
	target    int
}

type arm64CallFixup struct {
	wordIndex int
	callee    string
}

func EmitARM64CFGMachineCode(f SSAFunction, plan SSARegisterPlan) ([]byte, error) {
	if len(plan.Locations) != len(f.ValueTypes) {
		return nil, fmt.Errorf("arm64 cfg machine: register plan/value count mismatch")
	}
	gprParams, fpParams := arm64ParamCounts(f)
	if gprParams >= len(arm64ArgRegisters) || fpParams > len(arm64FPArgRegisters) {
		return nil, fmt.Errorf("arm64 cfg machine: parameter registers exceeded")
	}
	reachable := 0
	for bi, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		reachable++
		for _, phi := range block.Phis {
			if phi.Dest < 0 || int(phi.Dest) >= len(f.ValueTypes) {
				return nil, fmt.Errorf("arm64 cfg machine: block %d invalid phi destination %d", bi, phi.Dest)
			}
		}
		for _, ins := range block.Instructions {
			if ins.Op == "call" {
				return nil, fmt.Errorf("arm64 cfg machine: calls not supported in v1 (block %d)", bi)
			}
		}
	}
	if reachable == 0 {
		return nil, fmt.Errorf("arm64 cfg machine: no reachable blocks")
	}
	for value, t := range f.ValueTypes {
		if t == F64 {
			return nil, fmt.Errorf("arm64 cfg machine: strict f64 is unsupported; use ieee64 or Core AOT")
		}
		loc := plan.Locations[value]
		if loc.Spill >= 0 {
			continue
		}
		limit := len(arm64MachineRegisters)
		if registerClass(t) == RegisterFP {
			limit = len(arm64MachineFPRegisters)
		}
		if loc.Register < 0 || loc.Register >= limit {
			return nil, fmt.Errorf("arm64 cfg machine: invalid allocation for value %d", value)
		}
	}

	b := &arm64MachineBuilder{}
	b.movRegReg(16, gprParams)
	gprSpillBytes := arm64GPRSpillBytes(f, plan)
	fpSpillBytes := arm64FPSpillBytes(f, plan)
	spillBytes := (gprSpillBytes + fpSpillBytes + 15) &^ 15
	if err := b.adjustSP(-spillBytes); err != nil {
		return nil, err
	}
	gprIndex, fpIndex := 0, 0
	for _, value := range f.Params {
		if registerClass(f.ValueTypes[value]) == RegisterFP {
			src := fpIndex
			fpIndex++
			if !ssaValueUsed(f, value) {
				continue
			}
			loc := plan.Locations[value]
			if loc.Spill >= 0 {
				if err := b.strDSp(src, arm64MachineFPSpillOffset(f, plan, loc.Spill)); err != nil {
					return nil, err
				}
			} else {
				dst := arm64PhysicalMachineFPReg(plan, value)
				if dst != src {
					b.fmovD(dst, src)
				}
			}
		} else {
			src := gprIndex
			gprIndex++
			if !ssaValueUsed(f, value) {
				continue
			}
			loc := plan.Locations[value]
			if loc.Spill >= 0 {
				if err := b.strRegSP(src, loc.Spill*8); err != nil {
					return nil, err
				}
			} else {
				dst := arm64PhysicalMachineReg(plan, value)
				if dst != src {
					b.movRegReg(dst, src)
				}
			}
		}
	}

	blockOffsets := make([]int, len(f.Blocks))
	for i := range blockOffsets {
		blockOffsets[i] = -1
	}
	fixups := make([]arm64BlockFixup, 0)
	for bi, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		blockOffsets[bi] = len(b.words)
		for _, ins := range block.Instructions {
			var err error
			if registerClass(f.ValueTypes[ins.Dest]) == RegisterFP ||
				(len(ins.Args) > 0 && registerClass(f.ValueTypes[ins.Args[0]]) == RegisterFP) {
				err = b.emitFPInstruction(f, plan, ins)
			} else {
				err = b.emitInstruction(f, plan, ins)
			}
			if err != nil {
				return nil, fmt.Errorf("arm64 cfg machine block %d: %w", bi, err)
			}
		}
		switch block.Terminator.Op {
		case "return":
			if block.Terminator.Value >= 0 {
				value := block.Terminator.Value
				loc := plan.Locations[value]
				if registerClass(f.ValueTypes[value]) == RegisterFP {
					if loc.Spill >= 0 {
						if err := b.ldrDSp(0, arm64MachineFPSpillOffset(f, plan, loc.Spill)); err != nil {
							return nil, err
						}
					} else {
						result := arm64PhysicalMachineFPReg(plan, value)
						if result != 0 {
							b.fmovD(0, result)
						}
					}
				} else {
					if loc.Spill >= 0 {
						if err := b.ldrRegSP(0, loc.Spill*8); err != nil {
							return nil, err
						}
					} else {
						result := arm64PhysicalMachineReg(plan, value)
						if result != 0 {
							b.movRegReg(0, result)
						}
					}
				}
			} else {
				b.movImm64(0, 0)
			}
			b.movImm64(17, 0)
			b.strReg(16, 17)
			if err := b.adjustSP(spillBytes); err != nil {
				return nil, err
			}
			b.ret()
		case "jump":
			if len(block.Terminator.Targets) != 1 {
				return nil, fmt.Errorf("arm64 cfg machine: block %d invalid jump", bi)
			}
			target := block.Terminator.Targets[0]
			if err := emitARM64MachineLivePhiCopies(b, f, plan, bi, target); err != nil {
				return nil, err
			}
			fixups = append(fixups, arm64BlockFixup{wordIndex: b.branchPlaceholder(), target: target})
		case "branch":
			if len(block.Terminator.Targets) != 2 || block.Terminator.Value < 0 {
				return nil, fmt.Errorf("arm64 cfg machine: block %d invalid branch", bi)
			}
			condLoc := plan.Locations[block.Terminator.Value]
			cond := 7
			if condLoc.Spill >= 0 {
				if err := b.ldrRegSP(cond, condLoc.Spill*8); err != nil {
					return nil, err
				}
			} else {
				cond = arm64PhysicalMachineReg(plan, block.Terminator.Value)
			}
			falseEdge := b.cbzPlaceholder(cond)
			trueTarget := block.Terminator.Targets[0]
			if err := emitARM64MachineLivePhiCopies(b, f, plan, bi, trueTarget); err != nil {
				return nil, err
			}
			fixups = append(fixups, arm64BlockFixup{wordIndex: b.branchPlaceholder(), target: trueTarget})
			falseOffset := len(b.words)
			if err := b.patchCBZ(falseEdge, falseOffset); err != nil {
				return nil, err
			}
			falseTarget := block.Terminator.Targets[1]
			if err := emitARM64MachineLivePhiCopies(b, f, plan, bi, falseTarget); err != nil {
				return nil, err
			}
			fixups = append(fixups, arm64BlockFixup{wordIndex: b.branchPlaceholder(), target: falseTarget})
		case "unreachable":
			// Controlled bounds/trap return. Keep the host alive and use the
			// established machine ABI status=3 used by checked bounds helpers.
			b.movImm64(0, 0)
			b.fmovDX(0, 31)
			b.movImm64(17, 3)
			b.strReg(16, 17)
			if err := b.adjustSP(spillBytes); err != nil {
				return nil, err
			}
			b.ret()
		default:
			return nil, fmt.Errorf("arm64 cfg machine: unsupported terminator %q in block %d", block.Terminator.Op, bi)
		}
	}

	overflowOffset := len(b.words)
	b.movImm64(0, 0)
	b.fmovDX(0, 31)
	b.movImm64(17, 1)
	b.strReg(16, 17)
	if err := b.adjustSP(spillBytes); err != nil {
		return nil, err
	}
	b.ret()
	for _, fixup := range b.overflowFixups {
		if err := b.patchCondBranch(fixup, overflowOffset); err != nil {
			return nil, err
		}
	}
	for _, fixup := range fixups {
		if fixup.target < 0 || fixup.target >= len(blockOffsets) || blockOffsets[fixup.target] < 0 {
			return nil, fmt.Errorf("arm64 cfg machine: invalid branch target %d", fixup.target)
		}
		if err := b.patchBranch(fixup.wordIndex, blockOffsets[fixup.target]); err != nil {
			return nil, err
		}
	}

	code := make([]byte, len(b.words)*4)
	for i, word := range b.words {
		binary.LittleEndian.PutUint32(code[i*4:], word)
	}
	if len(code) == 0 || len(code) > MaxARM64LeafCodeBytes {
		return nil, fmt.Errorf("arm64 cfg machine: invalid code size %d", len(code))
	}
	return code, nil
}

// EmitARM64CFGMachineModule emits a closed set of GPR CFG functions into one
// AArch64 code blob. Entry is placed at word offset zero and BL targets are
// patched after all function offsets are known.
func EmitARM64CFGMachineModule(functions []SSAFunction, plans map[string]SSARegisterPlan, entry string) ([]byte, error) {
	result, err := emitARM64CFGMachineModuleMode(functions, plans, entry, false)
	if err != nil {
		return nil, err
	}
	if len(result.RuntimeFixups) != 0 {
		return nil, fmt.Errorf("arm64 cfg machine module: unexpected process runtime fixups")
	}
	return result.Code, nil
}

type ARM64ProcessRuntimeFixup struct {
	WordIndex int
	Helper    string
}

type ARM64ProcessMachineCode struct {
	Code             []byte
	RuntimeFixups    []ARM64ProcessRuntimeFixup
	Data             []byte
	RuntimeDataBytes int
	StorageDataBytes int
}

func EmitARM64CFGMachineProcessModule(functions []SSAFunction, plans map[string]SSARegisterPlan, entry string) (ARM64ProcessMachineCode, error) {
	return emitARM64CFGMachineModuleMode(functions, plans, entry, true)
}

func emitARM64CFGMachineModuleMode(functions []SSAFunction, plans map[string]SSARegisterPlan, entry string, allowProcessIO bool) (ARM64ProcessMachineCode, error) {
	if len(functions) == 0 {
		return ARM64ProcessMachineCode{}, fmt.Errorf("arm64 cfg machine module: no functions")
	}
	byName := make(map[string]SSAFunction, len(functions))
	for _, f := range functions {
		if f.Name == "" {
			return ARM64ProcessMachineCode{}, fmt.Errorf("arm64 cfg machine module: empty function name")
		}
		if _, exists := byName[f.Name]; exists {
			return ARM64ProcessMachineCode{}, fmt.Errorf("arm64 cfg machine module: duplicate function %q", f.Name)
		}
		byName[f.Name] = f
	}
	entryFunction, ok := byName[entry]
	if !ok {
		return ARM64ProcessMachineCode{}, fmt.Errorf("arm64 cfg machine module: entry %q not found", entry)
	}
	if err := validateARM64CFGMachineCalls(byName, entry); err != nil {
		return ARM64ProcessMachineCode{}, err
	}
	ordered := make([]SSAFunction, 0, len(functions))
	ordered = append(ordered, entryFunction)
	for _, f := range functions {
		if f.Name != entry {
			ordered = append(ordered, f)
		}
	}

	offsets := make(map[string]int, len(ordered)) // word offsets
	type pendingCall struct {
		wordIndex int
		callee    string
	}
	pending := make([]pendingCall, 0)
	code := make([]byte, 0)
	for _, f := range ordered {
		plan, ok := plans[f.Name]
		if !ok {
			return ARM64ProcessMachineCode{}, fmt.Errorf("arm64 cfg machine module: missing register plan for %s", f.Name)
		}
		offsets[f.Name] = len(code) / 4
		var functionCode []byte
		var calls []arm64CallFixup
		var err error
		if arm64MachineHasCalls(f) || allowProcessIO && arm64MachineHasProcessIO(f) {
			functionCode, calls, err = emitARM64CFGMachineCallsFunction(f, plan, allowProcessIO)
		} else {
			functionCode, err = EmitARM64CFGMachineCode(f, plan)
		}
		if err != nil {
			return ARM64ProcessMachineCode{}, fmt.Errorf("arm64 cfg machine module %s: %w", f.Name, err)
		}
		baseWords := len(code) / 4
		code = append(code, functionCode...)
		for _, call := range calls {
			pending = append(pending, pendingCall{wordIndex: baseWords + call.wordIndex, callee: call.callee})
		}
		if len(code) > MaxARM64LeafCodeBytes {
			return ARM64ProcessMachineCode{}, fmt.Errorf("arm64 cfg machine module: code size exceeds limit")
		}
	}
	runtimeFixups := make([]ARM64ProcessRuntimeFixup, 0)
	for _, call := range pending {
		target, ok := offsets[call.callee]
		if !ok {
			if allowProcessIO && arm64ProcessRuntimeHelper(call.callee) {
				runtimeFixups = append(runtimeFixups, ARM64ProcessRuntimeFixup{WordIndex: call.wordIndex, Helper: call.callee})
				continue
			}
			return ARM64ProcessMachineCode{}, fmt.Errorf("arm64 cfg machine module: unresolved callee %q", call.callee)
		}
		if err := patchARM64BL(code, call.wordIndex, target); err != nil {
			return ARM64ProcessMachineCode{}, err
		}
	}
	if len(code) == 0 || len(code)%4 != 0 {
		return ARM64ProcessMachineCode{}, fmt.Errorf("arm64 cfg machine module: invalid code size")
	}
	return ARM64ProcessMachineCode{Code: code, RuntimeFixups: runtimeFixups}, nil
}

func arm64MachineHasCalls(f SSAFunction) bool {
	for _, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		for _, ins := range block.Instructions {
			if ins.Op == "call" {
				return true
			}
		}
	}
	return false
}

func arm64MachineHasProcessIO(f SSAFunction) bool {
	for _, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		for _, ins := range block.Instructions {
			if ins.Op == "io.stdout" || ins.Op == "io.stderr" || ins.Op == "clock.read" || ins.Op == "rng.sample" || ins.Op == "fs.read" || ins.Op == "fs.write" || ins.Op == "bytes.get" || ins.Op == "net.connect" || ins.Op == "net.fetch" || ins.Op == "process.exec" ||
				ins.Op == "storage.alloc_u64" || ins.Op == "storage.load_u64" || ins.Op == "storage.store_u64" || ins.Op == "storage.free" || ins.Op == "bytes.from_storage_u64" {
				return true
			}
		}
	}
	return false
}

func validateARM64CFGMachineCalls(functions map[string]SSAFunction, entry string) error {
	state := make(map[string]uint8, len(functions))
	var visit func(string) error
	visit = func(name string) error {
		switch state[name] {
		case 1:
			return fmt.Errorf("arm64 cfg machine module: recursive call cycle at %s", name)
		case 2:
			return nil
		}
		caller := functions[name]
		for value, typ := range caller.ValueTypes {
			if typ == F64 || !arm64MachineCallType(typ) {
				return fmt.Errorf("arm64 cfg machine module: %s value %d type %s is unsupported", name, value, typ)
			}
		}
		state[name] = 1
		for bi, block := range caller.Blocks {
			if !block.Reachable {
				continue
			}
			for ii, ins := range block.Instructions {
				if ins.Op != "call" {
					continue
				}
				callee, ok := functions[ins.Callee]
				if !ok {
					return fmt.Errorf("arm64 cfg machine module: %s block %d instruction %d calls unknown %q", name, bi, ii, ins.Callee)
				}
				if ins.Dest < 0 || int(ins.Dest) >= len(caller.ValueTypes) || len(ins.Args) != len(callee.Params) {
					return fmt.Errorf("arm64 cfg machine module: %s -> %s signature mismatch", name, ins.Callee)
				}
				gprArgs, fpArgs := 0, 0
				for _, param := range callee.Params {
					if callee.ValueTypes[param] == IEEE64 {
						fpArgs++
					} else {
						gprArgs++
					}
				}
				if gprArgs > 7 || fpArgs > 8 {
					return fmt.Errorf("arm64 cfg machine module: %s -> %s argument registers exceeded", name, ins.Callee)
				}
				if caller.ValueTypes[ins.Dest] != callee.Result || !arm64MachineCallType(callee.Result) {
					return fmt.Errorf("arm64 cfg machine module: %s -> %s result type mismatch", name, ins.Callee)
				}
				for i, arg := range ins.Args {
					if arg < 0 || int(arg) >= len(caller.ValueTypes) {
						return fmt.Errorf("arm64 cfg machine module: %s -> %s invalid argument %d", name, ins.Callee, i)
					}
					param := callee.Params[i]
					if param < 0 || int(param) >= len(callee.ValueTypes) {
						return fmt.Errorf("arm64 cfg machine module: %s invalid parameter %d", ins.Callee, i)
					}
					if caller.ValueTypes[arg] != callee.ValueTypes[param] || !arm64MachineCallType(callee.ValueTypes[param]) {
						return fmt.Errorf("arm64 cfg machine module: %s -> %s argument %d type mismatch", name, ins.Callee, i)
					}
				}
				if err := visit(ins.Callee); err != nil {
					return err
				}
			}
		}
		state[name] = 2
		return nil
	}
	if err := visit(entry); err != nil {
		return err
	}
	for name := range functions {
		if state[name] == 0 {
			return fmt.Errorf("arm64 cfg machine module: function %s is not reachable from entry %s", name, entry)
		}
	}
	return nil
}

func arm64MachineCallType(t Type) bool {
	return t == I64 || t == U64 || t == Bool || t == IEEE64 || t == Bytes
}

type arm64MachineCallFrame struct {
	spillBytes       int
	statusPtrOffset  int
	callStatusOffset int
	callSaveGPRBase  int
	callSaveFPBase   int
	fpSaveCount      int
	// linkOffset holds the caller's x30. Every BL in the body overwrites x30,
	// so non-leaf functions must reload it before RET.
	linkOffset int
	frameBytes int
}

func arm64MachineCallFrameFor(f SSAFunction, plan SSARegisterPlan) arm64MachineCallFrame {
	spillBytes := (arm64GPRSpillBytes(f, plan) + arm64FPSpillBytes(f, plan) + 15) &^ 15
	statusPtrOffset := spillBytes
	callStatusOffset := spillBytes + 8
	callSaveGPRBase := spillBytes + 16
	callSaveFPBase := callSaveGPRBase + len(arm64MachineRegisters)*8
	fpSaveCount := plan.FPUsed
	if fpSaveCount > len(arm64MachineFPRegisters) {
		fpSaveCount = len(arm64MachineFPRegisters)
	}
	linkOffset := callSaveFPBase + fpSaveCount*8
	frameBytes := (linkOffset + 8 + 15) &^ 15
	return arm64MachineCallFrame{
		spillBytes:       spillBytes,
		statusPtrOffset:  statusPtrOffset,
		callStatusOffset: callStatusOffset,
		callSaveGPRBase:  callSaveGPRBase,
		callSaveFPBase:   callSaveFPBase,
		fpSaveCount:      fpSaveCount,
		linkOffset:       linkOffset,
		frameBytes:       frameBytes,
	}
}

func emitARM64CFGMachineCallsFunction(f SSAFunction, plan SSARegisterPlan, allowProcessIO bool) ([]byte, []arm64CallFixup, error) {
	if len(plan.Locations) != len(f.ValueTypes) {
		return nil, nil, fmt.Errorf("arm64 cfg machine calls: register plan/value count mismatch")
	}
	gprParams, fpParams := arm64ParamCounts(f)
	if gprParams >= len(arm64ArgRegisters) || fpParams > len(arm64FPArgRegisters) {
		return nil, nil, fmt.Errorf("arm64 cfg machine calls: parameter registers exceeded")
	}
	for value, typ := range f.ValueTypes {
		if typ == F64 || !arm64MachineCallType(typ) {
			return nil, nil, fmt.Errorf("arm64 cfg machine calls: value %d type %s is unsupported", value, typ)
		}
		loc := plan.Locations[value]
		limit := len(arm64MachineRegisters)
		if registerClass(typ) == RegisterFP {
			limit = len(arm64MachineFPRegisters)
		}
		if loc.Spill < 0 && (loc.Register < 0 || loc.Register >= limit) {
			return nil, nil, fmt.Errorf("arm64 cfg machine calls: invalid allocation for value %d", value)
		}
	}

	b := &arm64MachineBuilder{}
	b.movRegReg(16, gprParams)
	layout := arm64MachineCallFrameFor(f, plan)
	if err := b.adjustSP(-layout.frameBytes); err != nil {
		return nil, nil, err
	}
	if err := b.strRegSP(30, layout.linkOffset); err != nil {
		return nil, nil, err
	}
	// epilogue restores the caller's link register and frame before RET.
	epilogue := func() error {
		if err := b.ldrRegSP(30, layout.linkOffset); err != nil {
			return err
		}
		if err := b.adjustSP(layout.frameBytes); err != nil {
			return err
		}
		b.ret()
		return nil
	}
	if err := b.strRegSP(16, layout.statusPtrOffset); err != nil {
		return nil, nil, err
	}
	gprIndex, fpIndex := 0, 0
	for _, value := range f.Params {
		if registerClass(f.ValueTypes[value]) == RegisterFP {
			src := fpIndex
			fpIndex++
			if !ssaValueUsed(f, value) {
				continue
			}
			loc := plan.Locations[value]
			if loc.Spill >= 0 {
				if err := b.strDSp(src, arm64MachineFPSpillOffset(f, plan, loc.Spill)); err != nil {
					return nil, nil, err
				}
			} else {
				dst := arm64PhysicalMachineFPReg(plan, value)
				if dst != src {
					b.fmovD(dst, src)
				}
			}
		} else {
			src := gprIndex
			gprIndex++
			if !ssaValueUsed(f, value) {
				continue
			}
			loc := plan.Locations[value]
			if loc.Spill >= 0 {
				if err := b.strRegSP(src, loc.Spill*8); err != nil {
					return nil, nil, err
				}
			} else {
				dst := arm64PhysicalMachineReg(plan, value)
				if dst != src {
					b.movRegReg(dst, src)
				}
			}
		}
	}

	blockOffsets := make([]int, len(f.Blocks))
	for i := range blockOffsets {
		blockOffsets[i] = -1
	}
	fixups := make([]arm64BlockFixup, 0)
	for bi, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		blockOffsets[bi] = len(b.words)
		for _, ins := range block.Instructions {
			if ins.Op == "call" {
				if err := emitARM64MachineCall(b, f, plan, ins, layout); err != nil {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls block %d: %w", bi, err)
				}
				continue
			}
			if ins.Op == "io.stdout" || ins.Op == "io.stderr" {
				if !allowProcessIO {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls: process IO requires standalone process backend")
				}
				if err := emitARM64MachineProcessIO(b, f, plan, ins, layout); err != nil {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls block %d: %w", bi, err)
				}
				continue
			}
			if ins.Op == "clock.read" {
				if !allowProcessIO {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls: clock.read requires standalone process backend")
				}
				if err := emitARM64MachineClock(b, f, plan, ins, layout); err != nil {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls block %d: %w", bi, err)
				}
				continue
			}
			if ins.Op == "rng.sample" {
				if !allowProcessIO {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls: rng.sample requires standalone process backend")
				}
				if err := emitARM64MachineRNG(b, f, plan, ins, layout); err != nil {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls block %d: %w", bi, err)
				}
				continue
			}
			if ins.Op == "fs.write" {
				if !allowProcessIO {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls: fs.write requires standalone process backend")
				}
				if err := emitARM64MachineFSWrite(b, f, plan, ins, layout); err != nil {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls block %d: %w", bi, err)
				}
				continue
			}
			if ins.Op == "fs.read" {
				if !allowProcessIO {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls: fs.read requires standalone process backend")
				}
				if err := emitARM64MachineFSRead(b, f, plan, ins, layout); err != nil {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls block %d: %w", bi, err)
				}
				continue
			}
			if ins.Op == "net.connect" {
				if !allowProcessIO {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls: net.connect requires standalone process backend")
				}
				if err := emitARM64MachineNetConnect(b, f, plan, ins, layout); err != nil {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls block %d: %w", bi, err)
				}
				continue
			}
			if ins.Op == "net.fetch" {
				if !allowProcessIO {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls: net.fetch requires standalone process backend")
				}
				if err := emitARM64MachineNetFetch(b, f, plan, ins, layout); err != nil {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls block %d: %w", bi, err)
				}
				continue
			}
			if ins.Op == "process.exec" {
				if !allowProcessIO {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls: process.exec requires standalone process backend")
				}
				return nil, nil, fmt.Errorf("arm64 cfg machine calls: process.exec runtime is not implemented")
			}
			if ins.Op == "bytes.get" {
				if !allowProcessIO {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls: bytes.get requires standalone process backend")
				}
				if err := emitARM64MachineBytesGet(b, f, plan, ins, layout); err != nil {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls block %d: %w", bi, err)
				}
				continue
			}
			if ins.Op == "storage.alloc_u64" || ins.Op == "storage.load_u64" || ins.Op == "storage.store_u64" || ins.Op == "storage.free" || ins.Op == "bytes.from_storage_u64" {
				if !allowProcessIO {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls: %s requires standalone process backend", ins.Op)
				}
				if err := emitARM64MachineStorage(b, f, plan, ins, layout); err != nil {
					return nil, nil, fmt.Errorf("arm64 cfg machine calls block %d: %w", bi, err)
				}
				continue
			}
			var err error
			if registerClass(f.ValueTypes[ins.Dest]) == RegisterFP ||
				(len(ins.Args) > 0 && registerClass(f.ValueTypes[ins.Args[0]]) == RegisterFP) {
				err = b.emitFPInstruction(f, plan, ins)
			} else {
				err = b.emitInstruction(f, plan, ins)
			}
			if err != nil {
				return nil, nil, fmt.Errorf("arm64 cfg machine calls block %d: %w", bi, err)
			}
		}
		switch block.Terminator.Op {
		case "return":
			if block.Terminator.Value >= 0 {
				value := block.Terminator.Value
				loc := plan.Locations[value]
				if registerClass(f.ValueTypes[value]) == RegisterFP {
					if loc.Spill >= 0 {
						if err := b.ldrDSp(0, arm64MachineFPSpillOffset(f, plan, loc.Spill)); err != nil {
							return nil, nil, err
						}
					} else {
						result := arm64PhysicalMachineFPReg(plan, value)
						if result != 0 {
							b.fmovD(0, result)
						}
					}
				} else {
					if loc.Spill >= 0 {
						if err := b.ldrRegSP(0, loc.Spill*8); err != nil {
							return nil, nil, err
						}
					} else {
						result := arm64PhysicalMachineReg(plan, value)
						if result != 0 {
							b.movRegReg(0, result)
						}
					}
				}
			} else {
				b.movImm64(0, 0)
			}
			if err := b.ldrRegSP(16, layout.statusPtrOffset); err != nil {
				return nil, nil, err
			}
			b.movImm64(17, 0)
			b.strReg(16, 17)
			if err := epilogue(); err != nil {
				return nil, nil, err
			}
		case "jump":
			if len(block.Terminator.Targets) != 1 {
				return nil, nil, fmt.Errorf("arm64 cfg machine calls: block %d invalid jump", bi)
			}
			target := block.Terminator.Targets[0]
			if err := emitARM64MachineLivePhiCopies(b, f, plan, bi, target); err != nil {
				return nil, nil, err
			}
			fixups = append(fixups, arm64BlockFixup{wordIndex: b.branchPlaceholder(), target: target})
		case "branch":
			if len(block.Terminator.Targets) != 2 || block.Terminator.Value < 0 {
				return nil, nil, fmt.Errorf("arm64 cfg machine calls: block %d invalid branch", bi)
			}
			condLoc := plan.Locations[block.Terminator.Value]
			cond := 7
			if condLoc.Spill >= 0 {
				if err := b.ldrRegSP(cond, condLoc.Spill*8); err != nil {
					return nil, nil, err
				}
			} else {
				cond = arm64PhysicalMachineReg(plan, block.Terminator.Value)
			}
			falseEdge := b.cbzPlaceholder(cond)
			trueTarget := block.Terminator.Targets[0]
			if err := emitARM64MachineLivePhiCopies(b, f, plan, bi, trueTarget); err != nil {
				return nil, nil, err
			}
			fixups = append(fixups, arm64BlockFixup{wordIndex: b.branchPlaceholder(), target: trueTarget})
			falseOffset := len(b.words)
			if err := b.patchCBZ(falseEdge, falseOffset); err != nil {
				return nil, nil, err
			}
			falseTarget := block.Terminator.Targets[1]
			if err := emitARM64MachineLivePhiCopies(b, f, plan, bi, falseTarget); err != nil {
				return nil, nil, err
			}
			fixups = append(fixups, arm64BlockFixup{wordIndex: b.branchPlaceholder(), target: falseTarget})
		case "unreachable":
			b.movImm64(0, 0)
			b.fmovDX(0, 31)
			if err := b.ldrRegSP(16, layout.statusPtrOffset); err != nil {
				return nil, nil, err
			}
			b.movImm64(17, 3)
			b.strReg(16, 17)
			if err := epilogue(); err != nil {
				return nil, nil, err
			}
		default:
			return nil, nil, fmt.Errorf("arm64 cfg machine calls: unsupported terminator %q", block.Terminator.Op)
		}
	}

	overflowOffset := len(b.words)
	b.movImm64(0, 0)
	b.fmovDX(0, 31)
	if err := b.ldrRegSP(16, layout.statusPtrOffset); err != nil {
		return nil, nil, err
	}
	b.movImm64(17, 1)
	b.strReg(16, 17)
	if err := epilogue(); err != nil {
		return nil, nil, err
	}
	ioFailureOffset := len(b.words)
	b.movImm64(0, 0)
	b.fmovDX(0, 31)
	if err := b.ldrRegSP(16, layout.statusPtrOffset); err != nil {
		return nil, nil, err
	}
	b.movImm64(17, 2)
	b.strReg(16, 17)
	if err := epilogue(); err != nil {
		return nil, nil, err
	}
	boundsFailureOffset := len(b.words)
	b.movImm64(0, 0)
	b.fmovDX(0, 31)
	if err := b.ldrRegSP(16, layout.statusPtrOffset); err != nil {
		return nil, nil, err
	}
	b.movImm64(17, 3)
	b.strReg(16, 17)
	if err := epilogue(); err != nil {
		return nil, nil, err
	}
	for _, fixup := range b.overflowFixups {
		if err := b.patchCondBranch(fixup, overflowOffset); err != nil {
			return nil, nil, err
		}
	}
	for _, fixup := range b.ioFailureFixups {
		if err := b.patchCondBranch(fixup, ioFailureOffset); err != nil {
			return nil, nil, err
		}
	}
	for _, fixup := range b.boundsFailureFixups {
		if err := b.patchCondBranch(fixup, boundsFailureOffset); err != nil {
			return nil, nil, err
		}
	}
	for _, fixup := range fixups {
		if fixup.target < 0 || fixup.target >= len(blockOffsets) || blockOffsets[fixup.target] < 0 {
			return nil, nil, fmt.Errorf("arm64 cfg machine calls: invalid branch target %d", fixup.target)
		}
		if err := b.patchBranch(fixup.wordIndex, blockOffsets[fixup.target]); err != nil {
			return nil, nil, err
		}
	}
	code := make([]byte, len(b.words)*4)
	for i, word := range b.words {
		binary.LittleEndian.PutUint32(code[i*4:], word)
	}
	return code, append([]arm64CallFixup(nil), b.callFixups...), nil
}

func emitARM64MachineClock(b *arm64MachineBuilder, f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, layout arm64MachineCallFrame) error {
	if ins.Dest < 0 || int(ins.Dest) >= len(f.ValueTypes) || f.ValueTypes[ins.Dest] != U64 || len(ins.Args) != 0 {
		return fmt.Errorf("arm64 process clock: invalid clock.read instruction")
	}
	for i := range arm64MachineRegisters {
		if err := b.strRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.strDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	b.callFixups = append(b.callFixups, arm64CallFixup{wordIndex: b.blPlaceholder(), callee: "__swyp_rt_clock_u64"})
	b.movRegReg(6, 0) // value
	b.movRegReg(7, 1) // helper status
	for i := range arm64MachineRegisters {
		if err := b.ldrRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.ldrDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	loc := plan.Locations[ins.Dest]
	if loc.Spill >= 0 {
		if err := b.strRegSP(6, loc.Spill*8); err != nil {
			return err
		}
	} else {
		dst := arm64PhysicalMachineReg(plan, ins.Dest)
		if dst != 6 {
			b.movRegReg(dst, 6)
		}
	}
	b.cmpRegReg(7, 31)
	b.ioFailureFixups = append(b.ioFailureFixups, b.condBranchPlaceholder(0x1)) // NE
	return nil
}

func emitARM64MachineRNG(b *arm64MachineBuilder, f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, layout arm64MachineCallFrame) error {
	if ins.Dest < 0 || int(ins.Dest) >= len(f.ValueTypes) || f.ValueTypes[ins.Dest] != U64 || len(ins.Args) != 0 {
		return fmt.Errorf("arm64 process rng: invalid rng.sample instruction")
	}
	for i := range arm64MachineRegisters {
		if err := b.strRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.strDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	b.callFixups = append(b.callFixups, arm64CallFixup{wordIndex: b.blPlaceholder(), callee: "__swyp_rt_rng_u64"})
	b.movRegReg(6, 0)
	b.movRegReg(7, 1)
	for i := range arm64MachineRegisters {
		if err := b.ldrRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.ldrDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	loc := plan.Locations[ins.Dest]
	if loc.Spill >= 0 {
		if err := b.strRegSP(6, loc.Spill*8); err != nil {
			return err
		}
	} else {
		dst := arm64PhysicalMachineReg(plan, ins.Dest)
		if dst != 6 {
			b.movRegReg(dst, 6)
		}
	}
	b.cmpRegReg(7, 31)
	b.ioFailureFixups = append(b.ioFailureFixups, b.condBranchPlaceholder(0x1))
	return nil
}

func emitARM64MachineProcessIO(b *arm64MachineBuilder, f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, layout arm64MachineCallFrame) error {
	if len(ins.Args) != 1 {
		return fmt.Errorf("arm64 process IO: %s requires one operand", ins.Op)
	}
	value := ins.Args[0]
	if value < 0 || int(value) >= len(f.ValueTypes) {
		return fmt.Errorf("arm64 process IO: invalid operand")
	}
	t := f.ValueTypes[value]
	if t != I64 && t != U64 && t != Bool && t != IEEE64 {
		return fmt.Errorf("arm64 process IO: text formatter for %s is not implemented", t)
	}
	for i := range arm64MachineRegisters {
		if err := b.strRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.strDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	loc := plan.Locations[value]
	if t == IEEE64 {
		if loc.Spill >= 0 {
			if err := b.ldrDSp(0, arm64MachineFPSpillOffset(f, plan, loc.Spill)); err != nil {
				return err
			}
			b.fmovXD(0, 0)
		} else {
			b.fmovXD(0, arm64PhysicalMachineFPReg(plan, value))
		}
	} else {
		if loc.Spill >= 0 {
			if err := b.ldrRegSP(0, loc.Spill*8); err != nil {
				return err
			}
		} else {
			src := arm64PhysicalMachineReg(plan, value)
			if src != 0 {
				b.movRegReg(0, src)
			}
		}
	}
	helper := arm64ProcessHelperFor(ins.Op, t)
	b.callFixups = append(b.callFixups, arm64CallFixup{wordIndex: b.blPlaceholder(), callee: helper})
	b.movRegReg(17, 0)
	for i := range arm64MachineRegisters {
		if err := b.ldrRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.ldrDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	b.cmpRegReg(17, 31)
	b.ioFailureFixups = append(b.ioFailureFixups, b.condBranchPlaceholder(0x1)) // NE
	return nil
}

func arm64ProcessHelperFor(op string, t Type) string {
	stream := "stdout"
	if op == "io.stderr" {
		stream = "stderr"
	}
	return "__swyp_rt_" + stream + "_" + string(t)
}

func arm64ProcessRuntimeHelper(name string) bool {
	switch name {
	case "__swyp_rt_stdout_i64", "__swyp_rt_stdout_u64", "__swyp_rt_stdout_bool",
		"__swyp_rt_stdout_ieee64",
		"__swyp_rt_stderr_i64", "__swyp_rt_stderr_u64", "__swyp_rt_stderr_bool", "__swyp_rt_stderr_ieee64",
		"__swyp_rt_clock_u64", "__swyp_rt_rng_u64", "__swyp_rt_fs_read", "__swyp_rt_fs_write", "__swyp_rt_bytes_get", "__swyp_rt_net_connect", "__swyp_rt_net_fetch",
		"__swyp_rt_storage_alloc_u64", "__swyp_rt_storage_load_u64", "__swyp_rt_storage_store_u64", "__swyp_rt_storage_free", "__swyp_rt_bytes_from_storage_u64":
		return true
	default:
		return false
	}
}

func emitARM64MachineStorage(b *arm64MachineBuilder, f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, layout arm64MachineCallFrame) error {
	wantArgs, helper := 0, ""
	result := U64
	switch ins.Op {
	case "storage.alloc_u64":
		wantArgs, helper = 1, "__swyp_rt_storage_alloc_u64"
	case "storage.load_u64":
		wantArgs, helper = 2, "__swyp_rt_storage_load_u64"
	case "storage.store_u64":
		wantArgs, helper = 3, "__swyp_rt_storage_store_u64"
	case "storage.free":
		wantArgs, helper = 1, "__swyp_rt_storage_free"
	case "bytes.from_storage_u64":
		wantArgs, helper, result = 2, "__swyp_rt_bytes_from_storage_u64", Bytes
	default:
		return fmt.Errorf("arm64 storage: unsupported operation %q", ins.Op)
	}
	if len(ins.Args) != wantArgs {
		return fmt.Errorf("arm64 storage: %s requires %d operands", ins.Op, wantArgs)
	}
	for i := range arm64MachineRegisters {
		if err := b.strRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.strDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	for i, value := range ins.Args {
		if value < 0 || int(value) >= len(f.ValueTypes) || f.ValueTypes[value] != U64 {
			return fmt.Errorf("arm64 storage: operand %d must be u64", i)
		}
		loc := plan.Locations[value]
		if loc.Spill >= 0 {
			if err := b.ldrRegSP(i, loc.Spill*8); err != nil {
				return err
			}
		} else {
			src := arm64PhysicalMachineReg(plan, value)
			if src != i {
				b.movRegReg(i, src)
			}
		}
	}
	b.callFixups = append(b.callFixups, arm64CallFixup{wordIndex: b.blPlaceholder(), callee: helper})
	b.movRegReg(6, 0)
	b.movRegReg(7, 1)
	for i := range arm64MachineRegisters {
		if err := b.ldrRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.ldrDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	if ins.Dest >= 0 {
		if int(ins.Dest) >= len(f.ValueTypes) || f.ValueTypes[ins.Dest] != result {
			return fmt.Errorf("arm64 storage: destination must be %s", result)
		}
		loc := plan.Locations[ins.Dest]
		if loc.Spill >= 0 {
			if err := b.strRegSP(6, loc.Spill*8); err != nil {
				return err
			}
		} else {
			dst := arm64PhysicalMachineReg(plan, ins.Dest)
			if dst != 6 {
				b.movRegReg(dst, 6)
			}
		}
	}
	b.cmpRegReg(7, 31)
	b.boundsFailureFixups = append(b.boundsFailureFixups, b.condBranchPlaceholder(0x1))
	return nil
}

func emitARM64MachineNetConnect(b *arm64MachineBuilder, f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, layout arm64MachineCallFrame) error {
	if ins.Dest < 0 || int(ins.Dest) >= len(f.ValueTypes) || f.ValueTypes[ins.Dest] != Bool || len(ins.Args) != 2 {
		return fmt.Errorf("arm64 net.connect: requires IPv4 bytes, u64 port and bool destination")
	}
	for i, value := range ins.Args {
		want := Bytes
		if i == 1 {
			want = U64
		}
		if value < 0 || int(value) >= len(f.ValueTypes) || f.ValueTypes[value] != want {
			return fmt.Errorf("arm64 net.connect: operand %d must be %s", i, want)
		}
	}
	for i := range arm64MachineRegisters {
		if err := b.strRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.strDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	for i, value := range ins.Args {
		loc := plan.Locations[value]
		if loc.Spill >= 0 {
			if err := b.ldrRegSP(i, loc.Spill*8); err != nil {
				return err
			}
		} else {
			src := arm64PhysicalMachineReg(plan, value)
			if src != i {
				b.movRegReg(i, src)
			}
		}
	}
	b.callFixups = append(b.callFixups, arm64CallFixup{wordIndex: b.blPlaceholder(), callee: "__swyp_rt_net_connect"})
	b.movRegReg(6, 0)
	b.movRegReg(7, 1)
	for i := range arm64MachineRegisters {
		if err := b.ldrRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.ldrDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	loc := plan.Locations[ins.Dest]
	if loc.Spill >= 0 {
		if err := b.strRegSP(6, loc.Spill*8); err != nil {
			return err
		}
	} else {
		dst := arm64PhysicalMachineReg(plan, ins.Dest)
		if dst != 6 {
			b.movRegReg(dst, 6)
		}
	}
	b.cmpRegReg(7, 31)
	b.ioFailureFixups = append(b.ioFailureFixups, b.condBranchPlaceholder(0x1))
	return nil
}

func emitARM64MachineNetFetch(b *arm64MachineBuilder, f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, layout arm64MachineCallFrame) error {
	if ins.Dest < 0 || int(ins.Dest) >= len(f.ValueTypes) || f.ValueTypes[ins.Dest] != Bytes || len(ins.Args) != 3 {
		return fmt.Errorf("arm64 net.fetch: requires IPv4 bytes, u64 port, path bytes and bytes destination")
	}
	want := []Type{Bytes, U64, Bytes}
	for i, value := range ins.Args {
		if value < 0 || int(value) >= len(f.ValueTypes) || f.ValueTypes[value] != want[i] {
			return fmt.Errorf("arm64 net.fetch: operand %d must be %s", i, want[i])
		}
	}
	for i := range arm64MachineRegisters {
		if err := b.strRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.strDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	for i, value := range ins.Args {
		loc := plan.Locations[value]
		if loc.Spill >= 0 {
			if err := b.ldrRegSP(i, loc.Spill*8); err != nil {
				return err
			}
		} else {
			src := arm64PhysicalMachineReg(plan, value)
			if src != i {
				b.movRegReg(i, src)
			}
		}
	}
	b.callFixups = append(b.callFixups, arm64CallFixup{wordIndex: b.blPlaceholder(), callee: "__swyp_rt_net_fetch"})
	b.movRegReg(6, 0)
	b.movRegReg(7, 1)
	for i := range arm64MachineRegisters {
		if err := b.ldrRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.ldrDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	dest := plan.Locations[ins.Dest]
	if dest.Spill >= 0 {
		if err := b.strRegSP(6, dest.Spill*8); err != nil {
			return err
		}
	} else {
		dst := arm64PhysicalMachineReg(plan, ins.Dest)
		if dst != 6 {
			b.movRegReg(dst, 6)
		}
	}
	b.cmpRegReg(7, 31)
	b.ioFailureFixups = append(b.ioFailureFixups, b.condBranchPlaceholder(0x1))
	return nil
}

func emitARM64MachineBytesGet(b *arm64MachineBuilder, f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, layout arm64MachineCallFrame) error {
	if ins.Dest < 0 || int(ins.Dest) >= len(f.ValueTypes) || f.ValueTypes[ins.Dest] != U64 || len(ins.Args) != 2 {
		return fmt.Errorf("arm64 bytes.get: invalid instruction")
	}
	for i := range arm64MachineRegisters {
		if err := b.strRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.strDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	for i, value := range ins.Args {
		want := Bytes
		if i == 1 {
			want = U64
		}
		if value < 0 || int(value) >= len(f.ValueTypes) || f.ValueTypes[value] != want {
			return fmt.Errorf("arm64 bytes.get: operand %d must be %s", i, want)
		}
		loc := plan.Locations[value]
		if loc.Spill >= 0 {
			if err := b.ldrRegSP(i, loc.Spill*8); err != nil {
				return err
			}
		} else {
			src := arm64PhysicalMachineReg(plan, value)
			if src != i {
				b.movRegReg(i, src)
			}
		}
	}
	b.callFixups = append(b.callFixups, arm64CallFixup{wordIndex: b.blPlaceholder(), callee: "__swyp_rt_bytes_get"})
	b.movRegReg(6, 0)
	b.movRegReg(7, 1)
	for i := range arm64MachineRegisters {
		if err := b.ldrRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.ldrDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	loc := plan.Locations[ins.Dest]
	if loc.Spill >= 0 {
		if err := b.strRegSP(6, loc.Spill*8); err != nil {
			return err
		}
	} else {
		dst := arm64PhysicalMachineReg(plan, ins.Dest)
		if dst != 6 {
			b.movRegReg(dst, 6)
		}
	}
	b.cmpRegReg(7, 31)
	b.boundsFailureFixups = append(b.boundsFailureFixups, b.condBranchPlaceholder(0x1))
	return nil
}

func emitARM64MachineFSRead(b *arm64MachineBuilder, f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, layout arm64MachineCallFrame) error {
	if ins.Dest < 0 || int(ins.Dest) >= len(f.ValueTypes) || f.ValueTypes[ins.Dest] != Bytes || len(ins.Args) != 1 {
		return fmt.Errorf("arm64 fs.read: requires path bytes and bytes destination")
	}
	value := ins.Args[0]
	if value < 0 || int(value) >= len(f.ValueTypes) || f.ValueTypes[value] != Bytes {
		return fmt.Errorf("arm64 fs.read: path must be bytes")
	}
	for i := range arm64MachineRegisters {
		if err := b.strRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.strDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	loc := plan.Locations[value]
	if loc.Spill >= 0 {
		if err := b.ldrRegSP(0, loc.Spill*8); err != nil {
			return err
		}
	} else {
		src := arm64PhysicalMachineReg(plan, value)
		if src != 0 {
			b.movRegReg(0, src)
		}
	}
	b.callFixups = append(b.callFixups, arm64CallFixup{wordIndex: b.blPlaceholder(), callee: "__swyp_rt_fs_read"})
	b.movRegReg(6, 0)
	b.movRegReg(7, 1)
	for i := range arm64MachineRegisters {
		if err := b.ldrRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.ldrDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	dest := plan.Locations[ins.Dest]
	if dest.Spill >= 0 {
		if err := b.strRegSP(6, dest.Spill*8); err != nil {
			return err
		}
	} else {
		dst := arm64PhysicalMachineReg(plan, ins.Dest)
		if dst != 6 {
			b.movRegReg(dst, 6)
		}
	}
	b.cmpRegReg(7, 31)
	b.ioFailureFixups = append(b.ioFailureFixups, b.condBranchPlaceholder(0x1))
	return nil
}

func emitARM64MachineFSWrite(b *arm64MachineBuilder, f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, layout arm64MachineCallFrame) error {
	if len(ins.Args) != 2 {
		return fmt.Errorf("arm64 fs.write: requires path and data operands")
	}
	for i := range arm64MachineRegisters {
		if err := b.strRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.strDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	for i, value := range ins.Args {
		if value < 0 || int(value) >= len(f.ValueTypes) || f.ValueTypes[value] != Bytes {
			return fmt.Errorf("arm64 fs.write: operand %d must be bytes", i)
		}
		loc := plan.Locations[value]
		if loc.Spill >= 0 {
			if err := b.ldrRegSP(i, loc.Spill*8); err != nil {
				return err
			}
		} else {
			src := arm64PhysicalMachineReg(plan, value)
			if src != i {
				b.movRegReg(i, src)
			}
		}
	}
	b.callFixups = append(b.callFixups, arm64CallFixup{wordIndex: b.blPlaceholder(), callee: "__swyp_rt_fs_write"})
	b.movRegReg(17, 0)
	for i := range arm64MachineRegisters {
		if err := b.ldrRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.ldrDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	b.cmpRegReg(17, 31)
	b.ioFailureFixups = append(b.ioFailureFixups, b.condBranchPlaceholder(0x1))
	return nil
}

func emitARM64MachineCall(b *arm64MachineBuilder, f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, layout arm64MachineCallFrame) error {
	if ins.Dest < 0 || int(ins.Dest) >= len(f.ValueTypes) || ins.Callee == "" {
		return fmt.Errorf("invalid call")
	}
	if !arm64MachineCallType(f.ValueTypes[ins.Dest]) {
		return fmt.Errorf("unsupported result type %s", f.ValueTypes[ins.Dest])
	}
	for i := range arm64MachineRegisters {
		if err := b.strRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.strDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	gprIndex, fpIndex := 0, 0
	for i, value := range ins.Args {
		if !arm64MachineCallType(f.ValueTypes[value]) {
			return fmt.Errorf("argument %d type %s is unsupported", i, f.ValueTypes[value])
		}
		loc := plan.Locations[value]
		if f.ValueTypes[value] == IEEE64 {
			dstArg := fpIndex
			fpIndex++
			if dstArg >= len(arm64FPArgRegisters) {
				return fmt.Errorf("too many FP arguments")
			}
			if loc.Spill >= 0 {
				if err := b.ldrDSp(dstArg, arm64MachineFPSpillOffset(f, plan, loc.Spill)); err != nil {
					return err
				}
			} else {
				src := arm64PhysicalMachineFPReg(plan, value)
				if src != dstArg {
					b.fmovD(dstArg, src)
				}
			}
		} else {
			dstArg := gprIndex
			gprIndex++
			if dstArg >= 7 {
				return fmt.Errorf("too many GPR arguments")
			}
			if loc.Spill >= 0 {
				if err := b.ldrRegSP(dstArg, loc.Spill*8); err != nil {
					return err
				}
			} else {
				src := arm64PhysicalMachineReg(plan, value)
				if src != dstArg {
					b.movRegReg(dstArg, src)
				}
			}
		}
	}
	if err := b.addRegSPAddress(gprIndex, layout.callStatusOffset); err != nil {
		return err
	}
	b.callFixups = append(b.callFixups, arm64CallFixup{wordIndex: b.blPlaceholder(), callee: ins.Callee})
	if err := b.ldrRegSP(17, layout.callStatusOffset); err != nil {
		return err
	}
	if err := b.ldrRegSP(16, layout.statusPtrOffset); err != nil {
		return err
	}
	b.cmpRegReg(17, 31)
	b.branchCondPlaceholder(0x1) // NE -> overflow
	for i := range arm64MachineRegisters {
		if err := b.ldrRegSP(arm64MachineRegisters[i], layout.callSaveGPRBase+i*8); err != nil {
			return err
		}
	}
	for i := 0; i < layout.fpSaveCount; i++ {
		if err := b.ldrDSp(arm64MachineFPRegisters[i], layout.callSaveFPBase+i*8); err != nil {
			return err
		}
	}
	destLoc := plan.Locations[ins.Dest]
	if f.ValueTypes[ins.Dest] == IEEE64 {
		if destLoc.Spill >= 0 {
			return b.strDSp(0, arm64MachineFPSpillOffset(f, plan, destLoc.Spill))
		}
		dst := arm64PhysicalMachineFPReg(plan, ins.Dest)
		if dst != 0 {
			b.fmovD(dst, 0)
		}
		return nil
	}
	if destLoc.Spill >= 0 {
		return b.strRegSP(0, destLoc.Spill*8)
	}
	dst := arm64PhysicalMachineReg(plan, ins.Dest)
	if dst != 0 {
		b.movRegReg(dst, 0)
	}
	return nil
}

func patchARM64BL(code []byte, wordIndex, target int) error {
	rel := target - wordIndex
	if rel < -(1<<25) || rel >= 1<<25 {
		return fmt.Errorf("arm64 cfg machine module: BL out of range")
	}
	binary.LittleEndian.PutUint32(code[wordIndex*4:], 0x94000000|uint32(rel&0x03ffffff))
	return nil
}

func emitARM64MachinePhiCopies(b *arm64MachineBuilder, f SSAFunction, plan SSARegisterPlan, predecessor, target int) error {
	if target < 0 || target >= len(f.Blocks) || !f.Blocks[target].Reachable {
		return fmt.Errorf("arm64 cfg machine: invalid edge %d -> %d", predecessor, target)
	}
	type copyLoc struct {
		reg     int
		spill   int
		class   RegisterClass
		scratch bool
	}
	type move struct{ dst, src copyLoc }
	fromLocation := func(value SSAValue, loc RegisterLocation) copyLoc {
		class := registerClass(f.ValueTypes[value])
		if loc.Spill >= 0 {
			return copyLoc{reg: -1, spill: loc.Spill, class: class}
		}
		if class == RegisterFP {
			return copyLoc{reg: arm64MachineFPRegisters[loc.Register], spill: -1, class: class}
		}
		return copyLoc{reg: arm64MachineRegisters[loc.Register], spill: -1, class: class}
	}
	sameLoc := func(a, c copyLoc) bool {
		if a.class != c.class {
			return false
		}
		if a.scratch || c.scratch {
			return a.scratch && c.scratch
		}
		if a.reg >= 0 || c.reg >= 0 {
			return a.reg == c.reg && a.reg >= 0
		}
		return a.spill == c.spill && a.spill >= 0
	}
	emitLoad := func(dst int, src copyLoc) error {
		if src.class == RegisterFP {
			if src.scratch {
				if dst != 24 {
					b.fmovD(dst, 24)
				}
				return nil
			}
			if src.reg >= 0 {
				if dst != src.reg {
					b.fmovD(dst, src.reg)
				}
				return nil
			}
			return b.ldrDSp(dst, arm64MachineFPSpillOffset(f, plan, src.spill))
		}
		if src.scratch {
			if dst != 8 {
				b.movRegReg(dst, 8)
			}
			return nil
		}
		if src.reg >= 0 {
			if dst != src.reg {
				b.movRegReg(dst, src.reg)
			}
			return nil
		}
		return b.ldrRegSP(dst, src.spill*8)
	}
	emitCopy := func(dst, src copyLoc) error {
		if dst.class == RegisterFP {
			if dst.reg >= 0 {
				return emitLoad(dst.reg, src)
			}
			if src.scratch {
				return b.strDSp(24, arm64MachineFPSpillOffset(f, plan, dst.spill))
			}
			if src.reg >= 0 {
				return b.strDSp(src.reg, arm64MachineFPSpillOffset(f, plan, dst.spill))
			}
			if err := b.ldrDSp(24, arm64MachineFPSpillOffset(f, plan, src.spill)); err != nil {
				return err
			}
			return b.strDSp(24, arm64MachineFPSpillOffset(f, plan, dst.spill))
		}
		if dst.reg >= 0 {
			return emitLoad(dst.reg, src)
		}
		if src.scratch {
			return b.strRegSP(8, dst.spill*8)
		}
		if src.reg >= 0 {
			return b.strRegSP(src.reg, dst.spill*8)
		}
		if err := b.ldrRegSP(17, src.spill*8); err != nil {
			return err
		}
		return b.strRegSP(17, dst.spill*8)
	}
	moves := make([]move, 0, len(f.Blocks[target].Phis))
	for _, phi := range f.Blocks[target].Phis {
		input := NoSSAValue
		for _, candidate := range phi.Inputs {
			if candidate.Predecessor == predecessor {
				input = candidate.Value
				break
			}
		}
		if input == NoSSAValue {
			return fmt.Errorf("arm64 cfg machine: phi %d has no input from predecessor %d", phi.Dest, predecessor)
		}
		if registerClass(f.ValueTypes[phi.Dest]) != registerClass(f.ValueTypes[input]) {
			return fmt.Errorf("arm64 cfg machine: phi %d class mismatch", phi.Dest)
		}
		dst := fromLocation(phi.Dest, plan.Locations[phi.Dest])
		src := fromLocation(input, plan.Locations[input])
		if !sameLoc(dst, src) {
			moves = append(moves, move{dst: dst, src: src})
		}
	}
	for len(moves) > 0 {
		safe := -1
		for i, candidate := range moves {
			dstUsedAsSource := false
			for _, other := range moves {
				if sameLoc(other.src, candidate.dst) {
					dstUsedAsSource = true
					break
				}
			}
			if !dstUsedAsSource {
				safe = i
				break
			}
		}
		if safe >= 0 {
			m := moves[safe]
			if err := emitCopy(m.dst, m.src); err != nil {
				return err
			}
			moves = append(moves[:safe], moves[safe+1:]...)
			continue
		}
		// A cycle remains. Preserve one source in the class-specific scratch
		// register outside the allocated banks, then make that move acyclic.
		scratch := 8
		if moves[0].src.class == RegisterFP {
			scratch = 24
		}
		if err := emitLoad(scratch, moves[0].src); err != nil {
			return err
		}
		moves[0].src = copyLoc{reg: scratch, spill: -1, class: moves[0].src.class, scratch: true}
	}
	return nil
}

func emitARM64MachineLivePhiCopies(b *arm64MachineBuilder, f SSAFunction, plan SSARegisterPlan, predecessor, target int) error {
	if target < 0 || target >= len(f.Blocks) {
		return emitARM64MachinePhiCopies(b, f, plan, predecessor, target)
	}
	block := f.Blocks[target]
	if len(block.Phis) == 0 {
		return emitARM64MachinePhiCopies(b, f, plan, predecessor, target)
	}
	live := make([]SSAPhi, 0, len(block.Phis))
	for _, phi := range block.Phis {
		if ssaValueUsed(f, phi.Dest) {
			live = append(live, phi)
		}
	}
	if len(live) == len(block.Phis) {
		return emitARM64MachinePhiCopies(b, f, plan, predecessor, target)
	}
	filtered := f
	filtered.Blocks = append([]SSABlock(nil), f.Blocks...)
	block.Phis = live
	filtered.Blocks[target] = block
	return emitARM64MachinePhiCopies(b, filtered, plan, predecessor, target)
}

func (b *arm64MachineBuilder) branchPlaceholder() int {
	index := len(b.words)
	b.append(0x14000000)
	return index
}

func (b *arm64MachineBuilder) adrPlaceholder(dst int) int {
	index := len(b.words)
	b.append(0x10000000 | uint32(dst&31))
	return index
}

func (b *arm64MachineBuilder) patchADR(index, target int) error {
	byteRel := int64(target-index) * 4
	if byteRel < -(1<<20) || byteRel >= 1<<20 {
		return fmt.Errorf("arm64 machine: ADR target out of range")
	}
	imm := uint32(int32(byteRel)) & 0x1fffff
	immlo := imm & 0x3
	immhi := (imm >> 2) & 0x7ffff
	word := b.words[index] & 0x9f00001f
	word |= immlo << 29
	word |= immhi << 5
	b.words[index] = word
	return nil
}

func (b *arm64MachineBuilder) condBranchPlaceholder(cond uint32) int {
	index := len(b.words)
	b.append(0x54000000 | (cond & 0xf))
	return index
}

func (b *arm64MachineBuilder) blPlaceholder() int {
	index := len(b.words)
	b.append(0x94000000)
	return index
}

func (b *arm64MachineBuilder) patchBL(index, target int) error {
	rel := target - index
	if rel < -(1<<25) || rel >= 1<<25 {
		return fmt.Errorf("arm64 cfg machine: BL out of range")
	}
	b.words[index] = 0x94000000 | uint32(rel&0x03ffffff)
	return nil
}

func (b *arm64MachineBuilder) patchBranch(index, target int) error {
	rel := target - index
	if rel < -(1<<25) || rel >= 1<<25 {
		return fmt.Errorf("arm64 cfg machine: branch out of range")
	}
	b.words[index] = 0x14000000 | uint32(rel&0x03ffffff)
	return nil
}

func (b *arm64MachineBuilder) cbzPlaceholder(reg int) int {
	index := len(b.words)
	b.append(0xb4000000 | uint32(reg&31))
	return index
}

// cbnzPlaceholder emits CBNZ; patchCBZ patches it because both share the
// imm19 layout and patchCBZ preserves the opcode bits.
func (b *arm64MachineBuilder) cbnzPlaceholder(reg int) int {
	index := len(b.words)
	b.append(0xb5000000 | uint32(reg&31))
	return index
}

func (b *arm64MachineBuilder) patchCBZ(index, target int) error {
	rel := target - index
	if rel < -(1<<18) || rel >= 1<<18 {
		return fmt.Errorf("arm64 cfg machine: CBZ out of range")
	}
	word := b.words[index] & 0xff00001f
	word |= uint32(rel&0x7ffff) << 5
	b.words[index] = word
	return nil
}

func (b *arm64MachineBuilder) addRegSPAddress(dst, offset int) error {
	if offset < 0 {
		return fmt.Errorf("arm64 cfg machine: negative SP address offset %d", offset)
	}
	first := offset
	if first > 0xfff {
		first = 0xfff
	}
	b.append(0x910003e0 | uint32(first)<<10 | uint32(dst&31))
	remaining := offset - first
	for remaining > 0 {
		chunk := remaining
		if chunk > 0xfff {
			chunk = 0xfff
		}
		b.append(0x91000000 | uint32(chunk)<<10 | uint32(dst&31)<<5 | uint32(dst&31))
		remaining -= chunk
	}
	return nil
}

func (b *arm64MachineBuilder) adjustSP(delta int) error {
	if delta == 0 {
		return nil
	}
	if delta%16 != 0 {
		return fmt.Errorf("arm64 cfg machine: stack adjustment %d is not 16-byte aligned", delta)
	}
	remaining := delta
	for remaining != 0 {
		chunk := remaining
		if chunk > 4080 {
			chunk = 4080
		} else if chunk < -4080 {
			chunk = -4080
		}
		if chunk > 0 {
			b.append(0x910003ff | uint32(chunk)<<10)
			remaining -= chunk
		} else {
			amount := -chunk
			b.append(0xd10003ff | uint32(amount)<<10)
			remaining += amount
		}
	}
	return nil
}

func (b *arm64MachineBuilder) strRegSP(src, offset int) error {
	if offset < 0 || offset%8 != 0 || offset/8 > 0xfff {
		return fmt.Errorf("arm64 cfg machine: spill store offset %d out of range", offset)
	}
	b.append(0xf90003e0 | uint32(offset/8)<<10 | uint32(src&31))
	return nil
}

func (b *arm64MachineBuilder) ldrRegSP(dst, offset int) error {
	if offset < 0 || offset%8 != 0 || offset/8 > 0xfff {
		return fmt.Errorf("arm64 cfg machine: spill load offset %d out of range", offset)
	}
	b.append(0xf94003e0 | uint32(offset/8)<<10 | uint32(dst&31))
	return nil
}

func arm64MachineFPSpillOffset(f SSAFunction, plan SSARegisterPlan, spill int) int {
	return arm64GPRSpillBytes(f, plan) + spill*8
}
