package coreir

import (
	"bytes"
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// ARM64LeafABI is the first direct ARM64 backend ABI. It follows AAPCS64:
// scalar arguments in x0..x7 and scalar result in x0. Swyp reserves the first
// argument register after program parameters for a uint64_t* status pointer.
//
// Leaf-v1 remains intentionally strict. The CFG emitter additionally supports
// branches, phi nodes and GPR stack spills.
const ARM64LeafABI = "swyp-arm64-leaf-aapcs64-v1"

var arm64LeafRegisters = []string{
	"x19", "x20", "x21", "x22", "x23",
	"x24", "x25", "x26", "x27", "x28",
}

var arm64ArgRegisters = []string{"x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"}
var arm64FPRegisters = []string{"d8", "d9", "d10", "d11", "d12", "d13", "d14", "d15"}
var arm64FPArgRegisters = []string{"d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"}

func ARM64LeafRegisterCount() int { return len(arm64LeafRegisters) }
func ARM64FPRegisterCount() int   { return len(arm64FPRegisters) }

func ARM64LeafSymbol(name string) string {
	return "swyp_core_" + sanitizeARM64Symbol(name)
}

func EmitARM64LeafSSA(f SSAFunction, plan SSARegisterPlan) ([]byte, error) {
	if len(plan.Locations) != len(f.ValueTypes) {
		return nil, fmt.Errorf("arm64: register plan/value count mismatch")
	}
	gprParams, fpParams := arm64ParamCounts(f)
	// One integer argument register is reserved for the status pointer.
	if gprParams >= len(arm64ArgRegisters) || fpParams > len(arm64FPArgRegisters) {
		return nil, fmt.Errorf("arm64: leaf v1 parameter registers exceeded")
	}
	reachable := -1
	for bi, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		if reachable >= 0 {
			return nil, fmt.Errorf("arm64: leaf v1 supports one reachable block")
		}
		reachable = bi
		if len(block.Phis) != 0 {
			return nil, fmt.Errorf("arm64: leaf v1 does not support phi nodes")
		}
	}
	if reachable < 0 {
		return nil, fmt.Errorf("arm64: no reachable block")
	}
	block := f.Blocks[reachable]
	if block.Terminator.Op != "return" {
		return nil, fmt.Errorf("arm64: leaf v1 requires return terminator")
	}
	for value, t := range f.ValueTypes {
		if t == F64 {
			return nil, fmt.Errorf("arm64: strict f64 is not supported by direct backend yet; use ieee64 or Core AOT")
		}
		loc := plan.Locations[value]
		limit := len(arm64LeafRegisters)
		if registerClass(t) == RegisterFP {
			limit = len(arm64FPRegisters)
		}
		if loc.Spill >= 0 || loc.Register < 0 || loc.Register >= limit {
			return nil, fmt.Errorf("arm64: spill-free allocation required, value %d location=%+v", value, loc)
		}
	}
	for _, ins := range block.Instructions {
		if ins.Op == "call" {
			return nil, fmt.Errorf("arm64: calls not supported in leaf v1")
		}
	}

	used := make([]bool, len(arm64LeafRegisters))
	usedFP := make([]bool, len(arm64FPRegisters))
	for value, loc := range plan.Locations {
		if loc.Register >= 0 {
			if registerClass(f.ValueTypes[value]) == RegisterFP {
				usedFP[loc.Register] = true
			} else {
				used[loc.Register] = true
			}
		}
	}

	var b bytes.Buffer
	b.WriteString(".text\n")
	fmt.Fprintf(&b, ".global %s\n%s:\n", ARM64LeafSymbol(f.Name), ARM64LeafSymbol(f.Name))
	// x16/x17 are intra-procedure-call scratch registers and are not allocated
	// to SSA values. x16 keeps the status pointer alive through the leaf body.
	fmt.Fprintf(&b, "    mov x16, %s\n", arm64ArgRegisters[gprParams])
	for reg, active := range used {
		if active {
			fmt.Fprintf(&b, "    str %s, [sp, #-16]!\n", arm64LeafRegisters[reg])
		}
	}
	for reg, active := range usedFP {
		if active {
			fmt.Fprintf(&b, "    str %s, [sp, #-16]!\n", arm64FPRegisters[reg])
		}
	}
	gprIndex, fpIndex := 0, 0
	for _, value := range f.Params {
		if registerClass(f.ValueTypes[value]) == RegisterFP {
			dst := arm64FPReg(plan, value)
			src := arm64FPArgRegisters[fpIndex]
			fpIndex++
			if dst != src {
				fmt.Fprintf(&b, "    fmov %s, %s\n", dst, src)
			}
		} else {
			dst := arm64Reg(plan, value)
			src := arm64ArgRegisters[gprIndex]
			gprIndex++
			if dst != src {
				fmt.Fprintf(&b, "    mov %s, %s\n", dst, src)
			}
		}
	}
	for _, ins := range block.Instructions {
		if err := emitARM64LeafInstruction(&b, f, plan, ins); err != nil {
			return nil, err
		}
	}
	if block.Terminator.Value >= 0 {
		if registerClass(f.ValueTypes[block.Terminator.Value]) == RegisterFP {
			result := arm64FPReg(plan, block.Terminator.Value)
			if result != "d0" {
				fmt.Fprintf(&b, "    fmov d0, %s\n", result)
			}
		} else {
			result := arm64Reg(plan, block.Terminator.Value)
			if result != "x0" {
				fmt.Fprintf(&b, "    mov x0, %s\n", result)
			}
		}
	} else {
		b.WriteString("    mov x0, #0\n")
	}
	b.WriteString("    mov x17, #0\n")
	b.WriteString("    str x17, [x16]\n")
	b.WriteString("    b .Lswyp_arm64_epilogue\n")
	b.WriteString(".Lswyp_arm64_overflow:\n")
	b.WriteString("    mov x0, #0\n")
	b.WriteString("    mov x17, #1\n")
	b.WriteString("    str x17, [x16]\n")
	b.WriteString(".Lswyp_arm64_epilogue:\n")
	for reg := len(usedFP) - 1; reg >= 0; reg-- {
		if usedFP[reg] {
			fmt.Fprintf(&b, "    ldr %s, [sp], #16\n", arm64FPRegisters[reg])
		}
	}
	for reg := len(used) - 1; reg >= 0; reg-- {
		if used[reg] {
			fmt.Fprintf(&b, "    ldr %s, [sp], #16\n", arm64LeafRegisters[reg])
		}
	}
	b.WriteString("    ret\n")
	return b.Bytes(), nil
}

