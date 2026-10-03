package coreir

import (
	"encoding/binary"
	"fmt"
)

const MaxARM64LeafCodeBytes = 1 << 20

// ARM64LeafMachineABI is the first direct packed AArch64 ABI. It follows the
// existing AAPCS64 Swyp leaf contract, but uses only caller-saved x9..x15 for
// allocated SSA values so the packed leaf needs no callee-save frame.
const ARM64LeafMachineABI = "swyp-arm64-leaf-machine-aapcs64-v1"

var arm64MachineRegisters = []int{9, 10, 11, 12, 13, 14, 15}
var arm64MachineFPRegisters = []int{16, 17, 18, 19, 20, 21, 22, 23}

func ARM64MachineRegisterCount() int   { return len(arm64MachineRegisters) }
func ARM64MachineFPRegisterCount() int { return len(arm64MachineFPRegisters) }

type arm64MachineBuilder struct {
	words               []uint32
	overflowFixups      []int
	ioFailureFixups     []int
	boundsFailureFixups []int
	callFixups          []arm64CallFixup
}

func EmitARM64LeafMachineCode(f SSAFunction, plan SSARegisterPlan) ([]byte, error) {
	if len(plan.Locations) != len(f.ValueTypes) {
		return nil, fmt.Errorf("arm64 machine: register plan/value count mismatch")
	}
	gprParams, fpParams := arm64ParamCounts(f)
	if fpParams != 0 {
		return nil, fmt.Errorf("arm64 machine: leaf v1 supports GPR parameters only")
	}
	if gprParams >= len(arm64ArgRegisters) {
		return nil, fmt.Errorf("arm64 machine: leaf v1 supports at most 7 GPR parameters")
	}
	reachable := -1
	for bi, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		if reachable >= 0 {
			return nil, fmt.Errorf("arm64 machine: leaf v1 supports one reachable block")
		}
		reachable = bi
		if len(block.Phis) != 0 {
			return nil, fmt.Errorf("arm64 machine: leaf v1 does not support phi nodes")
		}
	}
	if reachable < 0 {
		return nil, fmt.Errorf("arm64 machine: no reachable block")
	}
	block := f.Blocks[reachable]
	if block.Terminator.Op != "return" {
		return nil, fmt.Errorf("arm64 machine: leaf v1 requires return terminator")
	}
	for value, t := range f.ValueTypes {
		if registerClass(t) != RegisterGPR {
			return nil, fmt.Errorf("arm64 machine: value %d uses unsupported type %s", value, t)
		}
		loc := plan.Locations[value]
		if loc.Spill >= 0 || loc.Register < 0 || loc.Register >= len(arm64MachineRegisters) {
			return nil, fmt.Errorf("arm64 machine: spill-free allocation required for value %d", value)
		}
	}
	for _, ins := range block.Instructions {
		if ins.Op == "call" {
			return nil, fmt.Errorf("arm64 machine: calls not supported in leaf v1")
		}
	}

	b := &arm64MachineBuilder{}
	statusReg := gprParams
	b.movRegReg(16, statusReg)
	for i, value := range f.Params {
		dst := arm64PhysicalMachineReg(plan, value)
		if dst != i {
			b.movRegReg(dst, i)
		}
	}
	for _, ins := range block.Instructions {
		if err := b.emitInstruction(f, plan, ins); err != nil {
			return nil, err
		}
	}
	if block.Terminator.Value >= 0 {
		result := arm64PhysicalMachineReg(plan, block.Terminator.Value)
		if result != 0 {
			b.movRegReg(0, result)
		}
	} else {
		b.movImm64(0, 0)
	}
	b.movImm64(17, 0)
	b.strReg(16, 17)
	b.ret()

	overflowOffset := len(b.words)
	b.movImm64(0, 0)
	b.movImm64(17, 1)
	b.strReg(16, 17)
	b.ret()
	for _, fixup := range b.overflowFixups {
		if err := b.patchCondBranch(fixup, overflowOffset); err != nil {
			return nil, err
		}
	}

	code := make([]byte, len(b.words)*4)
	for i, word := range b.words {
		binary.LittleEndian.PutUint32(code[i*4:], word)
	}
	if len(code) == 0 || len(code) > MaxARM64LeafCodeBytes {
		return nil, fmt.Errorf("arm64 machine: invalid code size %d", len(code))
	}
	return code, nil
}

