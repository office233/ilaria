package coreir

import (
	"encoding/binary"
	"fmt"
)

// X64CFGMachineABI is the packed machine-code ABI for call-free, spill-free
// integer/bool CFG functions. It extends the leaf packed backend with loops,
// branches and phi copies while keeping the artifact inert and verifier-friendly.
const X64CFGMachineABI = "swyp-x64-cfg-machine-win64-v1"

// X64CFGMachineCallsABI extends the packed CFG ABI to a closed set of reachable
// scalar functions. Calls are resolved to rel32 targets inside the same verified
// code blob; no external symbol resolution is required at execution time.
const X64CFGMachineCallsABI = "swyp-x64-cfg-machine-win64-v2"

// X64CFGMachineFPABI adds direct ieee64 values to the packed CFG backend.
// Strict f64 remains unsupported because its finite/div-zero trapping semantics
// must not be silently replaced by IEEE-754 propagation.
const X64CFGMachineFPABI = "swyp-x64-cfg-machine-fp-win64-v1"

// X64CFGMachineFPCallsABI combines closed rel32 call graphs with explicit
// ieee64 Win64 positional arguments/results. GPR and FP live values remain in
// nonvolatile registers or spill slots across calls.
const X64CFGMachineFPCallsABI = "swyp-x64-cfg-machine-fp-calls-win64-v1"

type x64BlockFixup struct {
	dispPos int
	target  int
}

type x64CallFixup struct {
	dispPos int
	callee  string
}

func EmitX64CFGMachineCode(f SSAFunction, plan SSARegisterPlan) ([]byte, error) {
	code, calls, err := emitX64CFGMachineFunction(f, plan, false, false)
	if err != nil {
		return nil, err
	}
	if len(calls) != 0 {
		return nil, fmt.Errorf("x64 cfg machine: unresolved calls in single-function emitter")
	}
	return code, nil
}

// EmitX64CFGMachineModule emits all supplied reachable scalar functions into a
// single packed machine-code blob. The requested entry is placed at offset 0,
// preserving the existing loader contract.
func EmitX64CFGMachineModule(functions []SSAFunction, plans map[string]SSARegisterPlan, entry string) ([]byte, error) {
	result, err := emitX64CFGMachineModuleMode(functions, plans, entry, false)
	if err != nil {
		return nil, err
	}
	if len(result.RuntimeFixups) != 0 {
		return nil, fmt.Errorf("x64 cfg machine module: unexpected process runtime fixups")
	}
	return result.Code, nil
}

type X64ProcessRuntimeFixup struct {
	DispPos int
	Helper  string
}

type X64ProcessMachineCode struct {
	Code             []byte
	RuntimeFixups    []X64ProcessRuntimeFixup
	Data             []byte
	RuntimeDataBytes int
	StorageDataBytes int
}

func EmitX64CFGMachineProcessModule(functions []SSAFunction, plans map[string]SSARegisterPlan, entry string) (X64ProcessMachineCode, error) {
	return emitX64CFGMachineModuleMode(functions, plans, entry, true)
}

func emitX64CFGMachineModuleMode(functions []SSAFunction, plans map[string]SSARegisterPlan, entry string, allowProcessIO bool) (X64ProcessMachineCode, error) {
	if len(functions) == 0 {
		return X64ProcessMachineCode{}, fmt.Errorf("x64 cfg machine module: no functions")
	}
	byName := make(map[string]SSAFunction, len(functions))
	for _, f := range functions {
		if f.Name == "" {
			return X64ProcessMachineCode{}, fmt.Errorf("x64 cfg machine module: empty function name")
		}
		if _, exists := byName[f.Name]; exists {
			return X64ProcessMachineCode{}, fmt.Errorf("x64 cfg machine module: duplicate function %q", f.Name)
		}
		byName[f.Name] = f
	}
	entryFunction, ok := byName[entry]
	if !ok {
		return X64ProcessMachineCode{}, fmt.Errorf("x64 cfg machine module: entry %q not found", entry)
	}
	if err := validateX64CFGMachineCalls(byName, entry); err != nil {
		return X64ProcessMachineCode{}, err
	}

	ordered := make([]SSAFunction, 0, len(functions))
	ordered = append(ordered, entryFunction)
	for _, f := range functions {
		if f.Name != entry {
			ordered = append(ordered, f)
		}
	}

	offsets := make(map[string]int, len(ordered))
	type pendingCall struct {
		dispPos int
		callee  string
	}
	pending := make([]pendingCall, 0)
	code := make([]byte, 0)
	for _, f := range ordered {
		plan, ok := plans[f.Name]
		if !ok {
			return X64ProcessMachineCode{}, fmt.Errorf("x64 cfg machine module: missing register plan for %s", f.Name)
		}
		offsets[f.Name] = len(code)
		functionCode, calls, err := emitX64CFGMachineFunction(f, plan, true, allowProcessIO)
		if err != nil {
			return X64ProcessMachineCode{}, fmt.Errorf("x64 cfg machine module %s: %w", f.Name, err)
		}
		base := len(code)
		code = append(code, functionCode...)
		for _, call := range calls {
			pending = append(pending, pendingCall{dispPos: base + call.dispPos, callee: call.callee})
		}
		if len(code) > MaxX64LeafCodeBytes {
			return X64ProcessMachineCode{}, fmt.Errorf("x64 cfg machine module: code size exceeds limit")
		}
	}
	runtimeFixups := make([]X64ProcessRuntimeFixup, 0)
	for _, call := range pending {
		target, ok := offsets[call.callee]
		if !ok {
			if allowProcessIO && x64ProcessRuntimeHelper(call.callee) {
				runtimeFixups = append(runtimeFixups, X64ProcessRuntimeFixup{DispPos: call.dispPos, Helper: call.callee})
				continue
			}
			return X64ProcessMachineCode{}, fmt.Errorf("x64 cfg machine module: unresolved callee %q", call.callee)
		}
		patchX64Rel32(code, call.dispPos, target)
	}
	if len(code) == 0 {
		return X64ProcessMachineCode{}, fmt.Errorf("x64 cfg machine module: empty code")
	}
	return X64ProcessMachineCode{Code: code, RuntimeFixups: runtimeFixups}, nil
}

func validateX64CFGMachineCalls(functions map[string]SSAFunction, entry string) error {
	state := make(map[string]uint8, len(functions))
	var visit func(string) error
	visit = func(name string) error {
		switch state[name] {
		case 1:
			return fmt.Errorf("x64 cfg machine module: recursive call cycle at %s", name)
		case 2:
			return nil
		}
		caller := functions[name]
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
					return fmt.Errorf("x64 cfg machine module: %s block %d instruction %d calls unknown %q", name, bi, ii, ins.Callee)
				}
				if ins.Dest < 0 || int(ins.Dest) >= len(caller.ValueTypes) {
					return fmt.Errorf("x64 cfg machine module: %s call to %s has invalid destination", name, ins.Callee)
				}
				if len(ins.Args) != len(callee.Params) || len(ins.Args) > 4 {
					return fmt.Errorf("x64 cfg machine module: %s -> %s signature arity mismatch", name, ins.Callee)
				}
				if caller.ValueTypes[ins.Dest] != callee.Result || !x64MachineCallType(callee.Result) {
					return fmt.Errorf("x64 cfg machine module: %s -> %s result type mismatch", name, ins.Callee)
				}
				for i, arg := range ins.Args {
					if arg < 0 || int(arg) >= len(caller.ValueTypes) {
						return fmt.Errorf("x64 cfg machine module: %s -> %s invalid argument %d", name, ins.Callee, i)
					}
					param := callee.Params[i]
					if param < 0 || int(param) >= len(callee.ValueTypes) {
						return fmt.Errorf("x64 cfg machine module: %s has invalid parameter %d", ins.Callee, i)
					}
					argType := caller.ValueTypes[arg]
					paramType := callee.ValueTypes[param]
					if argType != paramType || !x64MachineCallType(paramType) {
						return fmt.Errorf("x64 cfg machine module: %s -> %s argument %d type mismatch %s/%s", name, ins.Callee, i, argType, paramType)
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
			return fmt.Errorf("x64 cfg machine module: function %s is not reachable from entry %s", name, entry)
		}
	}
	return nil
}

func x64MachineCallType(t Type) bool {
	return t == I64 || t == U64 || t == Bool || t == IEEE64
}

