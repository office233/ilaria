package coreir

import (
	"bytes"
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// X64LeafABI is the first direct-backend ABI:
//   - public wrapper: normal Win64 scalar args + final uint64_t* status
//   - public result: raw scalar in RAX
//   - *status: 0 success, 1 overflow
//   - internal raw function: program args in RCX/RDX/R8/R9, RAX value, RDX status
//
// The leaf machine-code emitter remains deliberately strict. The CFG assembly
// backend additionally supports branches, phi nodes and GPR stack spills.
const X64LeafABI = "swyp-x64-leaf-win64-v1"
const X64CFGABI = "swyp-x64-cfg-win64-v1"

var x64LeafRegisters = []struct {
	qword string
	byte  string
}{
	{"rbx", "bl"},
	{"rsi", "sil"},
	{"rdi", "dil"},
	{"r12", "r12b"},
	{"r13", "r13b"},
	{"r14", "r14b"},
	{"r15", "r15b"},
}

var x64Win64Args = []string{"rcx", "rdx", "r8", "r9"}
var x64FPRegisters = []string{"xmm6", "xmm7", "xmm8", "xmm9", "xmm10", "xmm11", "xmm12", "xmm13", "xmm14", "xmm15"}

func X64LeafRegisterCount() int { return len(x64LeafRegisters) }
func X64FPRegisterCount() int   { return len(x64FPRegisters) }

func X64LeafSymbol(name string) string {
	return "swyp_core_" + sanitizeX64Symbol(name)
}

func EmitX64LeafSSA(f SSAFunction, plan SSARegisterPlan) ([]byte, error) {
	if len(plan.Locations) != len(f.ValueTypes) {
		return nil, fmt.Errorf("x64: register plan/value count mismatch")
	}
	if len(f.Params) > len(x64Win64Args) {
		return nil, fmt.Errorf("x64: leaf v1 supports at most %d parameters", len(x64Win64Args))
	}
	reachable := -1
	for bi, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		if reachable >= 0 {
			return nil, fmt.Errorf("x64: leaf v1 supports one reachable block")
		}
		reachable = bi
		if len(block.Phis) != 0 {
			return nil, fmt.Errorf("x64: leaf v1 does not support phi nodes")
		}
	}
	if reachable < 0 {
		return nil, fmt.Errorf("x64: no reachable block")
	}
	block := f.Blocks[reachable]
	if block.Terminator.Op != "return" {
		return nil, fmt.Errorf("x64: leaf v1 requires return terminator")
	}
	for value, t := range f.ValueTypes {
		if t == F64 {
			return nil, fmt.Errorf("x64: strict f64 is not supported by direct backend yet; use ieee64 or Core AOT")
		}
		loc := plan.Locations[value]
		limit := len(x64LeafRegisters)
		if registerClass(t) == RegisterFP {
			limit = len(x64FPRegisters)
		}
		if loc.Spill >= 0 || loc.Register < 0 || loc.Register >= limit {
			return nil, fmt.Errorf("x64: leaf v1 requires spill-free allocation, value %d location=%+v", value, loc)
		}
	}
	for _, ins := range block.Instructions {
		if ins.Op == "call" {
			return nil, fmt.Errorf("x64: leaf v1 does not support calls")
		}
	}

	symbol := X64LeafSymbol(f.Name)
	rawSymbol := symbol + "_raw"
	usedRegs := make([]bool, len(x64LeafRegisters))
	usedFP := make([]bool, len(x64FPRegisters))
	for value, loc := range plan.Locations {
		if loc.Register >= 0 {
			if registerClass(f.ValueTypes[value]) == RegisterFP {
				usedFP[loc.Register] = true
			} else {
				usedRegs[loc.Register] = true
			}
		}
	}

	var b bytes.Buffer
	b.WriteString(".intel_syntax noprefix\n")
	b.WriteString(".text\n")
	fmt.Fprintf(&b, ".globl %s\n%s:\n", symbol, symbol)
	statusSource := "rcx"
	switch len(f.Params) {
	case 0:
		statusSource = "rcx"
	case 1:
		statusSource = "rdx"
	case 2:
		statusSource = "r8"
	case 3:
		statusSource = "r9"
	case 4:
		// Win64 fifth argument is above return address + 32-byte shadow space.
		statusSource = "[rsp+40]"
	}
	fmt.Fprintf(&b, "    mov r10, %s\n", statusSource)
	b.WriteString("    sub rsp, 40\n")
	b.WriteString("    mov QWORD PTR [rsp+32], r10\n")
	fmt.Fprintf(&b, "    call %s\n", rawSymbol)
	b.WriteString("    mov r10, QWORD PTR [rsp+32]\n")
	b.WriteString("    add rsp, 40\n")
	b.WriteString("    mov QWORD PTR [r10], rdx\n")
	b.WriteString("    ret\n")
	fmt.Fprintf(&b, "%s:\n", rawSymbol)
	for reg, used := range usedRegs {
		if used {
			fmt.Fprintf(&b, "    push %s\n", x64LeafRegisters[reg].qword)
		}
	}
	for reg, used := range usedFP {
		if used {
			b.WriteString("    sub rsp, 16\n")
			fmt.Fprintf(&b, "    movdqu XMMWORD PTR [rsp], %s\n", x64FPRegisters[reg])
		}
	}
	for i, value := range f.Params {
		if registerClass(f.ValueTypes[value]) == RegisterFP {
			dst := x64FPReg(plan, value)
			src := fmt.Sprintf("xmm%d", i)
			if dst != src {
				fmt.Fprintf(&b, "    movsd %s, %s\n", dst, src)
			}
		} else {
			dst := x64Reg(plan, value)
			if dst != x64Win64Args[i] {
				fmt.Fprintf(&b, "    mov %s, %s\n", dst, x64Win64Args[i])
			}
		}
	}
	for _, ins := range block.Instructions {
		if err := emitX64LeafInstruction(&b, f, plan, ins, 0); err != nil {
			return nil, err
		}
	}
	if block.Terminator.Value >= 0 {
		if registerClass(f.ValueTypes[block.Terminator.Value]) == RegisterFP {
			result := x64FPReg(plan, block.Terminator.Value)
			if result != "xmm0" {
				fmt.Fprintf(&b, "    movsd xmm0, %s\n", result)
			}
		} else {
			result := x64Reg(plan, block.Terminator.Value)
			if result != "rax" {
				fmt.Fprintf(&b, "    mov rax, %s\n", result)
			}
		}
	} else {
		b.WriteString("    xor eax, eax\n")
	}
	b.WriteString("    xor edx, edx\n")
	b.WriteString("    jmp .Lswyp_epilogue\n")
	b.WriteString(".Lswyp_overflow:\n")
	b.WriteString("    xor eax, eax\n")
	b.WriteString("    mov edx, 1\n")
	b.WriteString(".Lswyp_epilogue:\n")
	for reg := len(usedFP) - 1; reg >= 0; reg-- {
		if usedFP[reg] {
			fmt.Fprintf(&b, "    movdqu %s, XMMWORD PTR [rsp]\n", x64FPRegisters[reg])
			b.WriteString("    add rsp, 16\n")
		}
	}
	for reg := len(usedRegs) - 1; reg >= 0; reg-- {
		if usedRegs[reg] {
			fmt.Fprintf(&b, "    pop %s\n", x64LeafRegisters[reg].qword)
		}
	}
	b.WriteString("    ret\n")
	return b.Bytes(), nil
}