func arm64PhysicalMachineReg(plan SSARegisterPlan, value SSAValue) int {
	return arm64MachineRegisters[plan.Locations[value].Register]
}

func arm64PhysicalMachineFPReg(plan SSARegisterPlan, value SSAValue) int {
	return arm64MachineFPRegisters[plan.Locations[value].Register]
}

func (b *arm64MachineBuilder) emitInstruction(f SSAFunction, plan SSARegisterPlan, ins SSAInstruction) error {
	if ins.Dest < 0 {
		return fmt.Errorf("arm64 machine: instruction %s has no destination", ins.Op)
	}
	destLoc := plan.Locations[ins.Dest]
	dst := 17
	if destLoc.Spill < 0 {
		dst = arm64PhysicalMachineReg(plan, ins.Dest)
	}
	commit := func() error {
		if destLoc.Spill >= 0 {
			return b.strRegSP(dst, destLoc.Spill*8)
		}
		return nil
	}
	arg := func(index, scratch int) (int, Type, error) {
		if index >= len(ins.Args) {
			return 0, "", fmt.Errorf("arm64 machine: %s missing operand %d", ins.Op, index)
		}
		value := ins.Args[index]
		loc := plan.Locations[value]
		if loc.Spill >= 0 {
			if err := b.ldrRegSP(scratch, loc.Spill*8); err != nil {
				return 0, "", err
			}
			return scratch, f.ValueTypes[value], nil
		}
		return arm64PhysicalMachineReg(plan, value), f.ValueTypes[value], nil
	}
	switch ins.Op {
	case "bytes.len":
		a, at, err := arg(0, 7)
		if err != nil {
			return err
		}
		if at != Bytes || f.ValueTypes[ins.Dest] != U64 {
			return fmt.Errorf("arm64 machine: bytes.len requires bytes -> u64")
		}
		b.movImm64(8, 0xffffffff)
		b.logicalRegReg(0x8a000000, dst, a, 8)
		return commit()
	case "bytes.get":
		return fmt.Errorf("arm64 machine: bytes.get requires native byte-arena mapping")
	case "const":
		if ins.Constant == nil {
			return fmt.Errorf("arm64 machine: const missing literal")
		}
		v, err := ParseValue(ins.Constant.Type, ins.Constant.Value)
		if err != nil {
			return err
		}
		b.movImm64(dst, valueToRaw(v))
		return commit()
	case "move":
		a, _, err := arg(0, 7)
		if err != nil {
			return err
		}
		if dst != a {
			b.movRegReg(dst, a)
		}
		return commit()
	case "bitcast_i64_u64", "bitcast_u64_i64":
		a, srcType, err := arg(0, 7)
		if err != nil {
			return err
		}
		wantSrc, wantDst := I64, U64
		if ins.Op == "bitcast_u64_i64" {
			wantSrc, wantDst = U64, I64
		}
		if srcType != wantSrc || f.ValueTypes[ins.Dest] != wantDst {
			return fmt.Errorf("arm64 machine: invalid %s types %s -> %s", ins.Op, srcType, f.ValueTypes[ins.Dest])
		}
		if dst != a {
			b.movRegReg(dst, a)
		}
		return commit()
	case "neg":
		a, t, err := arg(0, 7)
		if err != nil {
			return err
		}
		if t != I64 && t != U64 {
			return fmt.Errorf("arm64 machine: neg unsupported type %s", t)
		}
		if t == I64 {
			b.subsRegReg(dst, 31, a)
			b.branchOverflow()
		} else {
			b.subRegReg(dst, 31, a)
		}
		return commit()
	case "not":
		a, t, err := arg(0, 7)
		if err != nil {
			return err
		}
		if t != Bool {
			return fmt.Errorf("arm64 machine: not requires bool")
		}
		b.cmpRegReg(a, 31)
		b.cset(dst, 0x0) // EQ
		return commit()
	case "eq", "ne", "lt", "le", "gt", "ge":
		a, at, err := arg(0, 7)
		if err != nil {
			return err
		}
		c, bt, err := arg(1, 8)
		if err != nil {
			return err
		}
		if at != bt || (at != I64 && at != U64 && at != Bool) {
			return fmt.Errorf("arm64 machine: unsupported comparison %s/%s", at, bt)
		}
		cc, err := arm64MachineCondition(ins.Op, at)
		if err != nil {
			return err
		}
		b.cmpRegReg(a, c)
		b.cset(dst, cc)
		return commit()
	case "add", "sub", "mul", "band", "bor", "bxor":
		a, at, err := arg(0, 7)
		if err != nil {
			return err
		}
		c, bt, err := arg(1, 8)
		if err != nil {
			return err
		}
		if at != bt || (at != I64 && at != U64) {
			return fmt.Errorf("arm64 machine: %s unsupported operands %s/%s", ins.Op, at, bt)
		}
		switch ins.Op {
		case "add":
			if at == I64 {
				b.addsRegReg(dst, a, c)
				b.branchOverflow()
			} else {
				b.addRegReg(dst, a, c)
			}
		case "sub":
			if at == I64 {
				b.subsRegReg(dst, a, c)
				b.branchOverflow()
			} else {
				b.subRegReg(dst, a, c)
			}
		case "mul":
			if at == I64 {
				// Read both operands for the high half before MUL can overwrite
				// one of them when dst shares its register.
				b.smulh(6, a, c)
				b.mul(dst, a, c)
				b.asrImm(8, dst, 63)
				b.cmpRegReg(6, 8)
				b.branchCondPlaceholder(0x1) // NE
			} else {
				b.mul(dst, a, c)
			}
		case "band":
			b.logicalRegReg(0x8a000000, dst, a, c)
		case "bor":
			b.logicalRegReg(0xaa000000, dst, a, c)
		case "bxor":
			b.logicalRegReg(0xca000000, dst, a, c)
		}
		return commit()
	case "div", "rem":
		// Checked Core semantics: a zero divisor traps, i64 MIN/-1 overflows and
		// MIN%-1 is 0. SDIV/UDIV silently return 0 or MIN for those inputs, so
		// both cases are handled before dividing. Traps use status 1.
		a, at, err := arg(0, 7)
		if err != nil {
			return err
		}
		c, bt, err := arg(1, 8)
		if err != nil {
			return err
		}
		if at != bt || (at != I64 && at != U64) {
			return fmt.Errorf("arm64 machine: %s unsupported operands %s/%s", ins.Op, at, bt)
		}
		b.cmpRegReg(c, 31)
		b.branchCondPlaceholder(0x0) // EQ: division by zero
		done := -1
		if at == I64 {
			b.movImm64(6, ^uint64(0))
			b.cmpRegReg(c, 6)
			general := b.condBranchPlaceholder(0x1) // NE
			if ins.Op == "div" {
				b.subsRegReg(dst, 31, a)
				b.branchOverflow()
			} else {
				b.movImm64(dst, 0)
			}
			done = b.branchPlaceholder()
			if err := b.patchCondBranch(general, len(b.words)); err != nil {
				return err
			}
		}
		signed := at == I64
		if ins.Op == "div" {
			b.divide(signed, dst, a, c)
		} else {
			// MSUB reads all operands before writing dst, so aliasing is safe.
			b.divide(signed, 6, a, c)
			b.msub(dst, 6, c, a)
		}
		if done >= 0 {
			if err := b.patchBranch(done, len(b.words)); err != nil {
				return err
			}
		}
		return commit()
	default:
		return fmt.Errorf("arm64 machine: unsupported operation %q", ins.Op)
	}
}