func emitX64CFGMachineFunction(f SSAFunction, plan SSARegisterPlan, allowCalls, allowProcessIO bool) ([]byte, []x64CallFixup, error) {
	if len(plan.Locations) != len(f.ValueTypes) {
		return nil, nil, fmt.Errorf("x64 cfg machine: register plan/value count mismatch")
	}
	if len(f.Params) > 4 {
		return nil, nil, fmt.Errorf("x64 cfg machine: supports at most four parameters")
	}
	reachable := 0
	for bi, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		reachable++
		for _, ins := range block.Instructions {
			if ins.Op == "call" && !allowCalls {
				return nil, nil, fmt.Errorf("x64 cfg machine: calls require packed module ABI v2 (block %d)", bi)
			}
			if (ins.Op == "io.stdout" || ins.Op == "io.stderr" || ins.Op == "clock.read" || ins.Op == "fs.write" || ins.Op == "net.connect" || ins.Op == "net.fetch") && !allowProcessIO {
				return nil, nil, fmt.Errorf("x64 cfg machine: process IO requires standalone process backend (block %d)", bi)
			}
		}
	}
	if reachable == 0 {
		return nil, nil, fmt.Errorf("x64 cfg machine: no reachable blocks")
	}
	for value, t := range f.ValueTypes {
		if t == F64 {
			return nil, nil, fmt.Errorf("x64 cfg machine: strict f64 is unsupported; use ieee64 or Core AOT")
		}
		loc := plan.Locations[value]
		limit := len(x64MachineRegisters)
		if registerClass(t) == RegisterFP {
			limit = len(x64MachineFPRegisters)
		}
		if loc.Spill >= 0 {
			continue
		}
		if loc.Register < 0 || loc.Register >= limit {
			return nil, nil, fmt.Errorf("x64 cfg machine: invalid allocation for value %d", value)
		}
	}

	b := &x64MachineBuilder{}
	used := make([]bool, len(x64MachineRegisters))
	usedFP := make([]bool, len(x64MachineFPRegisters))
	for value, loc := range plan.Locations {
		if loc.Register >= 0 {
			if registerClass(f.ValueTypes[value]) == RegisterFP {
				usedFP[loc.Register] = true
			} else {
				used[loc.Register] = true
			}
		}
	}
	activeGPRs := 0
	for _, active := range used {
		if active {
			activeGPRs++
		}
	}

	statusArgIndex := len(f.Params)
	if statusArgIndex < 4 {
		b.movRegReg(x64R11, x64WinArgRegs[statusArgIndex])
	} else {
		b.movRegStackDisp8(x64R11, x64RSP, 40)
	}
	b.push(x64RBP)
	for reg, active := range used {
		if active {
			b.push(x64MachineRegisters[reg])
		}
	}
	b.movRegReg(x64RBP, x64RSP)
	spillBytes := x64SpillFrameBytes(f, plan)
	fpSaveBytes := 0
	for _, active := range usedFP {
		if active {
			fpSaveBytes += 16
		}
	}
	frameBytes := (spillBytes + fpSaveBytes + 15) &^ 15
	if frameBytes > 0 {
		b.subRegImm32(x64RSP, uint32(frameBytes))
	}
	fpSaveIndex := 0
	for reg, active := range usedFP {
		if !active {
			continue
		}
		disp := int32(-(spillBytes + (fpSaveIndex+1)*16))
		b.movdquMemDisp32XMM(x64RBP, disp, x64MachineFPRegisters[reg])
		fpSaveIndex++
	}
	for i, value := range f.Params {
		if !ssaValueUsed(f, value) {
			continue
		}
		loc := plan.Locations[value]
		if registerClass(f.ValueTypes[value]) == RegisterFP {
			src := i
			if loc.Spill >= 0 {
				b.movsdMemDisp32XMM(x64RBP, x64MachineFPSpillDisp(f, plan, loc.Spill), src)
			} else {
				dst := x64PhysicalFPReg(plan, value)
				if dst != src {
					b.movsdXMMXMM(dst, src)
				}
			}
		} else {
			src := x64WinArgRegs[i]
			if loc.Spill >= 0 {
				b.movMemDisp32Reg(x64RBP, x64MachineSpillDisp(loc.Spill), src)
			} else {
				dst := x64PhysicalReg(plan, value)
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
	fixups := make([]x64BlockFixup, 0)
	for bi, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		blockOffsets[bi] = len(b.code)
		for _, ins := range block.Instructions {
			if err := b.emitCFGInstruction(f, plan, ins, activeGPRs, allowProcessIO); err != nil {
				return nil, nil, fmt.Errorf("x64 cfg machine block %d: %w", bi, err)
			}
		}
		switch block.Terminator.Op {
		case "return":
			if block.Terminator.Value >= 0 {
				value := block.Terminator.Value
				loc := plan.Locations[value]
				if registerClass(f.ValueTypes[value]) == RegisterFP {
					if loc.Spill >= 0 {
						b.movsdXMMMemDisp32(0, x64RBP, x64MachineFPSpillDisp(f, plan, loc.Spill))
					} else {
						result := x64PhysicalFPReg(plan, value)
						if result != 0 {
							b.movsdXMMXMM(0, result)
						}
					}
				} else {
					if loc.Spill >= 0 {
						b.movRegMemDisp32(x64RAX, x64RBP, x64MachineSpillDisp(loc.Spill))
					} else {
						result := x64PhysicalReg(plan, value)
						if result != x64RAX {
							b.movRegReg(x64RAX, result)
						}
					}
				}
			} else {
				b.xorRegReg(x64RAX, x64RAX)
			}
			b.xorRegReg(x64RDX, x64RDX)
			b.movMemReg(x64R11, x64RDX)
			emitX64MachineRestoreAndReturn(b, used, usedFP, spillBytes)
		case "jump":
			if len(block.Terminator.Targets) != 1 {
				return nil, nil, fmt.Errorf("x64 cfg machine: block %d invalid jump", bi)
			}
			target := block.Terminator.Targets[0]
			if err := emitX64MachineLivePhiCopies(b, f, plan, bi, target); err != nil {
				return nil, nil, err
			}
			fixups = append(fixups, x64BlockFixup{dispPos: b.jmpRel32(), target: target})
		case "branch":
			if len(block.Terminator.Targets) != 2 || block.Terminator.Value < 0 {
				return nil, nil, fmt.Errorf("x64 cfg machine: block %d invalid branch", bi)
			}
			condLoc := plan.Locations[block.Terminator.Value]
			cond := x64R10
			if condLoc.Spill >= 0 {
				b.movRegMemDisp32(cond, x64RBP, x64MachineSpillDisp(condLoc.Spill))
			} else {
				cond = x64PhysicalReg(plan, block.Terminator.Value)
			}
			b.testRegReg(cond, cond)
			falseDisp := b.jccRel32(0x4) // JE
			trueTarget := block.Terminator.Targets[0]
			if err := emitX64MachineLivePhiCopies(b, f, plan, bi, trueTarget); err != nil {
				return nil, nil, err
			}
			fixups = append(fixups, x64BlockFixup{dispPos: b.jmpRel32(), target: trueTarget})
			falseOffset := len(b.code)
			patchX64Rel32(b.code, falseDisp, falseOffset)
			falseTarget := block.Terminator.Targets[1]
			if err := emitX64MachineLivePhiCopies(b, f, plan, bi, falseTarget); err != nil {
				return nil, nil, err
			}
			fixups = append(fixups, x64BlockFixup{dispPos: b.jmpRel32(), target: falseTarget})
		case "unreachable":
			// Core uses unreachable as a checked-failure sink for paths proven
			// invalid by the frontend/lowerer (currently dynamic fixed-array
			// bounds). Return the existing machine ABI bounds status rather than
			// emitting an illegal instruction that would terminate the host.
			b.xorRegReg(x64RAX, x64RAX)
			b.xorpsRegReg(0, 0)
			b.movRegImm64(x64RDX, 3)
			b.movMemReg(x64R11, x64RDX)
			emitX64MachineRestoreAndReturn(b, used, usedFP, spillBytes)
		default:
			return nil, nil, fmt.Errorf("x64 cfg machine: unsupported terminator %q in block %d", block.Terminator.Op, bi)
		}
	}

	overflowOffset := len(b.code)
	b.xorRegReg(x64RAX, x64RAX)
	b.xorpsRegReg(0, 0)
	b.movRegImm64(x64RDX, 1)
	b.movMemReg(x64R11, x64RDX)
	emitX64MachineRestoreAndReturn(b, used, usedFP, spillBytes)
	ioFailureOffset := len(b.code)
	b.xorRegReg(x64RAX, x64RAX)
	b.xorpsRegReg(0, 0)
	b.movRegImm64(x64RDX, 2)
	b.movMemReg(x64R11, x64RDX)
	emitX64MachineRestoreAndReturn(b, used, usedFP, spillBytes)
	boundsFailureOffset := len(b.code)
	b.xorRegReg(x64RAX, x64RAX)
	b.xorpsRegReg(0, 0)
	b.movRegImm64(x64RDX, 3)
	b.movMemReg(x64R11, x64RDX)
	emitX64MachineRestoreAndReturn(b, used, usedFP, spillBytes)

	for _, fixup := range b.overflowFixups {
		patchX64Rel32(b.code, fixup, overflowOffset)
	}
	for _, fixup := range b.ioFailureFixups {
		patchX64Rel32(b.code, fixup, ioFailureOffset)
	}
	for _, fixup := range b.boundsFailureFixups {
		patchX64Rel32(b.code, fixup, boundsFailureOffset)
	}
	for _, fixup := range fixups {
		if fixup.target < 0 || fixup.target >= len(blockOffsets) || blockOffsets[fixup.target] < 0 {
			return nil, nil, fmt.Errorf("x64 cfg machine: invalid branch target %d", fixup.target)
		}
		patchX64Rel32(b.code, fixup.dispPos, blockOffsets[fixup.target])
	}
	if len(b.code) == 0 || len(b.code) > MaxX64LeafCodeBytes {
		return nil, nil, fmt.Errorf("x64 cfg machine: invalid code size %d", len(b.code))
	}
	return b.code, append([]x64CallFixup(nil), b.callFixups...), nil
}

func emitX64MachineRestoreAndReturn(b *x64MachineBuilder, used, usedFP []bool, spillBytes int) {
	fpSaveIndex := 0
	for reg, active := range usedFP {
		if !active {
			continue
		}
		disp := int32(-(spillBytes + (fpSaveIndex+1)*16))
		b.movdquXMMMemDisp32(x64MachineFPRegisters[reg], x64RBP, disp)
		fpSaveIndex++
	}
	b.movRegReg(x64RSP, x64RBP)
	for reg := len(used) - 1; reg >= 0; reg-- {
		if used[reg] {
			b.pop(x64MachineRegisters[reg])
		}
	}
	b.pop(x64RBP)
	b.ret()
}

func emitX64MachinePhiCopies(b *x64MachineBuilder, f SSAFunction, plan SSARegisterPlan, predecessor, target int) error {
	if target < 0 || target >= len(f.Blocks) || !f.Blocks[target].Reachable {
		return fmt.Errorf("x64 cfg machine: invalid edge %d -> %d", predecessor, target)
	}
	type move struct {
		dst, src RegisterLocation
		class    RegisterClass
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
			return fmt.Errorf("x64 cfg machine: phi %d has no input from predecessor %d", phi.Dest, predecessor)
		}
		dst, src := plan.Locations[phi.Dest], plan.Locations[input]
		class := registerClass(f.ValueTypes[phi.Dest])
		if class != registerClass(f.ValueTypes[input]) {
			return fmt.Errorf("x64 cfg machine: phi %d class mismatch on edge %d -> %d", phi.Dest, predecessor, target)
		}
		if dst != src {
			moves = append(moves, move{dst: dst, src: src, class: class})
		}
	}
	for _, m := range moves {
		if m.class == RegisterFP {
			if m.src.Spill >= 0 {
				b.movRegMemDisp32(x64R10, x64RBP, x64MachineFPSpillDisp(f, plan, m.src.Spill))
			} else {
				b.movqRegXMM(x64R10, x64MachineFPRegisters[m.src.Register])
			}
			b.push(x64R10)
		} else {
			if m.src.Spill >= 0 {
				b.movRegMemDisp32(x64R10, x64RBP, x64MachineSpillDisp(m.src.Spill))
				b.push(x64R10)
			} else {
				b.push(x64MachineRegisters[m.src.Register])
			}
		}
	}
	for i := len(moves) - 1; i >= 0; i-- {
		m := moves[i]
		b.pop(x64R10)
		if m.class == RegisterFP {
			if m.dst.Spill >= 0 {
				b.movMemDisp32Reg(x64RBP, x64MachineFPSpillDisp(f, plan, m.dst.Spill), x64R10)
			} else {
				b.movqXMMReg(x64MachineFPRegisters[m.dst.Register], x64R10)
			}
		} else {
			if m.dst.Spill >= 0 {
				b.movMemDisp32Reg(x64RBP, x64MachineSpillDisp(m.dst.Spill), x64R10)
			} else {
				b.movRegReg(x64MachineRegisters[m.dst.Register], x64R10)
			}
		}
	}
	return nil
}