// EmitX64SSA emits direct Win64 x86-64 assembly for a call-free
// SSA function with integer/bool values. Unlike EmitX64LeafSSA it supports
// multiple reachable CFG blocks and phi nodes. Phi assignments are lowered on
// predecessor edges using balanced stack copies, which preserves parallel-copy
// semantics even when the register mapping forms a cycle.
//
// GPR spills are materialized in an rbp-relative stack frame. FP spills remain
// explicit future work and fail closed.
func EmitX64SSA(f SSAFunction, plan SSARegisterPlan) ([]byte, error) {
	if len(plan.Locations) != len(f.ValueTypes) {
		return nil, fmt.Errorf("x64 cfg: register plan/value count mismatch")
	}
	if len(f.Params) > len(x64Win64Args) {
		return nil, fmt.Errorf("x64 cfg: supports at most %d parameters", len(x64Win64Args))
	}
	reachable := 0
	for bi, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		reachable++
		for _, phi := range block.Phis {
			if phi.Dest < 0 || int(phi.Dest) >= len(f.ValueTypes) {
				return nil, fmt.Errorf("x64 cfg: block %d invalid phi destination %d", bi, phi.Dest)
			}
		}
	}
	if reachable == 0 {
		return nil, fmt.Errorf("x64 cfg: no reachable blocks")
	}
	for value, t := range f.ValueTypes {
		if t == F64 {
			return nil, fmt.Errorf("x64 cfg: strict f64 is not supported by direct backend yet; use ieee64 or Core AOT")
		}
		loc := plan.Locations[value]
		limit := len(x64LeafRegisters)
		if registerClass(t) == RegisterFP {
			limit = len(x64FPRegisters)
		}
		if loc.Spill >= 0 {
			continue
		}
		if loc.Register < 0 || loc.Register >= limit {
			return nil, fmt.Errorf("x64 cfg: invalid allocation for value %d location=%+v", value, loc)
		}
	}

	symbol := X64LeafSymbol(f.Name)
	rawSymbol := symbol + "_raw"
	usedRegs := make([]bool, len(x64LeafRegisters))
	usedFP := make([]bool, len(x64FPRegisters))
	for value, loc := range plan.Locations {
		if loc.Register >= 0 {
			if registerClass(f.ValueTypes[value]) == RegisterFP {
				usedFP[loc.Register] = true
			} else {
				usedRegs[loc.Register] = true
			}
		}
	}
	activeGPRs := 0
	for _, used := range usedRegs {
		if used {
			activeGPRs++
		}
	}
	callFrameBytes := 32
	if activeGPRs%2 == 1 {
		callFrameBytes = 40
	}

	var b bytes.Buffer
	b.WriteString(".intel_syntax noprefix\n")
	b.WriteString(".text\n")
	fmt.Fprintf(&b, ".globl %s\n%s:\n", symbol, symbol)
	statusSource := "rcx"
	switch len(f.Params) {
	case 1:
		statusSource = "rdx"
	case 2:
		statusSource = "r8"
	case 3:
		statusSource = "r9"
	case 4:
		statusSource = "[rsp+40]"
	}
	fmt.Fprintf(&b, "    mov r10, %s\n", statusSource)
	b.WriteString("    sub rsp, 40\n")
	b.WriteString("    mov QWORD PTR [rsp+32], r10\n")
	fmt.Fprintf(&b, "    call %s\n", rawSymbol)
	b.WriteString("    mov r10, QWORD PTR [rsp+32]\n")
	b.WriteString("    add rsp, 40\n")
	b.WriteString("    mov QWORD PTR [r10], rdx\n")
	b.WriteString("    ret\n")
	fmt.Fprintf(&b, "%s:\n", rawSymbol)
	b.WriteString("    push rbp\n")
	for reg, used := range usedRegs {
		if used {
			fmt.Fprintf(&b, "    push %s\n", x64LeafRegisters[reg].qword)
		}
	}
	for reg, used := range usedFP {
		if used {
			b.WriteString("    sub rsp, 16\n")
			fmt.Fprintf(&b, "    movdqu XMMWORD PTR [rsp], %s\n", x64FPRegisters[reg])
		}
	}
	b.WriteString("    mov rbp, rsp\n")
	spillBytes := x64SpillFrameBytes(f, plan)
	if spillBytes > 0 {
		fmt.Fprintf(&b, "    sub rsp, %d\n", spillBytes)
	}
	for i, value := range f.Params {
		if registerClass(f.ValueTypes[value]) == RegisterFP {
			src := fmt.Sprintf("xmm%d", i)
			loc := plan.Locations[value]
			if loc.Spill >= 0 {
				fmt.Fprintf(&b, "    movsd %s, %s\n", x64FPSpillOperand(f, plan, loc.Spill), src)
			} else {
				dst := x64FPReg(plan, value)
				if dst != src {
					fmt.Fprintf(&b, "    movsd %s, %s\n", dst, src)
				}
			}
		} else {
			loc := plan.Locations[value]
			if loc.Spill >= 0 {
				fmt.Fprintf(&b, "    mov %s, %s\n", x64SpillOperand(loc.Spill), x64Win64Args[i])
			} else {
				dst := x64Reg(plan, value)
				if dst != x64Win64Args[i] {
					fmt.Fprintf(&b, "    mov %s, %s\n", dst, x64Win64Args[i])
				}
			}
		}
	}
	b.WriteString("    jmp .Lswyp_b0\n")

	for bi, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		fmt.Fprintf(&b, ".Lswyp_b%d:\n", bi)
		for _, ins := range block.Instructions {
			if err := emitX64LeafInstruction(&b, f, plan, ins, callFrameBytes); err != nil {
				return nil, fmt.Errorf("x64 cfg block %d: %w", bi, err)
			}
		}
		switch block.Terminator.Op {
		case "return":
			if block.Terminator.Value >= 0 {
				if registerClass(f.ValueTypes[block.Terminator.Value]) == RegisterFP {
					loc := plan.Locations[block.Terminator.Value]
					if loc.Spill >= 0 {
						fmt.Fprintf(&b, "    movsd xmm0, %s\n", x64FPSpillOperand(f, plan, loc.Spill))
					} else {
						result := x64FPReg(plan, block.Terminator.Value)
						if result != "xmm0" {
							fmt.Fprintf(&b, "    movsd xmm0, %s\n", result)
						}
					}
				} else {
					loc := plan.Locations[block.Terminator.Value]
					if loc.Spill >= 0 {
						fmt.Fprintf(&b, "    mov rax, %s\n", x64SpillOperand(loc.Spill))
					} else {
						result := x64Reg(plan, block.Terminator.Value)
						if result != "rax" {
							fmt.Fprintf(&b, "    mov rax, %s\n", result)
						}
					}
				}
			} else {
				b.WriteString("    xor eax, eax\n")
			}
			b.WriteString("    xor edx, edx\n")
			b.WriteString("    jmp .Lswyp_epilogue\n")
		case "jump":
			if len(block.Terminator.Targets) != 1 {
				return nil, fmt.Errorf("x64 cfg: block %d jump target count %d", bi, len(block.Terminator.Targets))
			}
			target := block.Terminator.Targets[0]
			if err := emitX64PhiEdgeCopies(&b, f, plan, bi, target); err != nil {
				return nil, err
			}
			fmt.Fprintf(&b, "    jmp .Lswyp_b%d\n", target)
		case "branch":
			if len(block.Terminator.Targets) != 2 || block.Terminator.Value < 0 {
				return nil, fmt.Errorf("x64 cfg: invalid branch in block %d", bi)
			}
			falseEdge := fmt.Sprintf(".Lswyp_edge_b%d_false", bi)
			condLoc := plan.Locations[block.Terminator.Value]
			if condLoc.Spill >= 0 {
				fmt.Fprintf(&b, "    cmp %s, 0\n", x64SpillOperand(condLoc.Spill))
			} else {
				fmt.Fprintf(&b, "    cmp %s, 0\n", x64Reg(plan, block.Terminator.Value))
			}
			fmt.Fprintf(&b, "    je %s\n", falseEdge)
			if err := emitX64PhiEdgeCopies(&b, f, plan, bi, block.Terminator.Targets[0]); err != nil {
				return nil, err
			}
			fmt.Fprintf(&b, "    jmp .Lswyp_b%d\n", block.Terminator.Targets[0])
			fmt.Fprintf(&b, "%s:\n", falseEdge)
			if err := emitX64PhiEdgeCopies(&b, f, plan, bi, block.Terminator.Targets[1]); err != nil {
				return nil, err
			}
			fmt.Fprintf(&b, "    jmp .Lswyp_b%d\n", block.Terminator.Targets[1])
		default:
			return nil, fmt.Errorf("x64 cfg: unsupported terminator %q in block %d", block.Terminator.Op, bi)
		}
	}

	b.WriteString(".Lswyp_overflow:\n")
	b.WriteString("    xor eax, eax\n")
	b.WriteString("    mov edx, 1\n")
	b.WriteString(".Lswyp_epilogue:\n")
	b.WriteString("    mov rsp, rbp\n")
	for reg := len(usedFP) - 1; reg >= 0; reg-- {
		if usedFP[reg] {
			fmt.Fprintf(&b, "    movdqu %s, XMMWORD PTR [rsp]\n", x64FPRegisters[reg])
			b.WriteString("    add rsp, 16\n")
		}
	}
	for reg := len(usedRegs) - 1; reg >= 0; reg-- {
		if usedRegs[reg] {
			fmt.Fprintf(&b, "    pop %s\n", x64LeafRegisters[reg].qword)
		}
	}
	b.WriteString("    pop rbp\n")
	b.WriteString("    ret\n")
	return b.Bytes(), nil
}