func emitARM64LeafInstruction(b *bytes.Buffer, f SSAFunction, plan SSARegisterPlan, ins SSAInstruction) error {
	if ins.Dest < 0 {
		return fmt.Errorf("arm64: instruction %s has no destination", ins.Op)
	}
	t := f.ValueTypes[ins.Dest]
	if registerClass(t) == RegisterFP || (len(ins.Args) > 0 && registerClass(f.ValueTypes[ins.Args[0]]) == RegisterFP) {
		return emitARM64FPInstruction(b, f, plan, ins)
	}
	destLoc := plan.Locations[ins.Dest]
	dst := "x11"
	if destLoc.Spill < 0 {
		dst = arm64Reg(plan, ins.Dest)
	}
	commit := func() {
		if destLoc.Spill >= 0 {
			fmt.Fprintf(b, "    str %s, %s\n", dst, arm64SpillOperand(destLoc.Spill))
		}
	}
	arg := func(index int, scratch string) (string, Type, error) {
		if index >= len(ins.Args) {
			return "", "", fmt.Errorf("arm64: %s missing operand %d", ins.Op, index)
		}
		value := ins.Args[index]
		loc := plan.Locations[value]
		if loc.Spill >= 0 {
			fmt.Fprintf(b, "    ldr %s, %s\n", scratch, arm64SpillOperand(loc.Spill))
			return scratch, f.ValueTypes[value], nil
		}
		return arm64Reg(plan, value), f.ValueTypes[value], nil
	}
	switch ins.Op {
	case "call":
		if ins.Callee == "" {
			return fmt.Errorf("arm64: call missing callee")
		}
		if len(ins.Args) > 7 {
			return fmt.Errorf("arm64: native call supports at most 7 GPR arguments")
		}
		if registerClass(t) != RegisterGPR {
			return fmt.Errorf("arm64: native call result type %s is not GPR scalar", t)
		}
		b.WriteString("    sub sp, sp, #16\n")
		for i, value := range ins.Args {
			if registerClass(f.ValueTypes[value]) != RegisterGPR {
				return fmt.Errorf("arm64: native call argument %d type %s is not GPR scalar", i, f.ValueTypes[value])
			}
			dstArg := arm64ArgRegisters[i]
			loc := plan.Locations[value]
			if loc.Spill >= 0 {
				fmt.Fprintf(b, "    ldr %s, %s\n", dstArg, arm64SpillOperand(loc.Spill))
			} else {
				src := arm64Reg(plan, value)
				if src != dstArg {
					fmt.Fprintf(b, "    mov %s, %s\n", dstArg, src)
				}
			}
		}
		statusArg := arm64ArgRegisters[len(ins.Args)]
		fmt.Fprintf(b, "    mov %s, sp\n", statusArg)
		fmt.Fprintf(b, "    bl %s\n", ARM64LeafSymbol(ins.Callee))
		b.WriteString("    ldr x17, [sp]\n")
		b.WriteString("    add sp, sp, #16\n")
		b.WriteString("    cbnz x17, .Lswyp_arm64_overflow\n")
		if destLoc.Spill >= 0 {
			fmt.Fprintf(b, "    str x0, %s\n", arm64SpillOperand(destLoc.Spill))
		} else if dst != "x0" {
			fmt.Fprintf(b, "    mov %s, x0\n", dst)
		}
		return nil
	case "const":
		if ins.Constant == nil {
			return fmt.Errorf("arm64: const missing literal")
		}
		v, err := ParseValue(ins.Constant.Type, ins.Constant.Value)
		if err != nil {
			return err
		}
		emitARM64LoadImmediate(b, dst, valueToRaw(v))
		commit()
		return nil
	case "move":
		a, _, err := arg(0, "x9")
		if err != nil {
			return err
		}
		if dst != a {
			fmt.Fprintf(b, "    mov %s, %s\n", dst, a)
		}
		commit()
		return nil
	case "neg":
		a, at, err := arg(0, "x9")
		if err != nil {
			return err
		}
		if at != I64 && at != U64 {
			return fmt.Errorf("arm64: neg unsupported type %s", at)
		}
		if at == I64 {
			fmt.Fprintf(b, "    negs %s, %s\n", dst, a)
			b.WriteString("    b.vs .Lswyp_arm64_overflow\n")
		} else {
			fmt.Fprintf(b, "    neg %s, %s\n", dst, a)
		}
		commit()
		return nil
	case "not":
		a, at, err := arg(0, "x9")
		if err != nil {
			return err
		}
		if at != Bool {
			return fmt.Errorf("arm64: not requires bool")
		}
		fmt.Fprintf(b, "    eor %s, %s, #1\n", dst, a)
		commit()
		return nil
	case "eq", "ne", "lt", "le", "gt", "ge":
		a, at, err := arg(0, "x9")
		if err != nil {
			return err
		}
		c, bt, err := arg(1, "x10")
		if err != nil {
			return err
		}
		if at != bt || (at != I64 && at != U64 && at != Bool) {
			return fmt.Errorf("arm64: comparison unsupported operands %s/%s", at, bt)
		}
		fmt.Fprintf(b, "    cmp %s, %s\n", a, c)
		cc, err := arm64Condition(ins.Op, at)
		if err != nil {
			return err
		}
		fmt.Fprintf(b, "    cset %s, %s\n", dst, cc)
		commit()
		return nil
	case "add", "sub", "mul", "band", "bor", "bxor":
		a, at, err := arg(0, "x9")
		if err != nil {
			return err
		}
		c, bt, err := arg(1, "x10")
		if err != nil {
			return err
		}
		if at != bt || (at != I64 && at != U64) {
			return fmt.Errorf("arm64: %s unsupported operands %s/%s", ins.Op, at, bt)
		}
		switch ins.Op {
		case "add":
			if at == I64 {
				fmt.Fprintf(b, "    adds %s, %s, %s\n", dst, a, c)
				b.WriteString("    b.vs .Lswyp_arm64_overflow\n")
			} else {
				fmt.Fprintf(b, "    add %s, %s, %s\n", dst, a, c)
			}
		case "sub":
			if at == I64 {
				fmt.Fprintf(b, "    subs %s, %s, %s\n", dst, a, c)
				b.WriteString("    b.vs .Lswyp_arm64_overflow\n")
			} else {
				fmt.Fprintf(b, "    sub %s, %s, %s\n", dst, a, c)
			}
		case "mul":
			fmt.Fprintf(b, "    mul %s, %s, %s\n", dst, a, c)
			if at == I64 {
				// Signed overflow iff high 64 bits are not sign-extension of low.
				fmt.Fprintf(b, "    smulh x9, %s, %s\n", a, c)
				fmt.Fprintf(b, "    asr x10, %s, #63\n", dst)
				b.WriteString("    cmp x9, x10\n")
				b.WriteString("    b.ne .Lswyp_arm64_overflow\n")
			}
		case "band":
			fmt.Fprintf(b, "    and %s, %s, %s\n", dst, a, c)
		case "bor":
			fmt.Fprintf(b, "    orr %s, %s, %s\n", dst, a, c)
		case "bxor":
			fmt.Fprintf(b, "    eor %s, %s, %s\n", dst, a, c)
		}
		commit()
		return nil
	default:
		return fmt.Errorf("arm64: leaf v1 unsupported operation %q result=%s", ins.Op, t)
	}
}