func emitX64MachineLivePhiCopies(b *x64MachineBuilder, f SSAFunction, plan SSARegisterPlan, predecessor, target int) error {
	if target < 0 || target >= len(f.Blocks) {
		return emitX64MachinePhiCopies(b, f, plan, predecessor, target)
	}
	block := f.Blocks[target]
	if len(block.Phis) == 0 {
		return emitX64MachinePhiCopies(b, f, plan, predecessor, target)
	}
	live := make([]SSAPhi, 0, len(block.Phis))
	for _, phi := range block.Phis {
		if ssaValueUsed(f, phi.Dest) {
			live = append(live, phi)
		}
	}
	if len(live) == len(block.Phis) {
		return emitX64MachinePhiCopies(b, f, plan, predecessor, target)
	}
	filtered := f
	filtered.Blocks = append([]SSABlock(nil), f.Blocks...)
	block.Phis = live
	filtered.Blocks[target] = block
	return emitX64MachinePhiCopies(b, filtered, plan, predecessor, target)
}

func x64MachineSpillDisp(spill int) int32 {
	return int32(-(spill + 1) * 8)
}

func x64MachineFPSpillDisp(f SSAFunction, plan SSARegisterPlan, spill int) int32 {
	return int32(-(x64GPRSpillBytes(f, plan) + (spill+1)*8))
}