func emitX64PhiEdgeCopies(b *bytes.Buffer, f SSAFunction, plan SSARegisterPlan, predecessor, target int) error {
	if target < 0 || target >= len(f.Blocks) || !f.Blocks[target].Reachable {
		return fmt.Errorf("x64 cfg: invalid edge %d -> %d", predecessor, target)
	}
	type move struct {
		dst   RegisterLocation
		src   RegisterLocation
		class RegisterClass
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
			return fmt.Errorf("x64 cfg: phi %d in block %d has no input from predecessor %d", phi.Dest, target, predecessor)
		}
		class := registerClass(f.ValueTypes[phi.Dest])
		if class != registerClass(f.ValueTypes[input]) {
			return fmt.Errorf("x64 cfg: phi %d class mismatch on edge %d -> %d", phi.Dest, predecessor, target)
		}
		dst, src := plan.Locations[phi.Dest], plan.Locations[input]
		if dst != src {
			moves = append(moves, move{dst: dst, src: src, class: class})
		}
	}
	// Save every source before changing any destination. This is intentionally
	// conservative but gives correct parallel-copy semantics even for cycles.
	for _, m := range moves {
		if m.class == RegisterFP {
			b.WriteString("    sub rsp, 8\n")
			if m.src.Spill >= 0 {
				fmt.Fprintf(b, "    movsd xmm5, %s\n", x64FPSpillOperand(f, plan, m.src.Spill))
				b.WriteString("    movsd QWORD PTR [rsp], xmm5\n")
			} else {
				fmt.Fprintf(b, "    movsd QWORD PTR [rsp], %s\n", x64FPRegisters[m.src.Register])
			}
		} else {
			if m.src.Spill >= 0 {
				fmt.Fprintf(b, "    push %s\n", x64SpillOperand(m.src.Spill))
			} else {
				fmt.Fprintf(b, "    push %s\n", x64LeafRegisters[m.src.Register].qword)
			}
		}
	}
	for i := len(moves) - 1; i >= 0; i-- {
		if moves[i].class == RegisterFP {
			if moves[i].dst.Spill >= 0 {
				b.WriteString("    movsd xmm5, QWORD PTR [rsp]\n")
				fmt.Fprintf(b, "    movsd %s, xmm5\n", x64FPSpillOperand(f, plan, moves[i].dst.Spill))
			} else {
				fmt.Fprintf(b, "    movsd %s, QWORD PTR [rsp]\n", x64FPRegisters[moves[i].dst.Register])
			}
			b.WriteString("    add rsp, 8\n")
		} else {
			if moves[i].dst.Spill >= 0 {
				b.WriteString("    pop r10\n")
				fmt.Fprintf(b, "    mov %s, r10\n", x64SpillOperand(moves[i].dst.Spill))
			} else {
				fmt.Fprintf(b, "    pop %s\n", x64LeafRegisters[moves[i].dst.Register].qword)
			}
		}
	}
	return nil
}