func (b *arm64MachineBuilder) emitFPInstruction(f SSAFunction, plan SSARegisterPlan, ins SSAInstruction) error {
	if ins.Dest < 0 || int(ins.Dest) >= len(f.ValueTypes) {
		return fmt.Errorf("arm64 machine fp: invalid destination")
	}
	destType := f.ValueTypes[ins.Dest]
	destLoc := plan.Locations[ins.Dest]
	dstFP := 24
	if registerClass(destType) == RegisterFP && destLoc.Spill < 0 {
		dstFP = arm64PhysicalMachineFPReg(plan, ins.Dest)
	}
	source := func(index, scratch int) (int, Type, error) {
		if index >= len(ins.Args) {
			return 0, "", fmt.Errorf("arm64 machine fp: %s missing operand %d", ins.Op, index)
		}
		value := ins.Args[index]
		if value < 0 || int(value) >= len(f.ValueTypes) {
			return 0, "", fmt.Errorf("arm64 machine fp: invalid operand %d", index)
		}
		t := f.ValueTypes[value]
		if registerClass(t) != RegisterFP {
			return 0, t, fmt.Errorf("arm64 machine fp: operand %d is not floating-point", index)
		}
		loc := plan.Locations[value]
		if loc.Spill >= 0 {
			if err := b.ldrDSp(scratch, arm64MachineFPSpillOffset(f, plan, loc.Spill)); err != nil {
				return 0, "", err
			}
			return scratch, t, nil
		}
		return arm64PhysicalMachineFPReg(plan, value), t, nil
	}
	commitFP := func() error {
		if registerClass(destType) == RegisterFP && destLoc.Spill >= 0 {
			return b.strDSp(dstFP, arm64MachineFPSpillOffset(f, plan, destLoc.Spill))
		}
		return nil
	}
	if destType == F64 {
		return fmt.Errorf("arm64 machine fp: strict f64 is unsupported; use ieee64 or Core AOT")
	}
	if ins.Op == "bitcast_ieee64_u64" {
		if len(ins.Args) != 1 || f.ValueTypes[ins.Args[0]] != IEEE64 || destType != U64 {
			return fmt.Errorf("arm64 machine fp: bitcast_ieee64_u64 requires ieee64 -> u64")
		}
		a, _, err := source(0, 25)
		if err != nil {
			return err
		}
		raw := 7
		if destLoc.Spill < 0 {
			raw = arm64PhysicalMachineReg(plan, ins.Dest)
		}
		b.fmovXD(raw, a)
		if destLoc.Spill >= 0 {
			return b.strRegSP(raw, destLoc.Spill*8)
		}
		return nil
	}
	if ins.Op == "bitcast_u64_ieee64" {
		if len(ins.Args) != 1 || f.ValueTypes[ins.Args[0]] != U64 || destType != IEEE64 {
			return fmt.Errorf("arm64 machine fp: bitcast_u64_ieee64 requires u64 -> ieee64")
		}
		value := ins.Args[0]
		loc := plan.Locations[value]
		raw := 7
		if loc.Spill >= 0 {
			if err := b.ldrRegSP(raw, loc.Spill*8); err != nil {
				return err
			}
		} else {
			raw = arm64PhysicalMachineReg(plan, value)
		}
		b.fmovDX(dstFP, raw)
		return commitFP()
	}
	switch ins.Op {
	case "call":
		return fmt.Errorf("arm64 machine fp: FP calls are not supported yet")
	case "const":
		if ins.Constant == nil || ins.Constant.Type != IEEE64 {
			return fmt.Errorf("arm64 machine fp: only ieee64 constants are supported")
		}
		v, err := ParseValue(IEEE64, ins.Constant.Value)
		if err != nil {
			return err
		}
		b.movImm64(7, valueToRaw(v))
		b.fmovDX(dstFP, 7)
		return commitFP()
	case "move":
		a, at, err := source(0, 25)
		if err != nil {
			return err
		}
		if at != IEEE64 || destType != IEEE64 {
			return fmt.Errorf("arm64 machine fp: move requires ieee64")
		}
		if dstFP != a {
			b.fmovD(dstFP, a)
		}
		return commitFP()
	case "neg":
		a, at, err := source(0, 25)
		if err != nil {
			return err
		}
		if at != IEEE64 || destType != IEEE64 {
			return fmt.Errorf("arm64 machine fp: neg requires ieee64")
		}
		b.fnegD(dstFP, a)
		return commitFP()
	case "add", "sub", "mul", "div":
		a, at, err := source(0, 25)
		if err != nil {
			return err
		}
		c, bt, err := source(1, 26)
		if err != nil {
			return err
		}
		if at != IEEE64 || bt != IEEE64 || destType != IEEE64 {
			return fmt.Errorf("arm64 machine fp: %s requires ieee64", ins.Op)
		}
		base := map[string]uint32{
			"add": 0x1e602800,
			"sub": 0x1e603800,
			"mul": 0x1e600800,
			"div": 0x1e601800,
		}[ins.Op]
		b.fpBinaryD(base, dstFP, a, c)
		return commitFP()
	case "eq", "ne", "lt", "le", "gt", "ge":
		a, at, err := source(0, 25)
		if err != nil {
			return err
		}
		c, bt, err := source(1, 26)
		if err != nil {
			return err
		}
		if at != IEEE64 || bt != IEEE64 || destType != Bool {
			return fmt.Errorf("arm64 machine fp: comparison requires ieee64 operands and bool result")
		}
		dst := 17
		if destLoc.Spill < 0 {
			dst = arm64PhysicalMachineReg(plan, ins.Dest)
		}
		b.fcmpD(a, c)
		cc := map[string]uint32{
			"eq": 0x0,
			"ne": 0x1,
			"lt": 0x4, // MI: false for unordered/NaN
			"le": 0x9, // LS: false for unordered/NaN
			"gt": 0xc,
			"ge": 0xa,
		}[ins.Op]
		b.cset(dst, cc)
		if destLoc.Spill >= 0 {
			return b.strRegSP(dst, destLoc.Spill*8)
		}
		return nil
	default:
		return fmt.Errorf("arm64 machine fp: unsupported ieee64 operation %q", ins.Op)
	}
}