func (b *x64MachineBuilder) emitCFGInstruction(f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, activeGPRs int, allowProcessIO bool) error {
	if ins.Op == "io.stdout" || ins.Op == "io.stderr" {
		if !allowProcessIO {
			return fmt.Errorf("x64 cfg machine: process IO is not enabled")
		}
		return b.emitCFGProcessIOInstruction(f, plan, ins, activeGPRs)
	}
	if ins.Op == "clock.read" {
		if !allowProcessIO {
			return fmt.Errorf("x64 cfg machine: clock.read requires standalone process backend")
		}
		return b.emitCFGClockInstruction(f, plan, ins, activeGPRs)
	}
	if ins.Op == "rng.sample" {
		if !allowProcessIO {
			return fmt.Errorf("x64 cfg machine: rng.sample requires standalone process backend")
		}
		return b.emitCFGRNGInstruction(f, plan, ins, activeGPRs)
	}
	if ins.Op == "fs.write" {
		if !allowProcessIO {
			return fmt.Errorf("x64 cfg machine: fs.write requires standalone process backend")
		}
		return b.emitCFGFSWriteInstruction(f, plan, ins, activeGPRs)
	}
	if ins.Op == "fs.read" {
		if !allowProcessIO {
			return fmt.Errorf("x64 cfg machine: fs.read requires standalone process backend")
		}
		return b.emitCFGFSReadInstruction(f, plan, ins, activeGPRs)
	}
	if ins.Op == "net.connect" {
		if !allowProcessIO {
			return fmt.Errorf("x64 cfg machine: net.connect requires standalone process backend")
		}
		return b.emitCFGNetConnectInstruction(f, plan, ins, activeGPRs)
	}
	if ins.Op == "net.fetch" {
		if !allowProcessIO {
			return fmt.Errorf("x64 cfg machine: net.fetch requires standalone process backend")
		}
		return b.emitCFGNetFetchInstruction(f, plan, ins, activeGPRs)
	}
	if ins.Op == "process.exec" {
		if !allowProcessIO {
			return fmt.Errorf("x64 cfg machine: process.exec requires standalone process backend")
		}
		return fmt.Errorf("x64 cfg machine: process.exec runtime is not implemented")
	}
	if ins.Op == "bytes.get" {
		if !allowProcessIO {
			return fmt.Errorf("x64 cfg machine: bytes.get requires standalone process backend")
		}
		return b.emitCFGBytesGetInstruction(f, plan, ins, activeGPRs)
	}
	if ins.Op == "storage.alloc_u64" || ins.Op == "storage.load_u64" || ins.Op == "storage.store_u64" || ins.Op == "storage.free" {
		if !allowProcessIO {
			return fmt.Errorf("x64 cfg machine: %s requires standalone process backend", ins.Op)
		}
		return b.emitCFGStorageInstruction(f, plan, ins, activeGPRs)
	}
	if ins.Dest < 0 {
		return fmt.Errorf("x64 cfg machine: instruction %s has no destination", ins.Op)
	}
	if ins.Op == "call" {
		return b.emitCFGCallInstruction(f, plan, ins, activeGPRs)
	}
	destLoc := plan.Locations[ins.Dest]
	if registerClass(f.ValueTypes[ins.Dest]) == RegisterFP ||
		(len(ins.Args) > 0 && registerClass(f.ValueTypes[ins.Args[0]]) == RegisterFP) {
		return b.emitCFGFPInstruction(f, plan, ins)
	}
	dst := x64RAX
	if destLoc.Spill < 0 {
		dst = x64PhysicalReg(plan, ins.Dest)
	}
	commit := func() {
		if destLoc.Spill >= 0 {
			b.movMemDisp32Reg(x64RBP, x64MachineSpillDisp(destLoc.Spill), dst)
		}
	}
	arg := func(index, scratch int) (int, Type, error) {
		if index >= len(ins.Args) {
			return 0, "", fmt.Errorf("x64 cfg machine: %s missing operand %d", ins.Op, index)
		}
		value := ins.Args[index]
		loc := plan.Locations[value]
		if loc.Spill >= 0 {
			b.movRegMemDisp32(scratch, x64RBP, x64MachineSpillDisp(loc.Spill))
			return scratch, f.ValueTypes[value], nil
		}
		return x64PhysicalReg(plan, value), f.ValueTypes[value], nil
	}
	switch ins.Op {
	case "bytes.len":
		a, at, err := arg(0, x64R10)
		if err != nil {
			return err
		}
		if at != Bytes || f.ValueTypes[ins.Dest] != U64 {
			return fmt.Errorf("x64 cfg machine: bytes.len requires bytes -> u64")
		}
		if dst != a {
			b.movRegReg(dst, a)
		}
		// ByteSpan encoding is offset<<32 | length. Keep only low 32 bits.
		b.shlRegImm8(dst, 32)
		b.shrRegImm8(dst, 32)
		commit()
		return nil
	case "call":
		if ins.Callee == "" {
			return fmt.Errorf("x64 cfg machine: call missing callee")
		}
		if len(ins.Args) > 4 {
			return fmt.Errorf("x64 cfg machine: native call supports at most 4 GPR arguments")
		}
		if !x64MachineCallType(f.ValueTypes[ins.Dest]) {
			return fmt.Errorf("x64 cfg machine: native call result type %s is unsupported", f.ValueTypes[ins.Dest])
		}
		for i, value := range ins.Args {
			if !x64MachineCallType(f.ValueTypes[value]) {
				return fmt.Errorf("x64 cfg machine: native call argument %d type %s is unsupported", i, f.ValueTypes[value])
			}
		}

		frameBytes, savedStatusDisp := x64MachineCallFrame(activeGPRs, len(ins.Args))
		b.subRegImm32(x64RSP, uint32(frameBytes))
		b.movMemDisp32Reg(x64RSP, int32(savedStatusDisp), x64R11)
		for i, value := range ins.Args {
			dstArg := x64WinArgRegs[i]
			loc := plan.Locations[value]
			if loc.Spill >= 0 {
				b.movRegMemDisp32(dstArg, x64RBP, x64MachineSpillDisp(loc.Spill))
			} else {
				src := x64PhysicalReg(plan, value)
				if src != dstArg {
					b.movRegReg(dstArg, src)
				}
			}
		}
		if len(ins.Args) < 4 {
			b.movRegReg(x64WinArgRegs[len(ins.Args)], x64R11)
		} else {
			// CALL pushes the return address, so [rsp+32] here becomes the
			// callee's fifth Win64 argument at [rsp+40].
			b.movMemDisp32Reg(x64RSP, 32, x64R11)
		}
		b.callFixups = append(b.callFixups, x64CallFixup{dispPos: b.callRel32(), callee: ins.Callee})
		b.movRegMemDisp32(x64R11, x64RSP, int32(savedStatusDisp))
		b.addRegImm32(x64RSP, uint32(frameBytes))
		b.movRegMemDisp32(x64R10, x64R11, 0)
		b.testRegReg(x64R10, x64R10)
		b.overflowFixups = append(b.overflowFixups, b.jccRel32(0x5)) // JNE
		if destLoc.Spill >= 0 {
			b.movMemDisp32Reg(x64RBP, x64MachineSpillDisp(destLoc.Spill), x64RAX)
		} else if dst != x64RAX {
			b.movRegReg(dst, x64RAX)
		}
		return nil
	case "const":
		if ins.Constant == nil {
			return fmt.Errorf("x64 cfg machine: const missing literal")
		}
		v, err := ParseValue(ins.Constant.Type, ins.Constant.Value)
		if err != nil {
			return err
		}
		b.movRegImm64(dst, valueToRaw(v))
		commit()
		return nil
	case "move":
		a, _, err := arg(0, x64R10)
		if err != nil {
			return err
		}
		if dst != a {
			b.movRegReg(dst, a)
		}
		commit()
		return nil
	case "bitcast_i64_u64", "bitcast_u64_i64":
		a, srcType, err := arg(0, x64R10)
		if err != nil {
			return err
		}
		wantSrc, wantDst := I64, U64
		if ins.Op == "bitcast_u64_i64" {
			wantSrc, wantDst = U64, I64
		}
		if srcType != wantSrc || f.ValueTypes[ins.Dest] != wantDst {
			return fmt.Errorf("x64 cfg machine: invalid %s types %s -> %s", ins.Op, srcType, f.ValueTypes[ins.Dest])
		}
		if dst != a {
			b.movRegReg(dst, a)
		}
		commit()
		return nil
	case "neg":
		a, t, err := arg(0, x64R10)
		if err != nil {
			return err
		}
		if t != I64 && t != U64 {
			return fmt.Errorf("x64 cfg machine: neg unsupported type %s", t)
		}
		if dst != a {
			b.movRegReg(dst, a)
		}
		b.neg(dst)
		if t == I64 {
			b.joOverflow()
		}
		commit()
		return nil
	case "not":
		a, t, err := arg(0, x64R10)
		if err != nil {
			return err
		}
		if t != Bool {
			return fmt.Errorf("x64 cfg machine: not requires bool")
		}
		if dst != a {
			b.movRegReg(dst, a)
		}
		b.xorImm8(dst, 1)
		commit()
		return nil
	case "eq", "ne", "lt", "le", "gt", "ge":
		a, at, err := arg(0, x64R10)
		if err != nil {
			return err
		}
		c, bt, err := arg(1, x64RDX)
		if err != nil {
			return err
		}
		if at != bt || (at != I64 && at != U64 && at != Bool) {
			return fmt.Errorf("x64 cfg machine: unsupported comparison %s/%s", at, bt)
		}
		b.cmpRegReg(a, c)
		b.movRegImm64(dst, 0)
		cc, err := x64ConditionCode(ins.Op, at)
		if err != nil {
			return err
		}
		b.setcc(dst, cc)
		commit()
		return nil
	case "add", "sub", "mul", "band", "bor", "bxor":
		a, at, err := arg(0, x64R10)
		if err != nil {
			return err
		}
		c, bt, err := arg(1, x64RDX)
		if err != nil {
			return err
		}
		if at != bt || (at != I64 && at != U64) {
			return fmt.Errorf("x64 cfg machine: %s unsupported operands %s/%s", ins.Op, at, bt)
		}
		commutative := ins.Op == "add" || ins.Op == "mul" || ins.Op == "band" || ins.Op == "bor" || ins.Op == "bxor"
		target := dst
		other := c
		if destLoc.Spill >= 0 {
			b.movRegReg(target, a)
		} else if dst == a {
			// ideal
		} else if dst == c && commutative {
			other = a
		} else if dst == c {
			target = x64RAX
			other = c
			b.movRegReg(target, a)
		} else {
			b.movRegReg(target, a)
		}
		switch ins.Op {
		case "add":
			b.binaryRegReg(0x01, target, other)
		case "sub":
			b.binaryRegReg(0x29, target, other)
		case "mul":
			b.imulRegReg(target, other)
		case "band":
			b.binaryRegReg(0x21, target, other)
		case "bor":
			b.binaryRegReg(0x09, target, other)
		case "bxor":
			b.binaryRegReg(0x31, target, other)
		}
		if at == I64 && (ins.Op == "add" || ins.Op == "sub" || ins.Op == "mul") {
			b.joOverflow()
		}
		if target != dst {
			b.movRegReg(dst, target)
		}
		commit()
		return nil
	case "div", "rem":
		// Checked Core semantics: a zero divisor traps, i64 MIN/-1 overflows and
		// MIN%-1 is 0. IDIV/DIV fault on those inputs, so they never reach it.
		// Both traps use the arithmetic-failure status 1.
		a, at, err := arg(0, x64RAX)
		if err != nil {
			return err
		}
		c, bt, err := arg(1, x64R10)
		if err != nil {
			return err
		}
		if at != bt || (at != I64 && at != U64) {
			return fmt.Errorf("x64 cfg machine: %s unsupported operands %s/%s", ins.Op, at, bt)
		}
		if c != x64R10 {
			b.movRegReg(x64R10, c)
		}
		if a != x64RAX {
			b.movRegReg(x64RAX, a)
		}
		b.testRegReg(x64R10, x64R10)
		b.overflowFixups = append(b.overflowFixups, b.jccRel32(0x4)) // JE: division by zero
		if at == I64 {
			b.cmpRegImm8(x64R10, 0xff) // divisor == -1
			general := b.jccRel32(0x5) // JNE
			if ins.Op == "div" {
				b.neg(x64RAX)
				b.joOverflow()
			} else {
				b.xorRegReg(x64RDX, x64RDX)
			}
			done := b.jmpRel32()
			patchX64Rel32(b.code, general, len(b.code))
			b.cqo()
			b.idivReg(x64R10)
			patchX64Rel32(b.code, done, len(b.code))
		} else {
			b.xorRegReg(x64RDX, x64RDX)
			b.divReg(x64R10)
		}
		result := x64RAX
		if ins.Op == "rem" {
			result = x64RDX
		}
		if destLoc.Spill >= 0 {
			b.movMemDisp32Reg(x64RBP, x64MachineSpillDisp(destLoc.Spill), result)
		} else if dst != result {
			b.movRegReg(dst, result)
		}
		return nil
	default:
		return fmt.Errorf("x64 cfg machine: unsupported operation %q", ins.Op)
	}
}