func emitX64LeafInstruction(b *bytes.Buffer, f SSAFunction, plan SSARegisterPlan, ins SSAInstruction, callFrameBytes int) error {
	if ins.Dest < 0 {
		return fmt.Errorf("x64: leaf v1 instruction %s has no destination", ins.Op)
	}
	t := f.ValueTypes[ins.Dest]
	if registerClass(t) == RegisterFP || (len(ins.Args) > 0 && registerClass(f.ValueTypes[ins.Args[0]]) == RegisterFP) {
		return emitX64FPInstruction(b, f, plan, ins)
	}
	destLoc := plan.Locations[ins.Dest]
	dst := "rax"
	dst8 := "al"
	if destLoc.Spill < 0 {
		dst = x64Reg(plan, ins.Dest)
		dst8 = x64Reg8(plan, ins.Dest)
	}
	commit := func() {
		if destLoc.Spill >= 0 {
			fmt.Fprintf(b, "    mov %s, %s\n", x64SpillOperand(destLoc.Spill), dst)
		}
	}
	arg := func(index int, scratch string) (string, Type, error) {
		if index >= len(ins.Args) {
			return "", "", fmt.Errorf("x64: %s missing operand %d", ins.Op, index)
		}
		value := ins.Args[index]
		loc := plan.Locations[value]
		if loc.Spill >= 0 {
			fmt.Fprintf(b, "    mov %s, %s\n", scratch, x64SpillOperand(loc.Spill))
			return scratch, f.ValueTypes[value], nil
		}
		return x64Reg(plan, value), f.ValueTypes[value], nil
	}
	switch ins.Op {
	case "call":
		if callFrameBytes == 0 {
			return fmt.Errorf("x64: calls are not supported in leaf machine-code mode")
		}
		if ins.Callee == "" {
			return fmt.Errorf("x64: call missing callee")
		}
		if len(ins.Args) > 4 {
			return fmt.Errorf("x64: native call supports at most 4 GPR arguments")
		}
		if registerClass(t) != RegisterGPR {
			return fmt.Errorf("x64: native call result type %s is not GPR scalar", t)
		}
		fmt.Fprintf(b, "    sub rsp, %d\n", callFrameBytes)
		for i, value := range ins.Args {
			if registerClass(f.ValueTypes[value]) != RegisterGPR {
				return fmt.Errorf("x64: native call argument %d type %s is not GPR scalar", i, f.ValueTypes[value])
			}
			dstArg := x64Win64Args[i]
			loc := plan.Locations[value]
			if loc.Spill >= 0 {
				fmt.Fprintf(b, "    mov %s, %s\n", dstArg, x64SpillOperand(loc.Spill))
			} else {
				src := x64Reg(plan, value)
				if src != dstArg {
					fmt.Fprintf(b, "    mov %s, %s\n", dstArg, src)
				}
			}
		}
		fmt.Fprintf(b, "    call %s_raw\n", X64LeafSymbol(ins.Callee))
		b.WriteString("    test rdx, rdx\n")
		b.WriteString("    jne .Lswyp_overflow\n")
		if destLoc.Spill >= 0 {
			fmt.Fprintf(b, "    mov %s, rax\n", x64SpillOperand(destLoc.Spill))
		} else if dst != "rax" {
			fmt.Fprintf(b, "    mov %s, rax\n", dst)
		}
		fmt.Fprintf(b, "    add rsp, %d\n", callFrameBytes)
		return nil
	case "const":
		if ins.Constant == nil {
			return fmt.Errorf("x64: const missing literal")
		}
		v, err := ParseValue(ins.Constant.Type, ins.Constant.Value)
		if err != nil {
			return err
		}
		fmt.Fprintf(b, "    mov %s, 0x%016x\n", dst, valueToRaw(v))
		commit()
		return nil
	case "move":
		a, _, err := arg(0, "r10")
		if err != nil {
			return err
		}
		if dst != a {
			fmt.Fprintf(b, "    mov %s, %s\n", dst, a)
		}
		commit()
		return nil
	case "neg":
		a, at, err := arg(0, "r10")
		if err != nil {
			return err
		}
		if at != I64 && at != U64 {
			return fmt.Errorf("x64: neg unsupported type %s", at)
		}
		if dst != a {
			fmt.Fprintf(b, "    mov %s, %s\n", dst, a)
		}
		fmt.Fprintf(b, "    neg %s\n", dst)
		if at == I64 {
			b.WriteString("    jo .Lswyp_overflow\n")
		}
		commit()
		return nil
	case "not":
		a, at, err := arg(0, "r10")
		if err != nil {
			return err
		}
		if at != Bool {
			return fmt.Errorf("x64: not requires bool")
		}
		if dst != a {
			fmt.Fprintf(b, "    mov %s, %s\n", dst, a)
		}
		fmt.Fprintf(b, "    xor %s, 1\n", dst)
		commit()
		return nil
	case "eq", "ne", "lt", "le", "gt", "ge":
		a, at, err := arg(0, "r10")
		if err != nil {
			return err
		}
		c, bt, err := arg(1, "r11")
		if err != nil {
			return err
		}
		if at != bt || (at != I64 && at != U64 && at != Bool) {
			return fmt.Errorf("x64: comparison unsupported operands %s/%s", at, bt)
		}
		fmt.Fprintf(b, "    cmp %s, %s\n", a, c)
		// MOV preserves comparison flags. XOR would clobber them before SETcc.
		fmt.Fprintf(b, "    mov %s, 0\n", dst)
		cc, err := x64Condition(ins.Op, at)
		if err != nil {
			return err
		}
		fmt.Fprintf(b, "    set%s %s\n", cc, dst8)
		commit()
		return nil
	case "add", "sub", "mul", "band", "bor", "bxor":
		a, at, err := arg(0, "r10")
		if err != nil {
			return err
		}
		c, bt, err := arg(1, "r11")
		if err != nil {
			return err
		}
		if at != bt || (at != I64 && at != U64) {
			return fmt.Errorf("x64: %s unsupported operands %s/%s", ins.Op, at, bt)
		}
		asmOp := map[string]string{"add": "add", "sub": "sub", "mul": "imul", "band": "and", "bor": "or", "bxor": "xor"}[ins.Op]
		commutative := ins.Op == "add" || ins.Op == "mul" || ins.Op == "band" || ins.Op == "bor" || ins.Op == "bxor"
		if destLoc.Spill >= 0 {
			fmt.Fprintf(b, "    mov %s, %s\n", dst, a)
			fmt.Fprintf(b, "    %s %s, %s\n", asmOp, dst, c)
		} else if dst == a {
			fmt.Fprintf(b, "    %s %s, %s\n", asmOp, dst, c)
		} else if dst == c && commutative {
			fmt.Fprintf(b, "    %s %s, %s\n", asmOp, dst, a)
		} else if dst == c {
			fmt.Fprintf(b, "    mov rax, %s\n", a)
			fmt.Fprintf(b, "    %s rax, %s\n", asmOp, c)
			if at == I64 && (ins.Op == "add" || ins.Op == "sub" || ins.Op == "mul") {
				b.WriteString("    jo .Lswyp_overflow\n")
			}
			fmt.Fprintf(b, "    mov %s, rax\n", dst)
			return nil
		} else {
			fmt.Fprintf(b, "    mov %s, %s\n", dst, a)
			fmt.Fprintf(b, "    %s %s, %s\n", asmOp, dst, c)
		}
		if at == I64 && (ins.Op == "add" || ins.Op == "sub" || ins.Op == "mul") {
			b.WriteString("    jo .Lswyp_overflow\n")
		}
		commit()
		return nil
	default:
		return fmt.Errorf("x64: leaf v1 unsupported operation %q result=%s", ins.Op, t)
	}
}