func arm64MachineCondition(op string, t Type) (uint32, error) {
	if op == "eq" {
		return 0x0, nil
	}
	if op == "ne" {
		return 0x1, nil
	}
	if t == I64 {
		return map[string]uint32{"lt": 0xb, "le": 0xd, "gt": 0xc, "ge": 0xa}[op], nil
	}
	if t == U64 || t == Bool {
		return map[string]uint32{"lt": 0x3, "le": 0x9, "gt": 0x8, "ge": 0x2}[op], nil
	}
	return 0, fmt.Errorf("arm64 machine: unsupported comparison type %s", t)
}

func (b *arm64MachineBuilder) append(word uint32) { b.words = append(b.words, word) }

func (b *arm64MachineBuilder) movRegReg(dst, src int) {
	b.append(0xaa0003e0 | uint32(src&31)<<16 | uint32(dst&31))
}

func (b *arm64MachineBuilder) movImm64(dst int, value uint64) {
	first := true
	for hw := 0; hw < 4; hw++ {
		part := uint32((value >> (16 * hw)) & 0xffff)
		if part == 0 && !first {
			continue
		}
		if first {
			b.append(0xd2800000 | uint32(hw)<<21 | part<<5 | uint32(dst&31))
			first = false
		} else {
			b.append(0xf2800000 | uint32(hw)<<21 | part<<5 | uint32(dst&31))
		}
	}
	if first {
		b.append(0xd2800000 | uint32(dst&31))
	}
}