func (b *x64MachineBuilder) emitCFGBytesGetInstruction(f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, activeGPRs int) error {
	if ins.Dest < 0 || int(ins.Dest) >= len(f.ValueTypes) || f.ValueTypes[ins.Dest] != U64 || len(ins.Args) != 2 {
		return fmt.Errorf("x64 bytes.get: invalid instruction")
	}
	for i, value := range ins.Args {
		want := Bytes
		if i == 1 {
			want = U64
		}
		if value < 0 || int(value) >= len(f.ValueTypes) || f.ValueTypes[value] != want {
			return fmt.Errorf("x64 bytes.get: operand %d must be %s", i, want)
		}
		loc := plan.Locations[value]
		dst := x64RCX
		if i == 1 {
			dst = x64RDX
		}
		if loc.Spill >= 0 {
			b.movRegMemDisp32(dst, x64RBP, x64MachineSpillDisp(loc.Spill))
		} else {
			src := x64PhysicalReg(plan, value)
			if src != dst {
				b.movRegReg(dst, src)
			}
		}
	}
	frameBytes, savedStatusDisp := x64MachineCallFrame(activeGPRs, 2)
	b.subRegImm32(x64RSP, uint32(frameBytes))
	b.movMemDisp32Reg(x64RSP, int32(savedStatusDisp), x64R11)
	b.callFixups = append(b.callFixups, x64CallFixup{dispPos: b.callRel32(), callee: "__swyp_rt_bytes_get"})
	b.movRegMemDisp32(x64R11, x64RSP, int32(savedStatusDisp))
	b.addRegImm32(x64RSP, uint32(frameBytes))
	b.testRegReg(x64RDX, x64RDX)
	b.boundsFailureFixups = append(b.boundsFailureFixups, b.jccRel32(0x5))
	loc := plan.Locations[ins.Dest]
	if loc.Spill >= 0 {
		b.movMemDisp32Reg(x64RBP, x64MachineSpillDisp(loc.Spill), x64RAX)
	} else {
		dst := x64PhysicalReg(plan, ins.Dest)
		if dst != x64RAX {
			b.movRegReg(dst, x64RAX)
		}
	}
	return nil
}

func (b *x64MachineBuilder) emitCFGClockInstruction(f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, activeGPRs int) error {
	if ins.Dest < 0 || int(ins.Dest) >= len(f.ValueTypes) || f.ValueTypes[ins.Dest] != U64 || len(ins.Args) != 0 {
		return fmt.Errorf("x64 process clock: invalid clock.read instruction")
	}
	frameBytes, savedStatusDisp := x64MachineCallFrame(activeGPRs, 0)
	b.subRegImm32(x64RSP, uint32(frameBytes))
	b.movMemDisp32Reg(x64RSP, int32(savedStatusDisp), x64R11)
	b.callFixups = append(b.callFixups, x64CallFixup{dispPos: b.callRel32(), callee: "__swyp_rt_clock_u64"})
	b.movRegMemDisp32(x64R11, x64RSP, int32(savedStatusDisp))
	b.addRegImm32(x64RSP, uint32(frameBytes))
	b.testRegReg(x64RDX, x64RDX)
	b.ioFailureFixups = append(b.ioFailureFixups, b.jccRel32(0x5))
	loc := plan.Locations[ins.Dest]
	if loc.Spill >= 0 {
		b.movMemDisp32Reg(x64RBP, x64MachineSpillDisp(loc.Spill), x64RAX)
	} else {
		dst := x64PhysicalReg(plan, ins.Dest)
		if dst != x64RAX {
			b.movRegReg(dst, x64RAX)
		}
	}
	return nil
}

func (b *x64MachineBuilder) emitCFGRNGInstruction(f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, activeGPRs int) error {
	if ins.Dest < 0 || int(ins.Dest) >= len(f.ValueTypes) || f.ValueTypes[ins.Dest] != U64 || len(ins.Args) != 0 {
		return fmt.Errorf("x64 process rng: invalid rng.sample instruction")
	}
	frameBytes, savedStatusDisp := x64MachineCallFrame(activeGPRs, 0)
	b.subRegImm32(x64RSP, uint32(frameBytes))
	b.movMemDisp32Reg(x64RSP, int32(savedStatusDisp), x64R11)
	b.callFixups = append(b.callFixups, x64CallFixup{dispPos: b.callRel32(), callee: "__swyp_rt_rng_u64"})
	b.movRegMemDisp32(x64R11, x64RSP, int32(savedStatusDisp))
	b.addRegImm32(x64RSP, uint32(frameBytes))
	b.testRegReg(x64RDX, x64RDX)
	b.ioFailureFixups = append(b.ioFailureFixups, b.jccRel32(0x5))
	loc := plan.Locations[ins.Dest]
	if loc.Spill >= 0 {
		b.movMemDisp32Reg(x64RBP, x64MachineSpillDisp(loc.Spill), x64RAX)
	} else {
		dst := x64PhysicalReg(plan, ins.Dest)
		if dst != x64RAX {
			b.movRegReg(dst, x64RAX)
		}
	}
	return nil
}

func (b *x64MachineBuilder) emitCFGProcessIOInstruction(f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, activeGPRs int) error {
	if len(ins.Args) != 1 {
		return fmt.Errorf("x64 process IO: %s requires one operand", ins.Op)
	}
	value := ins.Args[0]
	if value < 0 || int(value) >= len(f.ValueTypes) {
		return fmt.Errorf("x64 process IO: invalid operand")
	}
	t := f.ValueTypes[value]
	if t != I64 && t != U64 && t != Bool && t != IEEE64 {
		return fmt.Errorf("x64 process IO: text formatter for %s is not implemented", t)
	}
	loc := plan.Locations[value]
	if t == IEEE64 {
		if loc.Spill >= 0 {
			b.movRegMemDisp32(x64RCX, x64RBP, x64MachineFPSpillDisp(f, plan, loc.Spill))
		} else {
			b.movqRegXMM(x64RCX, x64PhysicalFPReg(plan, value))
		}
	} else {
		if loc.Spill >= 0 {
			b.movRegMemDisp32(x64RCX, x64RBP, x64MachineSpillDisp(loc.Spill))
		} else {
			src := x64PhysicalReg(plan, value)
			if src != x64RCX {
				b.movRegReg(x64RCX, src)
			}
		}
	}
	frameBytes, savedStatusDisp := x64MachineCallFrame(activeGPRs, 1)
	b.subRegImm32(x64RSP, uint32(frameBytes))
	b.movMemDisp32Reg(x64RSP, int32(savedStatusDisp), x64R11)
	helper := x64ProcessHelperFor(ins.Op, t)
	b.callFixups = append(b.callFixups, x64CallFixup{dispPos: b.callRel32(), callee: helper})
	b.movRegMemDisp32(x64R11, x64RSP, int32(savedStatusDisp))
	b.addRegImm32(x64RSP, uint32(frameBytes))
	b.testRegReg(x64RAX, x64RAX)
	b.ioFailureFixups = append(b.ioFailureFixups, b.jccRel32(0x5)) // JNE
	return nil
}

