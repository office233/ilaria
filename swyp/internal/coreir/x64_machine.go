package coreir

import (
	"encoding/binary"
	"fmt"
)

const MaxX64LeafCodeBytes = 1 << 20

type x64MachineBuilder struct {
	code                []byte
	overflowFixups      []int
	ioFailureFixups     []int
	boundsFailureFixups []int
	callFixups          []x64CallFixup
}

func EmitX64LeafMachineCode(f SSAFunction, plan SSARegisterPlan) ([]byte, error) {
	if len(plan.Locations) != len(f.ValueTypes) {
		return nil, fmt.Errorf("x64 machine: register plan/value count mismatch")
	}
	if len(f.Params) > 4 {
		return nil, fmt.Errorf("x64 machine: supports at most four parameters")
	}
	reachable := -1
	for bi, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		if reachable >= 0 {
			return nil, fmt.Errorf("x64 machine: leaf v1 supports one reachable block")
		}
		reachable = bi
		if len(block.Phis) != 0 {
			return nil, fmt.Errorf("x64 machine: phi nodes not supported in leaf v1")
		}
	}
	if reachable < 0 {
		return nil, fmt.Errorf("x64 machine: no reachable block")
	}
	block := f.Blocks[reachable]
	if block.Terminator.Op != "return" {
		return nil, fmt.Errorf("x64 machine: leaf v1 requires return terminator")
	}
	for value, t := range f.ValueTypes {
		if registerClass(t) != RegisterGPR {
			return nil, fmt.Errorf("x64 machine: value %d uses unsupported type %s", value, t)
		}
		loc := plan.Locations[value]
		if loc.Spill >= 0 || loc.Register < 0 || loc.Register >= len(x64MachineRegisters) {
			return nil, fmt.Errorf("x64 machine: spill-free allocation required for value %d", value)
		}
	}
	for _, ins := range block.Instructions {
		if ins.Op == "call" {
			return nil, fmt.Errorf("x64 machine: calls not supported in leaf v1")
		}
	}

	b := &x64MachineBuilder{}
	used := make([]bool, len(x64MachineRegisters))
	for _, loc := range plan.Locations {
		if loc.Register >= 0 {
			used[loc.Register] = true
		}
	}

	// Save status pointer in volatile R11 before touching program arguments.
	statusArgIndex := len(f.Params)
	if statusArgIndex < 4 {
		b.movRegReg(x64R11, x64WinArgRegs[statusArgIndex])
	} else {
		b.movRegStackDisp8(x64R11, x64RSP, 40)
	}
	for reg, active := range used {
		if active {
			b.push(x64MachineRegisters[reg])
		}
	}
	for i, value := range f.Params {
		dst := x64PhysicalReg(plan, value)
		src := x64WinArgRegs[i]
		if dst != src {
			b.movRegReg(dst, src)
		}
	}
	for _, ins := range block.Instructions {
		if err := b.emitInstruction(f, plan, ins); err != nil {
			return nil, err
		}
	}
	if block.Terminator.Value >= 0 {
		result := x64PhysicalReg(plan, block.Terminator.Value)
		if result != x64RAX {
			b.movRegReg(x64RAX, result)
		}
	} else {
		b.xorRegReg(x64RAX, x64RAX)
	}
	b.xorRegReg(x64RDX, x64RDX)
	b.movMemReg(x64R11, x64RDX)
	for reg := len(used) - 1; reg >= 0; reg-- {
		if used[reg] {
			b.pop(x64MachineRegisters[reg])
		}
	}
	b.ret()

	overflowOffset := len(b.code)
	b.xorRegReg(x64RAX, x64RAX)
	b.movRegImm64(x64RDX, 1)
	b.movMemReg(x64R11, x64RDX)
	for reg := len(used) - 1; reg >= 0; reg-- {
		if used[reg] {
			b.pop(x64MachineRegisters[reg])
		}
	}
	b.ret()
	for _, fixup := range b.overflowFixups {
		rel := int32(overflowOffset - (fixup + 4))
		binary.LittleEndian.PutUint32(b.code[fixup:fixup+4], uint32(rel))
	}
	if len(b.code) == 0 || len(b.code) > MaxX64LeafCodeBytes {
		return nil, fmt.Errorf("x64 machine: invalid code size %d", len(b.code))
	}
	return b.code, nil
}