func (b *arm64MachineBuilder) addRegReg(dst, a, c int) {
	b.append(0x8b000000 | uint32(c&31)<<16 | uint32(a&31)<<5 | uint32(dst&31))
}

func (b *arm64MachineBuilder) addRegImm(dst, src, amount int) error {
	if amount < 0 || amount > 0xfff {
		return fmt.Errorf("arm64 machine: add immediate %d out of range", amount)
	}
	b.append(0x91000000 | uint32(amount)<<10 | uint32(src&31)<<5 | uint32(dst&31))
	return nil
}

func (b *arm64MachineBuilder) addsRegReg(dst, a, c int) {
	b.append(0xab000000 | uint32(c&31)<<16 | uint32(a&31)<<5 | uint32(dst&31))
}

func (b *arm64MachineBuilder) subRegReg(dst, a, c int) {
	b.append(0xcb000000 | uint32(c&31)<<16 | uint32(a&31)<<5 | uint32(dst&31))
}

func (b *arm64MachineBuilder) subRegImm(dst, src, amount int) error {
	if amount < 0 || amount > 0xfff {
		return fmt.Errorf("arm64 machine: sub immediate %d out of range", amount)
	}
	b.append(0xd1000000 | uint32(amount)<<10 | uint32(src&31)<<5 | uint32(dst&31))
	return nil
}