func x64ProcessHelperFor(op string, t Type) string {
	stream := "stdout"
	if op == "io.stderr" {
		stream = "stderr"
	}
	return "__swyp_rt_" + stream + "_" + string(t)
}

func x64ProcessRuntimeHelper(name string) bool {
	switch name {
	case "__swyp_rt_stdout_i64", "__swyp_rt_stdout_u64", "__swyp_rt_stdout_bool",
		"__swyp_rt_stdout_ieee64",
		"__swyp_rt_stderr_i64", "__swyp_rt_stderr_u64", "__swyp_rt_stderr_bool", "__swyp_rt_stderr_ieee64",
		"__swyp_rt_clock_u64", "__swyp_rt_rng_u64", "__swyp_rt_fs_read", "__swyp_rt_fs_write", "__swyp_rt_bytes_get", "__swyp_rt_net_connect", "__swyp_rt_net_fetch",
		"__swyp_rt_storage_alloc_u64", "__swyp_rt_storage_load_u64", "__swyp_rt_storage_store_u64", "__swyp_rt_storage_free":
		return true
	default:
		return false
	}
}

func (b *x64MachineBuilder) emitCFGStorageInstruction(f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, activeGPRs int) error {
	wantArgs, helper := 0, ""
	switch ins.Op {
	case "storage.alloc_u64":
		wantArgs, helper = 1, "__swyp_rt_storage_alloc_u64"
	case "storage.load_u64":
		wantArgs, helper = 2, "__swyp_rt_storage_load_u64"
	case "storage.store_u64":
		wantArgs, helper = 3, "__swyp_rt_storage_store_u64"
	case "storage.free":
		wantArgs, helper = 1, "__swyp_rt_storage_free"
	default:
		return fmt.Errorf("x64 storage: unsupported operation %q", ins.Op)
	}
	if len(ins.Args) != wantArgs {
		return fmt.Errorf("x64 storage: %s requires %d operands", ins.Op, wantArgs)
	}
	for i, value := range ins.Args {
		if value < 0 || int(value) >= len(f.ValueTypes) || f.ValueTypes[value] != U64 {
			return fmt.Errorf("x64 storage: operand %d must be u64", i)
		}
		loc := plan.Locations[value]
		dst := x64WinArgRegs[i]
		if loc.Spill >= 0 {
			b.movRegMemDisp32(dst, x64RBP, x64MachineSpillDisp(loc.Spill))
		} else {
			src := x64PhysicalReg(plan, value)
			if src != dst {
				b.movRegReg(dst, src)
			}
		}
	}
	frameBytes, savedStatusDisp := x64MachineCallFrame(activeGPRs, wantArgs)
	b.subRegImm32(x64RSP, uint32(frameBytes))
	b.movMemDisp32Reg(x64RSP, int32(savedStatusDisp), x64R11)
	b.callFixups = append(b.callFixups, x64CallFixup{dispPos: b.callRel32(), callee: helper})
	b.movRegMemDisp32(x64R11, x64RSP, int32(savedStatusDisp))
	b.addRegImm32(x64RSP, uint32(frameBytes))
	b.testRegReg(x64RDX, x64RDX)
	b.boundsFailureFixups = append(b.boundsFailureFixups, b.jccRel32(0x5))
	if ins.Dest >= 0 {
		if int(ins.Dest) >= len(f.ValueTypes) || f.ValueTypes[ins.Dest] != U64 {
			return fmt.Errorf("x64 storage: destination must be u64")
		}
		loc := plan.Locations[ins.Dest]
		if loc.Spill >= 0 {
			b.movMemDisp32Reg(x64RBP, x64MachineSpillDisp(loc.Spill), x64RAX)
		} else {
			dst := x64PhysicalReg(plan, ins.Dest)
			if dst != x64RAX {
				b.movRegReg(dst, x64RAX)
			}
		}
	}
	return nil
}

func (b *x64MachineBuilder) emitCFGFSWriteInstruction(f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, activeGPRs int) error {
	if len(ins.Args) != 2 {
		return fmt.Errorf("x64 fs.write: requires path and data operands")
	}
	for i, value := range ins.Args {
		if value < 0 || int(value) >= len(f.ValueTypes) || f.ValueTypes[value] != Bytes {
			return fmt.Errorf("x64 fs.write: operand %d must be bytes", i)
		}
		loc := plan.Locations[value]
		dst := x64RCX
		if i == 1 {
			dst = x64RDX
		}
		if loc.Spill >= 0 {
			b.movRegMemDisp32(dst, x64RBP, x64MachineSpillDisp(loc.Spill))
		} else {
			src := x64PhysicalReg(plan, value)
			if src != dst {
				b.movRegReg(dst, src)
			}
		}
	}
	frameBytes, savedStatusDisp := x64MachineCallFrame(activeGPRs, 2)
	b.subRegImm32(x64RSP, uint32(frameBytes))
	b.movMemDisp32Reg(x64RSP, int32(savedStatusDisp), x64R11)
	b.callFixups = append(b.callFixups, x64CallFixup{dispPos: b.callRel32(), callee: "__swyp_rt_fs_write"})
	b.movRegMemDisp32(x64R11, x64RSP, int32(savedStatusDisp))
	b.addRegImm32(x64RSP, uint32(frameBytes))
	b.testRegReg(x64RAX, x64RAX)
	b.ioFailureFixups = append(b.ioFailureFixups, b.jccRel32(0x5))
	return nil
}

func (b *x64MachineBuilder) emitCFGFSReadInstruction(f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, activeGPRs int) error {
	if ins.Dest < 0 || int(ins.Dest) >= len(f.ValueTypes) || f.ValueTypes[ins.Dest] != Bytes || len(ins.Args) != 1 {
		return fmt.Errorf("x64 fs.read: requires path bytes and bytes destination")
	}
	value := ins.Args[0]
	if value < 0 || int(value) >= len(f.ValueTypes) || f.ValueTypes[value] != Bytes {
		return fmt.Errorf("x64 fs.read: path must be bytes")
	}
	loc := plan.Locations[value]
	if loc.Spill >= 0 {
		b.movRegMemDisp32(x64RCX, x64RBP, x64MachineSpillDisp(loc.Spill))
	} else {
		src := x64PhysicalReg(plan, value)
		if src != x64RCX {
			b.movRegReg(x64RCX, src)
		}
	}
	frameBytes, savedStatusDisp := x64MachineCallFrame(activeGPRs, 1)
	b.subRegImm32(x64RSP, uint32(frameBytes))
	b.movMemDisp32Reg(x64RSP, int32(savedStatusDisp), x64R11)
	b.callFixups = append(b.callFixups, x64CallFixup{dispPos: b.callRel32(), callee: "__swyp_rt_fs_read"})
	b.movRegMemDisp32(x64R11, x64RSP, int32(savedStatusDisp))
	b.addRegImm32(x64RSP, uint32(frameBytes))
	b.testRegReg(x64RDX, x64RDX)
	b.ioFailureFixups = append(b.ioFailureFixups, b.jccRel32(0x5))
	dest := plan.Locations[ins.Dest]
	if dest.Spill >= 0 {
		b.movMemDisp32Reg(x64RBP, x64MachineSpillDisp(dest.Spill), x64RAX)
	} else {
		reg := x64PhysicalReg(plan, ins.Dest)
		if reg != x64RAX {
			b.movRegReg(reg, x64RAX)
		}
	}
	return nil
}