const (
	x64RAX = 0
	x64RCX = 1
	x64RDX = 2
	x64RBX = 3
	x64RSP = 4
	x64RBP = 5
	x64RSI = 6
	x64RDI = 7
	x64R8  = 8
	x64R9  = 9
	x64R10 = 10
	x64R11 = 11
	x64R12 = 12
	x64R13 = 13
	x64R14 = 14
	x64R15 = 15
)

var x64MachineRegisters = []int{x64RBX, x64RSI, x64RDI, x64R12, x64R13, x64R14, x64R15}
var x64WinArgRegs = []int{x64RCX, x64RDX, x64R8, x64R9}
var x64MachineFPRegisters = []int{6, 7, 8, 9, 10, 11, 12, 13, 14, 15}

func x64PhysicalReg(plan SSARegisterPlan, value SSAValue) int {
	return x64MachineRegisters[plan.Locations[value].Register]
}

func x64PhysicalFPReg(plan SSARegisterPlan, value SSAValue) int {
	return x64MachineFPRegisters[plan.Locations[value].Register]
}

func (b *x64MachineBuilder) emitInstruction(f SSAFunction, plan SSARegisterPlan, ins SSAInstruction) error {
	if ins.Dest < 0 {
		return fmt.Errorf("x64 machine: instruction %s has no destination", ins.Op)
	}
	dst := x64PhysicalReg(plan, ins.Dest)
	arg := func(index int) (int, Type, error) {
		if index >= len(ins.Args) {
			return 0, "", fmt.Errorf("x64 machine: %s missing operand %d", ins.Op, index)
		}
		value := ins.Args[index]
		return x64PhysicalReg(plan, value), f.ValueTypes[value], nil
	}
	switch ins.Op {
	case "const":
		if ins.Constant == nil {
			return fmt.Errorf("x64 machine: const missing literal")
		}
		v, err := ParseValue(ins.Constant.Type, ins.Constant.Value)
		if err != nil {
			return err
		}
		b.movRegImm64(dst, valueToRaw(v))
		return nil
	case "move":
		a, _, err := arg(0)
		if err != nil {
			return err
		}
		if dst != a {
			b.movRegReg(dst, a)
		}
		return nil
	case "bitcast_i64_u64", "bitcast_u64_i64":
		a, srcType, err := arg(0)
		if err != nil {
			return err
		}
		wantSrc, wantDst := I64, U64
		if ins.Op == "bitcast_u64_i64" {
			wantSrc, wantDst = U64, I64
		}
		if srcType != wantSrc || f.ValueTypes[ins.Dest] != wantDst {
			return fmt.Errorf("x64 machine: invalid %s types %s -> %s", ins.Op, srcType, f.ValueTypes[ins.Dest])
		}
		if dst != a {
			b.movRegReg(dst, a)
		}
		return nil
	case "neg":
		a, t, err := arg(0)
		if err != nil {
			return err
		}
		if t != I64 && t != U64 {
			return fmt.Errorf("x64 machine: neg unsupported type %s", t)
		}
		if dst != a {
			b.movRegReg(dst, a)
		}
		b.neg(dst)
		if t == I64 {
			b.joOverflow()
		}
		return nil
	case "not":
		a, t, err := arg(0)
		if err != nil {
			return err
		}
		if t != Bool {
			return fmt.Errorf("x64 machine: not requires bool")
		}
		if dst != a {
			b.movRegReg(dst, a)
		}
		b.xorImm8(dst, 1)
		return nil
	case "eq", "ne", "lt", "le", "gt", "ge":
		a, at, err := arg(0)
		if err != nil {
			return err
		}
		c, bt, err := arg(1)
		if err != nil {
			return err
		}
		if at != bt || (at != I64 && at != U64 && at != Bool) {
			return fmt.Errorf("x64 machine: unsupported comparison %s/%s", at, bt)
		}
		b.cmpRegReg(a, c)
		// MOV preserves comparison flags. XOR would clobber them before SETcc.
		b.movRegImm64(dst, 0)
		cc, err := x64ConditionCode(ins.Op, at)
		if err != nil {
			return err
		}
		b.setcc(dst, cc)
		return nil
	case "add", "sub", "mul", "band", "bor", "bxor":
		a, at, err := arg(0)
		if err != nil {
			return err
		}
		c, bt, err := arg(1)
		if err != nil {
			return err
		}
		if at != bt || (at != I64 && at != U64) {
			return fmt.Errorf("x64 machine: %s unsupported operands %s/%s", ins.Op, at, bt)
		}
		commutative := ins.Op == "add" || ins.Op == "mul" || ins.Op == "band" || ins.Op == "bor" || ins.Op == "bxor"
		target := dst
		other := c
		if dst == a {
			// already ideal
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
		return nil
	default:
		return fmt.Errorf("x64 machine: unsupported operation %q", ins.Op)
	}
}

func x64ConditionCode(op string, t Type) (byte, error) {
	switch op {
	case "eq":
		return 0x4, nil
	case "ne":
		return 0x5, nil
	}
	if t == I64 {
		codes := map[string]byte{"lt": 0xc, "le": 0xe, "gt": 0xf, "ge": 0xd}
		return codes[op], nil
	}
	if t == U64 || t == Bool {
		codes := map[string]byte{"lt": 0x2, "le": 0x6, "gt": 0x7, "ge": 0x3}
		return codes[op], nil
	}
	return 0, fmt.Errorf("x64 machine: unsupported comparison type %s", t)
}

func (b *x64MachineBuilder) rex(w bool, reg, base int) {
	prefix := byte(0x40)
	if w {
		prefix |= 0x08
	}
	if reg >= 8 {
		prefix |= 0x04
	}
	if base >= 8 {
		prefix |= 0x01
	}
	if prefix != 0x40 || w {
		b.code = append(b.code, prefix)
	}
}

func modRM(mod, reg, rm int) byte { return byte((mod << 6) | ((reg & 7) << 3) | (rm & 7)) }

func (b *x64MachineBuilder) movRegReg(dst, src int) {
	b.rex(true, src, dst)
	b.code = append(b.code, 0x89, modRM(3, src, dst))
}

func (b *x64MachineBuilder) movRegImm64(dst int, value uint64) {
	prefix := byte(0x48)
	if dst >= 8 {
		prefix |= 0x01
	}
	b.code = append(b.code, prefix, byte(0xb8+(dst&7)))
	var raw [8]byte
	binary.LittleEndian.PutUint64(raw[:], value)
	b.code = append(b.code, raw[:]...)
}

func (b *x64MachineBuilder) leaRegMemDisp32(dst, base int, disp int32) {
	b.rex(true, dst, base)
	b.code = append(b.code, 0x8d)
	if base&7 == x64RSP {
		b.code = append(b.code, modRM(2, dst, 4), modRM(0, 4, base))
	} else {
		b.code = append(b.code, modRM(2, dst, base))
	}
	var raw [4]byte
	binary.LittleEndian.PutUint32(raw[:], uint32(disp))
	b.code = append(b.code, raw[:]...)
}

func (b *x64MachineBuilder) leaRegRIPRel32(dst int) int {
	b.rex(true, dst, 5)
	b.code = append(b.code, 0x8d, modRM(0, dst, 5))
	pos := len(b.code)
	b.code = append(b.code, 0, 0, 0, 0)
	return pos
}

func (b *x64MachineBuilder) movMemByteReg(base, src int) {
	prefix := byte(0x40)
	if src >= 8 {
		prefix |= 0x04
	}
	if base >= 8 {
		prefix |= 0x01
	}
	b.code = append(b.code, prefix, 0x88)
	if base&7 == x64RSP {
		b.code = append(b.code, modRM(0, src, 4), modRM(0, 4, base))
	} else {
		b.code = append(b.code, modRM(0, src, base))
	}
}

func (b *x64MachineBuilder) divReg(reg int) {
	b.rex(true, 0, reg)
	b.code = append(b.code, 0xf7, modRM(3, 6, reg))
}

// idivReg emits signed IDIV r/m64: RDX:RAX / reg -> RAX quotient, RDX remainder.
func (b *x64MachineBuilder) idivReg(reg int) {
	b.rex(true, 0, reg)
	b.code = append(b.code, 0xf7, modRM(3, 7, reg))
}

// cqo sign-extends RAX into RDX:RAX before a signed division.
func (b *x64MachineBuilder) cqo() {
	b.code = append(b.code, 0x48, 0x99)
}

func (b *x64MachineBuilder) shrRegImm8(reg int, shift byte) {
	b.rex(true, 0, reg)
	b.code = append(b.code, 0xc1, modRM(3, 5, reg), shift)
}

func (b *x64MachineBuilder) shlRegImm8(reg int, shift byte) {
	b.rex(true, 0, reg)
	b.code = append(b.code, 0xc1, modRM(3, 4, reg), shift)
}

func (b *x64MachineBuilder) push(reg int) {
	if reg >= 8 {
		b.code = append(b.code, 0x41)
	}
	b.code = append(b.code, byte(0x50+(reg&7)))
}

func (b *x64MachineBuilder) pop(reg int) {
	if reg >= 8 {
		b.code = append(b.code, 0x41)
	}
	b.code = append(b.code, byte(0x58+(reg&7)))
}

func (b *x64MachineBuilder) binaryRegReg(op byte, dst, src int) {
	b.rex(true, src, dst)
	b.code = append(b.code, op, modRM(3, src, dst))
}

func (b *x64MachineBuilder) imulRegReg(dst, src int) {
	b.rex(true, dst, src)
	b.code = append(b.code, 0x0f, 0xaf, modRM(3, dst, src))
}

func (b *x64MachineBuilder) neg(reg int) {
	b.rex(true, 0, reg)
	b.code = append(b.code, 0xf7, modRM(3, 3, reg))
}

func (b *x64MachineBuilder) xorRegReg(dst, src int) {
	b.binaryRegReg(0x31, dst, src)
}

func (b *x64MachineBuilder) xorImm8(dst int, value byte) {
	b.rex(true, 0, dst)
	b.code = append(b.code, 0x83, modRM(3, 6, dst), value)
}

func (b *x64MachineBuilder) cmpRegReg(a, c int) {
	b.rex(true, c, a)
	b.code = append(b.code, 0x39, modRM(3, c, a))
}

func (b *x64MachineBuilder) setcc(dst int, cc byte) {
	// A REX prefix is intentionally always present so SIL/DIL and R8B+ are
	// selected correctly; BL remains BL under REX.
	prefix := byte(0x40)
	if dst >= 8 {
		prefix |= 0x01
	}
	b.code = append(b.code, prefix, 0x0f, 0x90|cc, modRM(3, 0, dst))
}

func (b *x64MachineBuilder) byteBinaryRegReg(op byte, dst, src int) {
	prefix := byte(0x40)
	if src >= 8 {
		prefix |= 0x04
	}
	if dst >= 8 {
		prefix |= 0x01
	}
	b.code = append(b.code, prefix, op, modRM(3, src, dst))
}

func (b *x64MachineBuilder) movqXMMReg(dstXMM, srcReg int) {
	b.code = append(b.code, 0x66)
	b.rex(true, dstXMM, srcReg)
	b.code = append(b.code, 0x0f, 0x6e, modRM(3, dstXMM, srcReg))
}

func (b *x64MachineBuilder) movqRegXMM(dstReg, srcXMM int) {
	b.code = append(b.code, 0x66)
	b.rex(true, srcXMM, dstReg)
	b.code = append(b.code, 0x0f, 0x7e, modRM(3, srcXMM, dstReg))
}

func (b *x64MachineBuilder) cvtsi2sdXMMReg(dstXMM, srcReg int) {
	b.code = append(b.code, 0xf2)
	b.rex(true, dstXMM, srcReg)
	b.code = append(b.code, 0x0f, 0x2a, modRM(3, dstXMM, srcReg))
}

func (b *x64MachineBuilder) movsdXMMXMM(dst, src int) {
	b.code = append(b.code, 0xf2)
	b.rex(false, dst, src)
	b.code = append(b.code, 0x0f, 0x10, modRM(3, dst, src))
}

func (b *x64MachineBuilder) movsdXMMMemDisp32(dst, base int, disp int32) {
	b.code = append(b.code, 0xf2)
	b.rex(false, dst, base)
	b.code = append(b.code, 0x0f, 0x10)
	if base&7 == x64RSP {
		b.code = append(b.code, modRM(2, dst, 4), modRM(0, 4, base))
	} else {
		b.code = append(b.code, modRM(2, dst, base))
	}
	var raw [4]byte
	binary.LittleEndian.PutUint32(raw[:], uint32(disp))
	b.code = append(b.code, raw[:]...)
}

func (b *x64MachineBuilder) movsdMemDisp32XMM(base int, disp int32, src int) {
	b.code = append(b.code, 0xf2)
	b.rex(false, src, base)
	b.code = append(b.code, 0x0f, 0x11)
	if base&7 == x64RSP {
		b.code = append(b.code, modRM(2, src, 4), modRM(0, 4, base))
	} else {
		b.code = append(b.code, modRM(2, src, base))
	}
	var raw [4]byte
	binary.LittleEndian.PutUint32(raw[:], uint32(disp))
	b.code = append(b.code, raw[:]...)
}

func (b *x64MachineBuilder) scalarSDRegReg(op byte, dst, src int) {
	b.code = append(b.code, 0xf2)
	b.rex(false, dst, src)
	b.code = append(b.code, 0x0f, op, modRM(3, dst, src))
}

func (b *x64MachineBuilder) ucomisd(dst, src int) {
	b.code = append(b.code, 0x66)
	b.rex(false, dst, src)
	b.code = append(b.code, 0x0f, 0x2e, modRM(3, dst, src))
}

func (b *x64MachineBuilder) movdquMemDisp32XMM(base int, disp int32, src int) {
	b.code = append(b.code, 0xf3)
	b.rex(false, src, base)
	b.code = append(b.code, 0x0f, 0x7f)
	if base&7 == x64RSP {
		b.code = append(b.code, modRM(2, src, 4), modRM(0, 4, base))
	} else {
		b.code = append(b.code, modRM(2, src, base))
	}
	var raw [4]byte
	binary.LittleEndian.PutUint32(raw[:], uint32(disp))
	b.code = append(b.code, raw[:]...)
}

func (b *x64MachineBuilder) movdquXMMMemDisp32(dst, base int, disp int32) {
	b.code = append(b.code, 0xf3)
	b.rex(false, dst, base)
	b.code = append(b.code, 0x0f, 0x6f)
	if base&7 == x64RSP {
		b.code = append(b.code, modRM(2, dst, 4), modRM(0, 4, base))
	} else {
		b.code = append(b.code, modRM(2, dst, base))
	}
	var raw [4]byte
	binary.LittleEndian.PutUint32(raw[:], uint32(disp))
	b.code = append(b.code, raw[:]...)
}

func (b *x64MachineBuilder) xorpsRegReg(dst, src int) {
	b.rex(false, dst, src)
	b.code = append(b.code, 0x0f, 0x57, modRM(3, dst, src))
}

func (b *x64MachineBuilder) joOverflow() {
	b.code = append(b.code, 0x0f, 0x80)
	b.overflowFixups = append(b.overflowFixups, len(b.code))
	b.code = append(b.code, 0, 0, 0, 0)
}

func (b *x64MachineBuilder) movMemReg(base, src int) {
	b.rex(true, src, base)
	b.code = append(b.code, 0x89, modRM(0, src, base))
}

func (b *x64MachineBuilder) movRegStackDisp8(dst, base int, disp byte) {
	b.rex(true, dst, base)
	b.code = append(b.code, 0x8b, modRM(1, dst, 4), modRM(0, 4, base), disp)
}

func (b *x64MachineBuilder) movRegMemDisp32(dst, base int, disp int32) {
	b.rex(true, dst, base)
	b.code = append(b.code, 0x8b)
	if base&7 == x64RSP {
		b.code = append(b.code, modRM(2, dst, 4), modRM(0, 4, base))
	} else {
		b.code = append(b.code, modRM(2, dst, base))
	}
	var raw [4]byte
	binary.LittleEndian.PutUint32(raw[:], uint32(disp))
	b.code = append(b.code, raw[:]...)
}

func (b *x64MachineBuilder) movMemDisp32Reg(base int, disp int32, src int) {
	b.rex(true, src, base)
	b.code = append(b.code, 0x89)
	if base&7 == x64RSP {
		b.code = append(b.code, modRM(2, src, 4), modRM(0, 4, base))
	} else {
		b.code = append(b.code, modRM(2, src, base))
	}
	var raw [4]byte
	binary.LittleEndian.PutUint32(raw[:], uint32(disp))
	b.code = append(b.code, raw[:]...)
}

func (b *x64MachineBuilder) subRegImm32(reg int, value uint32) {
	b.rex(true, 0, reg)
	b.code = append(b.code, 0x81, modRM(3, 5, reg))
	var raw [4]byte
	binary.LittleEndian.PutUint32(raw[:], value)
	b.code = append(b.code, raw[:]...)
}

func (b *x64MachineBuilder) addRegImm32(reg int, value uint32) {
	b.rex(true, 0, reg)
	b.code = append(b.code, 0x81, modRM(3, 0, reg))
	var raw [4]byte
	binary.LittleEndian.PutUint32(raw[:], value)
	b.code = append(b.code, raw[:]...)
}

func (b *x64MachineBuilder) addRegImm8(reg int, value byte) {
	b.rex(true, 0, reg)
	b.code = append(b.code, 0x83, modRM(3, 0, reg), value)
}

func (b *x64MachineBuilder) subRegImm8(reg int, value byte) {
	b.rex(true, 0, reg)
	b.code = append(b.code, 0x83, modRM(3, 5, reg), value)
}

func (b *x64MachineBuilder) cmpRegImm8(reg int, value byte) {
	b.rex(true, 0, reg)
	b.code = append(b.code, 0x83, modRM(3, 7, reg), value)
}

func (b *x64MachineBuilder) cmpRegImm32(reg int, value uint32) {
	b.rex(true, 0, reg)
	b.code = append(b.code, 0x81, modRM(3, 7, reg))
	var raw [4]byte
	binary.LittleEndian.PutUint32(raw[:], value)
	b.code = append(b.code, raw[:]...)
}

func (b *x64MachineBuilder) imulRegImm8(dst, src int, value byte) {
	b.rex(true, dst, src)
	b.code = append(b.code, 0x6b, modRM(3, dst, src), value)
}

func (b *x64MachineBuilder) movzxRegByteMem(dst, base int) {
	b.rex(false, dst, base)
	b.code = append(b.code, 0x0f, 0xb6)
	if base&7 == x64RSP {
		b.code = append(b.code, modRM(1, dst, 4), modRM(0, 4, base), 0)
	} else {
		b.code = append(b.code, modRM(1, dst, base), 0)
	}
}

func (b *x64MachineBuilder) ret() { b.code = append(b.code, 0xc3) }