func emitARM64FPInstruction(b *bytes.Buffer, f SSAFunction, plan SSARegisterPlan, ins SSAInstruction) error {
	if ins.Dest < 0 {
		return fmt.Errorf("arm64 fp: instruction %s has no destination", ins.Op)
	}
	destType := f.ValueTypes[ins.Dest]
	if destType == F64 {
		return fmt.Errorf("arm64 fp: strict f64 is not supported by direct backend yet; use ieee64 or Core AOT")
	}
	destLoc := plan.Locations[ins.Dest]
	dstFP := "d6"
	if registerClass(destType) == RegisterFP && destLoc.Spill < 0 {
		dstFP = arm64FPReg(plan, ins.Dest)
	}
	arg := func(index int, scratch string) (string, Type, error) {
		if index >= len(ins.Args) {
			return "", "", fmt.Errorf("arm64 fp: %s missing operand %d", ins.Op, index)
		}
		value := ins.Args[index]
		t := f.ValueTypes[value]
		if registerClass(t) != RegisterFP {
			return "", t, fmt.Errorf("arm64 fp: operand %d is not floating-point", index)
		}
		loc := plan.Locations[value]
		if loc.Spill >= 0 {
			fmt.Fprintf(b, "    ldr %s, %s\n", scratch, arm64FPSpillOperand(f, plan, loc.Spill))
			return scratch, t, nil
		}
		return arm64FPReg(plan, value), t, nil
	}
	commitFP := func() {
		if registerClass(destType) == RegisterFP && destLoc.Spill >= 0 {
			fmt.Fprintf(b, "    str %s, %s\n", dstFP, arm64FPSpillOperand(f, plan, destLoc.Spill))
		}
	}
	switch ins.Op {
	case "call":
		return fmt.Errorf("arm64 fp: FP native calls are not supported yet")
	case "const":
		if ins.Constant == nil || ins.Constant.Type != IEEE64 {
			return fmt.Errorf("arm64 fp: only ieee64 constants are supported")
		}
		v, err := ParseValue(IEEE64, ins.Constant.Value)
		if err != nil {
			return err
		}
		emitARM64LoadImmediate(b, "x9", valueToRaw(v))
		fmt.Fprintf(b, "    fmov %s, x9\n", dstFP)
		commitFP()
		return nil
	case "move":
		a, at, err := arg(0, "d4")
		if err != nil {
			return err
		}
		if at != IEEE64 || destType != IEEE64 {
			return fmt.Errorf("arm64 fp: move requires ieee64")
		}
		if dstFP != a {
			fmt.Fprintf(b, "    fmov %s, %s\n", dstFP, a)
		}
		commitFP()
		return nil
	case "neg":
		a, at, err := arg(0, "d4")
		if err != nil {
			return err
		}
		if at != IEEE64 || destType != IEEE64 {
			return fmt.Errorf("arm64 fp: neg requires ieee64")
		}
		fmt.Fprintf(b, "    fneg %s, %s\n", dstFP, a)
		commitFP()
		return nil
	case "add", "sub", "mul", "div":
		a, at, err := arg(0, "d4")
		if err != nil {
			return err
		}
		c, bt, err := arg(1, "d5")
		if err != nil {
			return err
		}
		if at != IEEE64 || bt != IEEE64 || destType != IEEE64 {
			return fmt.Errorf("arm64 fp: %s requires ieee64", ins.Op)
		}
		op := map[string]string{"add": "fadd", "sub": "fsub", "mul": "fmul", "div": "fdiv"}[ins.Op]
		fmt.Fprintf(b, "    %s %s, %s, %s\n", op, dstFP, a, c)
		commitFP()
		return nil
	case "eq", "ne", "lt", "le", "gt", "ge":
		a, at, err := arg(0, "d4")
		if err != nil {
			return err
		}
		c, bt, err := arg(1, "d5")
		if err != nil {
			return err
		}
		if at != IEEE64 || bt != IEEE64 || destType != Bool {
			return fmt.Errorf("arm64 fp: comparison requires ieee64 operands and bool result")
		}
		fmt.Fprintf(b, "    fcmp %s, %s\n", a, c)
		cc := map[string]string{
			"eq": "eq",
			"ne": "ne",
			"lt": "mi",
			"le": "ls",
			"gt": "gt",
			"ge": "ge",
		}[ins.Op]
		dst := "x11"
		if destLoc.Spill < 0 {
			dst = arm64Reg(plan, ins.Dest)
		}
		fmt.Fprintf(b, "    cset %s, %s\n", dst, cc)
		if destLoc.Spill >= 0 {
			fmt.Fprintf(b, "    str %s, %s\n", dst, arm64SpillOperand(destLoc.Spill))
		}
		return nil
	default:
		return fmt.Errorf("arm64 fp: unsupported ieee64 operation %q", ins.Op)
	}
}