// EmitX64SSAModule emits all supplied CFG functions into one assembly unit.
// Each function keeps its normal public wrapper so direct calls can reuse the
// same status-pointer ABI. Function-local labels are namespaced before
// concatenation to avoid collisions.
func EmitX64SSAModule(functions []SSAFunction, plans map[string]SSARegisterPlan) ([]byte, error) {
	if len(functions) == 0 {
		return nil, fmt.Errorf("x64 module: no functions")
	}
	seen := make(map[string]bool, len(functions))
	var out bytes.Buffer
	for _, f := range functions {
		if f.Name == "" || seen[f.Name] {
			return nil, fmt.Errorf("x64 module: duplicate/empty function %q", f.Name)
		}
		seen[f.Name] = true
		plan, ok := plans[f.Name]
		if !ok {
			return nil, fmt.Errorf("x64 module: missing register plan for %s", f.Name)
		}
		asm, err := EmitX64SSA(f, plan)
		if err != nil {
			return nil, fmt.Errorf("x64 module %s: %w", f.Name, err)
		}
		prefix := []byte(".Lswyp_" + sanitizeX64Symbol(f.Name) + "_")
		asm = bytes.ReplaceAll(asm, []byte(".Lswyp_"), prefix)
		out.Write(asm)
		out.WriteByte('\n')
	}
	return out.Bytes(), nil
}