func (b *arm64MachineBuilder) subsRegReg(dst, a, c int) {
	b.append(0xeb000000 | uint32(c&31)<<16 | uint32(a&31)<<5 | uint32(dst&31))
}

func (b *arm64MachineBuilder) logicalRegReg(base uint32, dst, a, c int) {
	b.append(base | uint32(c&31)<<16 | uint32(a&31)<<5 | uint32(dst&31))
}

func (b *arm64MachineBuilder) mul(dst, a, c int) {
	b.append(0x9b007c00 | uint32(c&31)<<16 | uint32(a&31)<<5 | uint32(dst&31))
}

func (b *arm64MachineBuilder) smulh(dst, a, c int) {
	b.append(0x9b407c00 | uint32(c&31)<<16 | uint32(a&31)<<5 | uint32(dst&31))
}

func (b *arm64MachineBuilder) asrImm(dst, src, shift int) {
	b.append(0x93400000 | uint32(shift&63)<<16 | 0xfc00 | uint32(src&31)<<5 | uint32(dst&31))
}

func (b *arm64MachineBuilder) lsrImm(dst, src, shift int) {
	b.append(0xd3400000 | uint32(shift&63)<<16 | 0xfc00 | uint32(src&31)<<5 | uint32(dst&31))
}

func (b *arm64MachineBuilder) cmpRegReg(a, c int) {
	b.append(0xeb00001f | uint32(c&31)<<16 | uint32(a&31)<<5)
}

func (b *arm64MachineBuilder) cmpRegImm(reg, amount int) error {
	if amount < 0 || amount > 0xfff {
		return fmt.Errorf("arm64 machine: compare immediate %d out of range", amount)
	}
	b.append(0xf100001f | uint32(amount)<<10 | uint32(reg&31)<<5)
	return nil
}

func (b *arm64MachineBuilder) ldrRegBase(dst, base, offset int) error {
	if offset < 0 || offset%8 != 0 || offset/8 > 0xfff {
		return fmt.Errorf("arm64 machine: load offset %d out of range", offset)
	}
	b.append(0xf9400000 | uint32(offset/8)<<10 | uint32(base&31)<<5 | uint32(dst&31))
	return nil
}

func (b *arm64MachineBuilder) strRegBase(src, base, offset int) error {
	if offset < 0 || offset%8 != 0 || offset/8 > 0xfff {
		return fmt.Errorf("arm64 machine: store offset %d out of range", offset)
	}
	b.append(0xf9000000 | uint32(offset/8)<<10 | uint32(base&31)<<5 | uint32(src&31))
	return nil
}

func (b *arm64MachineBuilder) ldrbRegBase(dst, base, offset int) error {
	if offset < 0 || offset > 0xfff {
		return fmt.Errorf("arm64 machine: byte load offset %d out of range", offset)
	}
	b.append(0x39400000 | uint32(offset)<<10 | uint32(base&31)<<5 | uint32(dst&31))
	return nil
}

func (b *arm64MachineBuilder) strbRegBase(src, base, offset int) error {
	if offset < 0 || offset > 0xfff {
		return fmt.Errorf("arm64 machine: byte store offset %d out of range", offset)
	}
	b.append(0x39000000 | uint32(offset)<<10 | uint32(base&31)<<5 | uint32(src&31))
	return nil
}