func emitARM64LoadImmediate(b *bytes.Buffer, dst string, value uint64) {
	first := true
	for shift := 0; shift < 64; shift += 16 {
		part := uint16(value >> shift)
		if part == 0 && !first {
			continue
		}
		if first {
			fmt.Fprintf(b, "    movz %s, #0x%x, lsl #%d\n", dst, part, shift)
			first = false
		} else {
			fmt.Fprintf(b, "    movk %s, #0x%x, lsl #%d\n", dst, part, shift)
		}
	}
	if first {
		fmt.Fprintf(b, "    movz %s, #0\n", dst)
	}
}

func arm64Condition(op string, t Type) (string, error) {
	switch op {
	case "eq":
		return "eq", nil
	case "ne":
		return "ne", nil
	}
	if t == I64 {
		return map[string]string{"lt": "lt", "le": "le", "gt": "gt", "ge": "ge"}[op], nil
	}
	if t == U64 || t == Bool {
		return map[string]string{"lt": "lo", "le": "ls", "gt": "hi", "ge": "hs"}[op], nil
	}
	return "", fmt.Errorf("arm64: unsupported comparison type %s", t)
}

func arm64Reg(plan SSARegisterPlan, value SSAValue) string {
	return arm64LeafRegisters[plan.Locations[value].Register]
}

func arm64FPReg(plan SSARegisterPlan, value SSAValue) string {
	return arm64FPRegisters[plan.Locations[value].Register]
}

func arm64ParamCounts(f SSAFunction) (gpr, fp int) {
	for _, value := range f.Params {
		if registerClass(f.ValueTypes[value]) == RegisterFP {
			fp++
		} else {
			gpr++
		}
	}
	return gpr, fp
}

func sanitizeARM64Symbol(name string) string {
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