func x64GPRSpillBytes(f SSAFunction, plan SSARegisterPlan) int {
	maxSpill := -1
	for value, loc := range plan.Locations {
		if registerClass(f.ValueTypes[value]) != RegisterGPR || loc.Spill < 0 {
			continue
		}
		if loc.Spill > maxSpill {
			maxSpill = loc.Spill
		}
	}
	if maxSpill < 0 {
		return 0
	}
	bytes := (maxSpill + 1) * 8
	return (bytes + 15) &^ 15
}

func x64SpillOperand(spill int) string {
	return fmt.Sprintf("QWORD PTR [rbp-%d]", (spill+1)*8)
}

func x64FPSpillBytes(f SSAFunction, plan SSARegisterPlan) int {
	maxSpill := -1
	for value, loc := range plan.Locations {
		if registerClass(f.ValueTypes[value]) != RegisterFP || loc.Spill < 0 {
			continue
		}
		if loc.Spill > maxSpill {
			maxSpill = loc.Spill
		}
	}
	if maxSpill < 0 {
		return 0
	}
	return (maxSpill + 1) * 8
}

func x64SpillFrameBytes(f SSAFunction, plan SSARegisterPlan) int {
	bytes := x64GPRSpillBytes(f, plan) + x64FPSpillBytes(f, plan)
	return (bytes + 15) &^ 15
}