func (b *arm64MachineBuilder) udiv(dst, numerator, denominator int) {
	b.append(0x9ac00800 | uint32(denominator&31)<<16 | uint32(numerator&31)<<5 | uint32(dst&31))
}

// divide emits 64-bit SDIV or UDIV.
func (b *arm64MachineBuilder) divide(signed bool, dst, numerator, denominator int) {
	if signed {
		b.append(0x9ac00c00 | uint32(denominator&31)<<16 | uint32(numerator&31)<<5 | uint32(dst&31))
		return
	}
	b.udiv(dst, numerator, denominator)
}

// msub emits MSUB: dst = minuend - a*c.
func (b *arm64MachineBuilder) msub(dst, a, c, minuend int) {
	b.append(0x9b008000 | uint32(c&31)<<16 | uint32(minuend&31)<<10 | uint32(a&31)<<5 | uint32(dst&31))
}

func (b *arm64MachineBuilder) cset(dst int, cond uint32) {
	inverse := cond ^ 1
	b.append(0x9a800400 | 31<<16 | inverse<<12 | 31<<5 | uint32(dst&31))
}

func (b *arm64MachineBuilder) strReg(base, src int) {
	b.append(0xf9000000 | uint32(base&31)<<5 | uint32(src&31))
}

func (b *arm64MachineBuilder) fmovD(dst, src int) {
	b.append(0x1e604000 | uint32(src&31)<<5 | uint32(dst&31))
}

func (b *arm64MachineBuilder) fmovDX(dstD, srcX int) {
	b.append(0x9e670000 | uint32(srcX&31)<<5 | uint32(dstD&31))
}

func (b *arm64MachineBuilder) fmovXD(dstX, srcD int) {
	b.append(0x9e660000 | uint32(srcD&31)<<5 | uint32(dstX&31))
}

func (b *arm64MachineBuilder) scvtfDReg(dstD, srcX int) {
	b.append(0x9e620000 | uint32(srcX&31)<<5 | uint32(dstD&31))
}

func (b *arm64MachineBuilder) fnegD(dst, src int) {
	b.append(0x1e614000 | uint32(src&31)<<5 | uint32(dst&31))
}

func (b *arm64MachineBuilder) fpBinaryD(base uint32, dst, a, c int) {
	b.append(base | uint32(c&31)<<16 | uint32(a&31)<<5 | uint32(dst&31))
}

func (b *arm64MachineBuilder) fcmpD(a, c int) {
	b.append(0x1e602000 | uint32(c&31)<<16 | uint32(a&31)<<5)
}

func (b *arm64MachineBuilder) strDSp(src, offset int) error {
	if offset < 0 || offset%8 != 0 || offset/8 > 0xfff {
		return fmt.Errorf("arm64 machine fp: spill store offset %d out of range", offset)
	}
	b.append(0xfd0003e0 | uint32(offset/8)<<10 | uint32(src&31))
	return nil
}

func (b *arm64MachineBuilder) ldrDSp(dst, offset int) error {
	if offset < 0 || offset%8 != 0 || offset/8 > 0xfff {
		return fmt.Errorf("arm64 machine fp: spill load offset %d out of range", offset)
	}
	b.append(0xfd4003e0 | uint32(offset/8)<<10 | uint32(dst&31))
	return nil
}

func (b *arm64MachineBuilder) branchOverflow() { b.branchCondPlaceholder(0x6) }

func (b *arm64MachineBuilder) branchCondPlaceholder(cond uint32) {
	index := len(b.words)
	b.append(0x54000000 | (cond & 0xf))
	b.overflowFixups = append(b.overflowFixups, index)
}

func (b *arm64MachineBuilder) patchCondBranch(index, target int) error {
	rel := target - index
	if rel < -(1<<18) || rel >= 1<<18 {
		return fmt.Errorf("arm64 machine: conditional branch out of range")
	}
	word := b.words[index] & 0xff00001f
	word |= uint32(rel&0x7ffff) << 5
	b.words[index] = word
	return nil
}

func (b *arm64MachineBuilder) ret() { b.append(0xd65f03c0) }