func (b *x64MachineBuilder) emitCFGNetConnectInstruction(f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, activeGPRs int) error {
	if ins.Dest < 0 || int(ins.Dest) >= len(f.ValueTypes) || f.ValueTypes[ins.Dest] != Bool || len(ins.Args) != 2 {
		return fmt.Errorf("x64 net.connect: requires IPv4 bytes, u64 port and bool destination")
	}
	host, port := ins.Args[0], ins.Args[1]
	if host < 0 || int(host) >= len(f.ValueTypes) || f.ValueTypes[host] != Bytes {
		return fmt.Errorf("x64 net.connect: host must be bytes")
	}
	if port < 0 || int(port) >= len(f.ValueTypes) || f.ValueTypes[port] != U64 {
		return fmt.Errorf("x64 net.connect: port must be u64")
	}
	for i, value := range []SSAValue{host, port} {
		dst := x64RCX
		if i == 1 {
			dst = x64RDX
		}
		loc := plan.Locations[value]
		if loc.Spill >= 0 {
			b.movRegMemDisp32(dst, x64RBP, x64MachineSpillDisp(loc.Spill))
		} else {
			src := x64PhysicalReg(plan, value)
			if src != dst {
				b.movRegReg(dst, src)
			}
		}
	}
	frameBytes, savedStatusDisp := x64MachineCallFrame(activeGPRs, 2)
	b.subRegImm32(x64RSP, uint32(frameBytes))
	b.movMemDisp32Reg(x64RSP, int32(savedStatusDisp), x64R11)
	b.callFixups = append(b.callFixups, x64CallFixup{dispPos: b.callRel32(), callee: "__swyp_rt_net_connect"})
	b.movRegMemDisp32(x64R11, x64RSP, int32(savedStatusDisp))
	b.addRegImm32(x64RSP, uint32(frameBytes))
	b.testRegReg(x64RDX, x64RDX)
	b.ioFailureFixups = append(b.ioFailureFixups, b.jccRel32(0x5))
	dest := plan.Locations[ins.Dest]
	if dest.Spill >= 0 {
		b.movMemDisp32Reg(x64RBP, x64MachineSpillDisp(dest.Spill), x64RAX)
	} else {
		reg := x64PhysicalReg(plan, ins.Dest)
		if reg != x64RAX {
			b.movRegReg(reg, x64RAX)
		}
	}
	return nil
}

func (b *x64MachineBuilder) emitCFGNetFetchInstruction(f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, activeGPRs int) error {
	if ins.Dest < 0 || int(ins.Dest) >= len(f.ValueTypes) || f.ValueTypes[ins.Dest] != Bytes || len(ins.Args) != 3 {
		return fmt.Errorf("x64 net.fetch: requires IPv4 bytes, u64 port, path bytes and bytes destination")
	}
	want := []Type{Bytes, U64, Bytes}
	argRegs := []int{x64RCX, x64RDX, x64R8}
	for i, value := range ins.Args {
		if value < 0 || int(value) >= len(f.ValueTypes) || f.ValueTypes[value] != want[i] {
			return fmt.Errorf("x64 net.fetch: operand %d must be %s", i, want[i])
		}
		loc := plan.Locations[value]
		dst := argRegs[i]
		if loc.Spill >= 0 {
			b.movRegMemDisp32(dst, x64RBP, x64MachineSpillDisp(loc.Spill))
		} else {
			src := x64PhysicalReg(plan, value)
			if src != dst {
				b.movRegReg(dst, src)
			}
		}
	}
	frameBytes, savedStatusDisp := x64MachineCallFrame(activeGPRs, 3)
	b.subRegImm32(x64RSP, uint32(frameBytes))
	b.movMemDisp32Reg(x64RSP, int32(savedStatusDisp), x64R11)
	b.callFixups = append(b.callFixups, x64CallFixup{dispPos: b.callRel32(), callee: "__swyp_rt_net_fetch"})
	b.movRegMemDisp32(x64R11, x64RSP, int32(savedStatusDisp))
	b.addRegImm32(x64RSP, uint32(frameBytes))
	b.testRegReg(x64RDX, x64RDX)
	b.ioFailureFixups = append(b.ioFailureFixups, b.jccRel32(0x5))
	dest := plan.Locations[ins.Dest]
	if dest.Spill >= 0 {
		b.movMemDisp32Reg(x64RBP, x64MachineSpillDisp(dest.Spill), x64RAX)
	} else {
		reg := x64PhysicalReg(plan, ins.Dest)
		if reg != x64RAX {
			b.movRegReg(reg, x64RAX)
		}
	}
	return nil
}

func (b *x64MachineBuilder) emitCFGCallInstruction(f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, activeGPRs int) error {
	if ins.Dest < 0 || int(ins.Dest) >= len(f.ValueTypes) {
		return fmt.Errorf("x64 cfg machine call: invalid destination")
	}
	if ins.Callee == "" {
		return fmt.Errorf("x64 cfg machine call: missing callee")
	}
	if len(ins.Args) > 4 {
		return fmt.Errorf("x64 cfg machine call: supports at most 4 positional arguments")
	}
	resultType := f.ValueTypes[ins.Dest]
	if !x64MachineCallType(resultType) {
		return fmt.Errorf("x64 cfg machine call: result type %s is unsupported", resultType)
	}
	for i, value := range ins.Args {
		if value < 0 || int(value) >= len(f.ValueTypes) {
			return fmt.Errorf("x64 cfg machine call: invalid argument %d", i)
		}
		if !x64MachineCallType(f.ValueTypes[value]) {
			return fmt.Errorf("x64 cfg machine call: argument %d type %s is unsupported", i, f.ValueTypes[value])
		}
	}

	frameBytes, savedStatusDisp := x64MachineCallFrame(activeGPRs, len(ins.Args))
	b.subRegImm32(x64RSP, uint32(frameBytes))
	b.movMemDisp32Reg(x64RSP, int32(savedStatusDisp), x64R11)
	for i, value := range ins.Args {
		loc := plan.Locations[value]
		if f.ValueTypes[value] == IEEE64 {
			dstArg := i
			if loc.Spill >= 0 {
				b.movsdXMMMemDisp32(dstArg, x64RBP, x64MachineFPSpillDisp(f, plan, loc.Spill))
			} else {
				src := x64PhysicalFPReg(plan, value)
				if src != dstArg {
					b.movsdXMMXMM(dstArg, src)
				}
			}
			continue
		}
		dstArg := x64WinArgRegs[i]
		if loc.Spill >= 0 {
			b.movRegMemDisp32(dstArg, x64RBP, x64MachineSpillDisp(loc.Spill))
		} else {
			src := x64PhysicalReg(plan, value)
			if src != dstArg {
				b.movRegReg(dstArg, src)
			}
		}
	}
	if len(ins.Args) < 4 {
		b.movRegReg(x64WinArgRegs[len(ins.Args)], x64R11)
	} else {
		b.movMemDisp32Reg(x64RSP, 32, x64R11)
	}
	b.callFixups = append(b.callFixups, x64CallFixup{dispPos: b.callRel32(), callee: ins.Callee})
	b.movRegMemDisp32(x64R11, x64RSP, int32(savedStatusDisp))
	b.addRegImm32(x64RSP, uint32(frameBytes))
	b.movRegMemDisp32(x64R10, x64R11, 0)
	b.testRegReg(x64R10, x64R10)
	b.overflowFixups = append(b.overflowFixups, b.jccRel32(0x5))

	destLoc := plan.Locations[ins.Dest]
	if resultType == IEEE64 {
		if destLoc.Spill >= 0 {
			b.movsdMemDisp32XMM(x64RBP, x64MachineFPSpillDisp(f, plan, destLoc.Spill), 0)
		} else {
			dst := x64PhysicalFPReg(plan, ins.Dest)
			if dst != 0 {
				b.movsdXMMXMM(dst, 0)
			}
		}
		return nil
	}
	if destLoc.Spill >= 0 {
		b.movMemDisp32Reg(x64RBP, x64MachineSpillDisp(destLoc.Spill), x64RAX)
	} else {
		dst := x64PhysicalReg(plan, ins.Dest)
		if dst != x64RAX {
			b.movRegReg(dst, x64RAX)
		}
	}
	return nil
}