func x64FPSpillOperand(f SSAFunction, plan SSARegisterPlan, spill int) string {
	offset := x64GPRSpillBytes(f, plan) + (spill+1)*8
	return fmt.Sprintf("QWORD PTR [rbp-%d]", offset)
}

func emitX64FPInstruction(b *bytes.Buffer, f SSAFunction, plan SSARegisterPlan, ins SSAInstruction) error {
	if ins.Dest < 0 {
		return fmt.Errorf("x64 fp: instruction %s has no destination", ins.Op)
	}
	destType := f.ValueTypes[ins.Dest]
	destLoc := plan.Locations[ins.Dest]
	dstFP := "xmm3"
	if registerClass(destType) == RegisterFP && destLoc.Register >= 0 {
		dstFP = x64FPReg(plan, ins.Dest)
	}
	source := func(index int, scratch string) (string, Type, error) {
		if index >= len(ins.Args) {
			return "", "", fmt.Errorf("x64 fp: %s missing operand %d", ins.Op, index)
		}
		value := ins.Args[index]
		if registerClass(f.ValueTypes[value]) != RegisterFP {
			return "", f.ValueTypes[value], fmt.Errorf("x64 fp: operand %d is not floating-point", index)
		}
		loc := plan.Locations[value]
		if loc.Spill >= 0 {
			fmt.Fprintf(b, "    movsd %s, %s\n", scratch, x64FPSpillOperand(f, plan, loc.Spill))
			return scratch, f.ValueTypes[value], nil
		}
		return x64FPReg(plan, value), f.ValueTypes[value], nil
	}
	commitFP := func() {
		if registerClass(destType) == RegisterFP && destLoc.Spill >= 0 {
			fmt.Fprintf(b, "    movsd %s, %s\n", x64FPSpillOperand(f, plan, destLoc.Spill), dstFP)
		}
	}
	if destType == F64 {
		return fmt.Errorf("x64 fp: strict f64 is not supported by direct backend yet; use ieee64 or Core AOT")
	}
	switch ins.Op {
	case "const":
		if ins.Constant == nil || ins.Constant.Type != IEEE64 {
			return fmt.Errorf("x64 fp: only ieee64 constants are supported")
		}
		v, err := ParseValue(IEEE64, ins.Constant.Value)
		if err != nil {
			return err
		}
		fmt.Fprintf(b, "    mov r11, 0x%016x\n", valueToRaw(v))
		fmt.Fprintf(b, "    movq %s, r11\n", dstFP)
		commitFP()
		return nil
	case "move":
		a, at, err := source(0, "xmm5")
		if err != nil {
			return err
		}
		if at != IEEE64 || destType != IEEE64 {
			return fmt.Errorf("x64 fp: move requires ieee64")
		}
		if dstFP != a {
			fmt.Fprintf(b, "    movsd %s, %s\n", dstFP, a)
		}
		commitFP()
		return nil
	case "neg":
		a, at, err := source(0, "xmm5")
		if err != nil {
			return err
		}
		if at != IEEE64 || destType != IEEE64 {
			return fmt.Errorf("x64 fp: neg requires ieee64")
		}
		fmt.Fprintf(b, "    movq r10, %s\n", a)
		b.WriteString("    mov r11, 0x8000000000000000\n")
		b.WriteString("    xor r10, r11\n")
		fmt.Fprintf(b, "    movq %s, r10\n", dstFP)
		commitFP()
		return nil
	case "add", "sub", "mul", "div":
		a, at, err := source(0, "xmm4")
		if err != nil {
			return err
		}
		c, bt, err := source(1, "xmm5")
		if err != nil {
			return err
		}
		if at != IEEE64 || bt != IEEE64 || destType != IEEE64 {
			return fmt.Errorf("x64 fp: %s requires ieee64", ins.Op)
		}
		op := map[string]string{"add": "addsd", "sub": "subsd", "mul": "mulsd", "div": "divsd"}[ins.Op]
		target := dstFP
		switch {
		case dstFP == a:
		case dstFP == c:
			// The destination aliases the right operand; copying a first would
			// clobber it, so compute in the xmm4 source scratch instead.
			target = "xmm4"
			if a != target {
				fmt.Fprintf(b, "    movsd %s, %s\n", target, a)
			}
		default:
			fmt.Fprintf(b, "    movsd %s, %s\n", dstFP, a)
		}
		fmt.Fprintf(b, "    %s %s, %s\n", op, target, c)
		if target != dstFP {
			fmt.Fprintf(b, "    movsd %s, %s\n", dstFP, target)
		}
		commitFP()
		return nil
	case "eq", "ne", "lt", "le", "gt", "ge":
		a, at, err := source(0, "xmm4")
		if err != nil {
			return err
		}
		c, bt, err := source(1, "xmm5")
		if err != nil {
			return err
		}
		if at != IEEE64 || bt != IEEE64 || destType != Bool {
			return fmt.Errorf("x64 fp: comparison requires ieee64 operands and bool result")
		}
		dst := "r10"
		dst8 := "r10b"
		if destLoc.Register >= 0 {
			dst = x64Reg(plan, ins.Dest)
			dst8 = x64Reg8(plan, ins.Dest)
		}
		fmt.Fprintf(b, "    ucomisd %s, %s\n", a, c)
		fmt.Fprintf(b, "    mov %s, 0\n", dst)
		switch ins.Op {
		case "eq":
			fmt.Fprintf(b, "    sete %s\n", dst8)
			b.WriteString("    setnp r11b\n")
			fmt.Fprintf(b, "    and %s, r11b\n", dst8)
		case "ne":
			fmt.Fprintf(b, "    setne %s\n", dst8)
			b.WriteString("    setp r11b\n")
			fmt.Fprintf(b, "    or %s, r11b\n", dst8)
		case "lt":
			fmt.Fprintf(b, "    setb %s\n", dst8)
			b.WriteString("    setnp r11b\n")
			fmt.Fprintf(b, "    and %s, r11b\n", dst8)
		case "le":
			fmt.Fprintf(b, "    setbe %s\n", dst8)
			b.WriteString("    setnp r11b\n")
			fmt.Fprintf(b, "    and %s, r11b\n", dst8)
		case "gt":
			fmt.Fprintf(b, "    seta %s\n", dst8)
		case "ge":
			fmt.Fprintf(b, "    setae %s\n", dst8)
		}
		if destLoc.Spill >= 0 {
			fmt.Fprintf(b, "    mov %s, %s\n", x64SpillOperand(destLoc.Spill), dst)
		}
		return nil
	default:
		return fmt.Errorf("x64 fp: unsupported ieee64 operation %q", ins.Op)
	}
}