func (b *x64MachineBuilder) emitCFGFPInstruction(f SSAFunction, plan SSARegisterPlan, ins SSAInstruction) error {
	if ins.Dest < 0 {
		return fmt.Errorf("x64 cfg machine fp: instruction %s has no destination", ins.Op)
	}
	destType := f.ValueTypes[ins.Dest]
	destLoc := plan.Locations[ins.Dest]
	dstFP := 3 // volatile XMM3 scratch for spilled FP destinations
	if registerClass(destType) == RegisterFP && destLoc.Register >= 0 {
		dstFP = x64PhysicalFPReg(plan, ins.Dest)
	}
	source := func(index, scratch int) (int, Type, error) {
		if index >= len(ins.Args) {
			return 0, "", fmt.Errorf("x64 cfg machine fp: %s missing operand %d", ins.Op, index)
		}
		value := ins.Args[index]
		t := f.ValueTypes[value]
		if registerClass(t) != RegisterFP {
			return 0, t, fmt.Errorf("x64 cfg machine fp: operand %d is not floating-point", index)
		}
		loc := plan.Locations[value]
		if loc.Spill >= 0 {
			b.movsdXMMMemDisp32(scratch, x64RBP, x64MachineFPSpillDisp(f, plan, loc.Spill))
			return scratch, t, nil
		}
		return x64PhysicalFPReg(plan, value), t, nil
	}
	commitFP := func() {
		if registerClass(destType) == RegisterFP && destLoc.Spill >= 0 {
			b.movsdMemDisp32XMM(x64RBP, x64MachineFPSpillDisp(f, plan, destLoc.Spill), dstFP)
		}
	}
	if destType == F64 {
		return fmt.Errorf("x64 cfg machine fp: strict f64 is unsupported; use ieee64 or Core AOT")
	}
	if ins.Op == "bitcast_ieee64_u64" {
		if len(ins.Args) != 1 || f.ValueTypes[ins.Args[0]] != IEEE64 || destType != U64 {
			return fmt.Errorf("x64 cfg machine fp: bitcast_ieee64_u64 requires ieee64 -> u64")
		}
		a, _, err := source(0, 4)
		if err != nil {
			return err
		}
		raw := x64RAX
		if destLoc.Spill < 0 {
			raw = x64PhysicalReg(plan, ins.Dest)
		}
		b.movqRegXMM(raw, a)
		if destLoc.Spill >= 0 {
			b.movMemDisp32Reg(x64RBP, x64MachineSpillDisp(destLoc.Spill), raw)
		}
		return nil
	}
	if ins.Op == "bitcast_u64_ieee64" {
		if len(ins.Args) != 1 || f.ValueTypes[ins.Args[0]] != U64 || destType != IEEE64 {
			return fmt.Errorf("x64 cfg machine fp: bitcast_u64_ieee64 requires u64 -> ieee64")
		}
		value := ins.Args[0]
		loc := plan.Locations[value]
		raw := x64R10
		if loc.Spill >= 0 {
			b.movRegMemDisp32(raw, x64RBP, x64MachineSpillDisp(loc.Spill))
		} else {
			raw = x64PhysicalReg(plan, value)
		}
		b.movqXMMReg(dstFP, raw)
		commitFP()
		return nil
	}

	switch ins.Op {
	case "call":
		return fmt.Errorf("x64 cfg machine fp: FP native calls are not supported yet")
	case "const":
		if ins.Constant == nil || ins.Constant.Type != IEEE64 {
			return fmt.Errorf("x64 cfg machine fp: only ieee64 constants are supported")
		}
		v, err := ParseValue(IEEE64, ins.Constant.Value)
		if err != nil {
			return err
		}
		b.movRegImm64(x64R10, valueToRaw(v))
		b.movqXMMReg(dstFP, x64R10)
		commitFP()
		return nil
	case "move":
		a, at, err := source(0, 4)
		if err != nil {
			return err
		}
		if at != IEEE64 || destType != IEEE64 {
			return fmt.Errorf("x64 cfg machine fp: move requires ieee64")
		}
		if dstFP != a {
			b.movsdXMMXMM(dstFP, a)
		}
		commitFP()
		return nil
	case "neg":
		a, at, err := source(0, 4)
		if err != nil {
			return err
		}
		if at != IEEE64 || destType != IEEE64 {
			return fmt.Errorf("x64 cfg machine fp: neg requires ieee64")
		}
		b.movqRegXMM(x64R10, a)
		b.movRegImm64(x64RAX, 0x8000000000000000)
		b.binaryRegReg(0x31, x64R10, x64RAX)
		b.movqXMMReg(dstFP, x64R10)
		commitFP()
		return nil
	case "add", "sub", "mul", "div":
		a, at, err := source(0, 4)
		if err != nil {
			return err
		}
		c, bt, err := source(1, 5)
		if err != nil {
			return err
		}
		if at != IEEE64 || bt != IEEE64 || destType != IEEE64 {
			return fmt.Errorf("x64 cfg machine fp: %s requires ieee64", ins.Op)
		}
		op := map[string]byte{"add": 0x58, "sub": 0x5c, "mul": 0x59, "div": 0x5e}[ins.Op]
		target := dstFP
		switch {
		case dstFP == a:
		case dstFP == c:
			// The destination register aliases the right operand, whose live
			// range ends here. Copying a into it first would clobber c, so build
			// the result in the XMM4 source scratch and move it afterwards.
			target = 4
			if a != target {
				b.movsdXMMXMM(target, a)
			}
		default:
			b.movsdXMMXMM(dstFP, a)
		}
		b.scalarSDRegReg(op, target, c)
		if target != dstFP {
			b.movsdXMMXMM(dstFP, target)
		}
		commitFP()
		return nil
	case "eq", "ne", "lt", "le", "gt", "ge":
		a, at, err := source(0, 4)
		if err != nil {
			return err
		}
		c, bt, err := source(1, 5)
		if err != nil {
			return err
		}
		if at != IEEE64 || bt != IEEE64 || destType != Bool {
			return fmt.Errorf("x64 cfg machine fp: comparison requires ieee64 operands and bool result")
		}
		dst := x64RAX
		if destLoc.Spill < 0 {
			dst = x64PhysicalReg(plan, ins.Dest)
		}
		b.ucomisd(a, c)
		b.movRegImm64(dst, 0)
		switch ins.Op {
		case "eq":
			b.setcc(dst, 0x4)
			b.setcc(x64R10, 0xb) // SETNP
			b.byteBinaryRegReg(0x20, dst, x64R10)
		case "ne":
			b.setcc(dst, 0x5)
			b.setcc(x64R10, 0xa) // SETP
			b.byteBinaryRegReg(0x08, dst, x64R10)
		case "lt":
			b.setcc(dst, 0x2)
			b.setcc(x64R10, 0xb)
			b.byteBinaryRegReg(0x20, dst, x64R10)
		case "le":
			b.setcc(dst, 0x6)
			b.setcc(x64R10, 0xb)
			b.byteBinaryRegReg(0x20, dst, x64R10)
		case "gt":
			b.setcc(dst, 0x7)
		case "ge":
			b.setcc(dst, 0x3)
		}
		if destLoc.Spill >= 0 {
			b.movMemDisp32Reg(x64RBP, x64MachineSpillDisp(destLoc.Spill), dst)
		}
		return nil
	default:
		return fmt.Errorf("x64 cfg machine fp: unsupported ieee64 operation %q", ins.Op)
	}
}

func x64MachineCallFrame(activeGPRs, argCount int) (frameBytes, savedStatusDisp int) {
	// Win64 requires 32 bytes of shadow space. Keep the caller's status pointer
	// in a private slot beyond the shadow area; for four program arguments, the
	// fifth argument slot at [rsp+32] is reserved for the callee's status pointer.
	minBytes := 40
	savedStatusDisp = 32
	if argCount == 4 {
		minBytes = 48
		savedStatusDisp = 40
	}
	if activeGPRs%2 == 0 {
		return (minBytes + 15) &^ 15, savedStatusDisp
	}
	return ((minBytes + 7) &^ 15) + 8, savedStatusDisp
}

func patchX64Rel32(code []byte, dispPos, targetOffset int) {
	rel := int32(targetOffset - (dispPos + 4))
	binary.LittleEndian.PutUint32(code[dispPos:dispPos+4], uint32(rel))
}

func (b *x64MachineBuilder) jmpRel32() int {
	b.code = append(b.code, 0xe9)
	pos := len(b.code)
	b.code = append(b.code, 0, 0, 0, 0)
	return pos
}

func (b *x64MachineBuilder) jccRel32(cc byte) int {
	b.code = append(b.code, 0x0f, 0x80|cc)
	pos := len(b.code)
	b.code = append(b.code, 0, 0, 0, 0)
	return pos
}

func (b *x64MachineBuilder) callRel32() int {
	b.code = append(b.code, 0xe8)
	pos := len(b.code)
	b.code = append(b.code, 0, 0, 0, 0)
	return pos
}

func (b *x64MachineBuilder) testRegReg(a, c int) {
	b.rex(true, c, a)
	b.code = append(b.code, 0x85, modRM(3, c, a))
}