func x64Condition(op string, t Type) (string, error) {
	switch op {
	case "eq":
		return "e", nil
	case "ne":
		return "ne", nil
	}
	if t == I64 {
		return map[string]string{"lt": "l", "le": "le", "gt": "g", "ge": "ge"}[op], nil
	}
	if t == U64 || t == Bool {
		return map[string]string{"lt": "b", "le": "be", "gt": "a", "ge": "ae"}[op], nil
	}
	return "", fmt.Errorf("x64: unsupported comparison type %s", t)
}

func x64Reg(plan SSARegisterPlan, value SSAValue) string {
	return x64LeafRegisters[plan.Locations[value].Register].qword
}

func x64Reg8(plan SSARegisterPlan, value SSAValue) string {
	return x64LeafRegisters[plan.Locations[value].Register].byte
}

func x64FPReg(plan SSARegisterPlan, value SSAValue) string {
	return x64FPRegisters[plan.Locations[value].Register]
}

func sanitizeX64Symbol(name string) string {
	var b strings.Builder
	for i, r := range name {
		if r == '_' || unicode.IsLetter(r) || (i > 0 && unicode.IsDigit(r)) {
			b.WriteRune(r)
		} else {
			b.WriteString("_")
			b.WriteString(strconv.FormatInt(int64(r), 16))
		}
	}
	if b.Len() == 0 {
		return "entry"
	}
	return b.String()
}
