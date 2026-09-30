package coreir

import (
	"fmt"
	"math"
)

const (
	arm64ExeArgBaseOffset = 0
	arm64ExeStatusOffset  = 128
	arm64ExeFrameBytes    = 144
)

type arm64ExeFixupKind uint8

const (
	arm64ExeFixupCond arm64ExeFixupKind = iota
	arm64ExeFixupCBZ
	arm64ExeFixupBranch
)

type arm64ExeFixup struct {
	index int
	kind  arm64ExeFixupKind
}

func patchARM64ExeFixups(b *arm64MachineBuilder, fixups []arm64ExeFixup, target int) error {
	for _, fixup := range fixups {
		var err error
		switch fixup.kind {
		case arm64ExeFixupCond:
			err = b.patchCondBranch(fixup.index, target)
		case arm64ExeFixupCBZ:
			err = b.patchCBZ(fixup.index, target)
		case arm64ExeFixupBranch:
			err = b.patchBranch(fixup.index, target)
		default:
			err = fmt.Errorf("arm64 executable: unknown fixup kind %d", fixup.kind)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func validateARM64ExecutableSignature(f SSAFunction) error {
	gprParams, fpParams := 0, 0
	for i, value := range f.Params {
		t := f.ValueTypes[value]
		if t == IEEE64 {
			fpParams++
			continue
		}
		if t != I64 && t != U64 && t != Bool {
			return fmt.Errorf("direct ARM64 executable parameter %d type %s is unsupported; use i64/u64/bool/ieee64", i, t)
		}
		gprParams++
	}
	if gprParams > 7 || fpParams > 8 {
		return fmt.Errorf("direct ARM64 executable argument registers exceeded: gpr=%d fp=%d", gprParams, fpParams)
	}
	if f.Result != I64 && f.Result != U64 && f.Result != Bool {
		return fmt.Errorf("result type %s cannot be used as a process exit code", f.Result)
	}
	return nil
}

// ARM64 argv parser register contract (outside packed allocator x9-x15):
// x20 pointer, x21 result, x22 current char, x23 sign, x24 digit count,
// x25 max/10, x26 max%%10, x27 constant 10.
func emitARM64ParseScalarArg(b *arm64MachineBuilder, t Type) ([]arm64ExeFixup, error) {
	switch t {
	case I64, U64:
		return emitARM64ParseIntegerArg(b, t)
	case Bool:
		return emitARM64ParseBoolArg(b)
	case IEEE64:
		return emitARM64ParseIEEE64Arg(b)
	default:
		return nil, fmt.Errorf("arm64 executable parser: unsupported type %s", t)
	}
}

func emitARM64ParseIEEE64Arg(b *arm64MachineBuilder) ([]arm64ExeFixup, error) {
	failures := make([]arm64ExeFixup, 0, 16)
	b.movImm64(23, 0) // sign
	if err := b.ldrbRegBase(22, 20, 0); err != nil {
		return nil, err
	}
	if err := b.cmpRegImm(22, '-'); err != nil {
		return nil, err
	}
	notMinus := b.condBranchPlaceholder(0x1)
	b.movImm64(23, 1)
	if err := b.addRegImm(20, 20, 1); err != nil {
		return nil, err
	}
	afterMinus := b.branchPlaceholder()
	checkPlus := len(b.words)
	if err := b.patchCondBranch(notMinus, checkPlus); err != nil {
		return nil, err
	}
	if err := b.cmpRegImm(22, '+'); err != nil {
		return nil, err
	}
	notPlus := b.condBranchPlaceholder(0x1)
	if err := b.addRegImm(20, 20, 1); err != nil {
		return nil, err
	}
	signDone := len(b.words)
	if err := b.patchBranch(afterMinus, signDone); err != nil {
		return nil, err
	}
	if err := b.patchCondBranch(notPlus, signDone); err != nil {
		return nil, err
	}

	b.fmovDX(0, 31) // 0.0
	b.movImm64(27, math.Float64bits(10.0))
	b.fmovDX(1, 27)
	b.movImm64(27, math.Float64bits(0.1))
	b.fmovDX(3, 27)
	b.fmovDX(4, 27)
	b.movImm64(24, 0) // mantissa digit count

	integerLoop := len(b.words)
	if err := b.ldrbRegBase(22, 20, 0); err != nil {
		return nil, err
	}
	if err := b.cmpRegImm(22, '0'); err != nil {
		return nil, err
	}
	integerBelow := b.condBranchPlaceholder(0x3)
	if err := b.cmpRegImm(22, '9'); err != nil {
		return nil, err
	}
	integerAbove := b.condBranchPlaceholder(0x8)
	if err := b.subRegImm(22, 22, '0'); err != nil {
		return nil, err
	}
	b.fpBinaryD(0x1e600800, 0, 0, 1) // fmul d0,d0,d1
	b.scvtfDReg(2, 22)
	b.fpBinaryD(0x1e602800, 0, 0, 2) // fadd d0,d0,d2
	if err := b.addRegImm(20, 20, 1); err != nil {
		return nil, err
	}
	if err := b.addRegImm(24, 24, 1); err != nil {
		return nil, err
	}
	integerBack := b.branchPlaceholder()
	if err := b.patchBranch(integerBack, integerLoop); err != nil {
		return nil, err
	}
	integerDone := len(b.words)
	if err := b.patchCondBranch(integerBelow, integerDone); err != nil {
		return nil, err
	}
	if err := b.patchCondBranch(integerAbove, integerDone); err != nil {
		return nil, err
	}
	if err := b.cmpRegImm(22, '.'); err != nil {
		return nil, err
	}
	noFraction := b.condBranchPlaceholder(0x1)
	if err := b.addRegImm(20, 20, 1); err != nil {
		return nil, err
	}
	fractionLoop := len(b.words)
	if err := b.ldrbRegBase(22, 20, 0); err != nil {
		return nil, err
	}
	if err := b.cmpRegImm(22, '0'); err != nil {
		return nil, err
	}
	fractionBelow := b.condBranchPlaceholder(0x3)
	if err := b.cmpRegImm(22, '9'); err != nil {
		return nil, err
	}
	fractionAbove := b.condBranchPlaceholder(0x8)
	if err := b.subRegImm(22, 22, '0'); err != nil {
		return nil, err
	}
	b.scvtfDReg(2, 22)
	b.fpBinaryD(0x1e600800, 2, 2, 3)
	b.fpBinaryD(0x1e602800, 0, 0, 2)
	b.fpBinaryD(0x1e600800, 3, 3, 4)
	if err := b.addRegImm(20, 20, 1); err != nil {
		return nil, err
	}
	if err := b.addRegImm(24, 24, 1); err != nil {
		return nil, err
	}
	fractionBack := b.branchPlaceholder()
	if err := b.patchBranch(fractionBack, fractionLoop); err != nil {
		return nil, err
	}
	afterFraction := len(b.words)
	for _, pos := range []int{fractionBelow, fractionAbove, noFraction} {
		if err := b.patchCondBranch(pos, afterFraction); err != nil {
			return nil, err
		}
	}
	failures = append(failures, arm64ExeFixup{b.cbzPlaceholder(24), arm64ExeFixupCBZ})

	if err := b.ldrbRegBase(22, 20, 0); err != nil {
		return nil, err
	}
	if err := b.cmpRegImm(22, 'e'); err != nil {
		return nil, err
	}
	lowerExponent := b.condBranchPlaceholder(0x0)
	if err := b.cmpRegImm(22, 'E'); err != nil {
		return nil, err
	}
	noExponent := b.condBranchPlaceholder(0x1)
	exponentStart := len(b.words)
	if err := b.patchCondBranch(lowerExponent, exponentStart); err != nil {
		return nil, err
	}
	if err := b.addRegImm(20, 20, 1); err != nil {
		return nil, err
	}
	b.movImm64(26, 0) // exponent sign
	if err := b.ldrbRegBase(22, 20, 0); err != nil {
		return nil, err
	}
	if err := b.cmpRegImm(22, '-'); err != nil {
		return nil, err
	}
	exponentNotMinus := b.condBranchPlaceholder(0x1)
	b.movImm64(26, 1)
	if err := b.addRegImm(20, 20, 1); err != nil {
		return nil, err
	}
	exponentSignDoneJump := b.branchPlaceholder()
	exponentCheckPlus := len(b.words)
	if err := b.patchCondBranch(exponentNotMinus, exponentCheckPlus); err != nil {
		return nil, err
	}
	if err := b.cmpRegImm(22, '+'); err != nil {
		return nil, err
	}
	exponentNotPlus := b.condBranchPlaceholder(0x1)
	if err := b.addRegImm(20, 20, 1); err != nil {
		return nil, err
	}
	exponentSignDone := len(b.words)
	if err := b.patchBranch(exponentSignDoneJump, exponentSignDone); err != nil {
		return nil, err
	}
	if err := b.patchCondBranch(exponentNotPlus, exponentSignDone); err != nil {
		return nil, err
	}

	b.movImm64(25, 0) // exponent magnitude
	b.movImm64(27, 0) // exponent digit count
	b.movImm64(28, 400)
	exponentLoop := len(b.words)
	if err := b.ldrbRegBase(22, 20, 0); err != nil {
		return nil, err
	}
	if err := b.cmpRegImm(22, '0'); err != nil {
		return nil, err
	}
	exponentBelow := b.condBranchPlaceholder(0x3)
	if err := b.cmpRegImm(22, '9'); err != nil {
		return nil, err
	}
	exponentAbove := b.condBranchPlaceholder(0x8)
	if err := b.subRegImm(22, 22, '0'); err != nil {
		return nil, err
	}
	b.cmpRegReg(25, 28)
	exponentAtCap := b.condBranchPlaceholder(0x2) // HS/CS
	b.movImm64(21, 10)
	b.mul(25, 25, 21)
	b.addRegReg(25, 25, 22)
	b.cmpRegReg(25, 28)
	exponentWithinCap := b.condBranchPlaceholder(0x9) // LS
	b.movImm64(25, 400)
	exponentAccumDone := len(b.words)
	for _, pos := range []int{exponentAtCap, exponentWithinCap} {
		if err := b.patchCondBranch(pos, exponentAccumDone); err != nil {
			return nil, err
		}
	}
	if err := b.addRegImm(20, 20, 1); err != nil {
		return nil, err
	}
	if err := b.addRegImm(27, 27, 1); err != nil {
		return nil, err
	}
	exponentBack := b.branchPlaceholder()
	if err := b.patchBranch(exponentBack, exponentLoop); err != nil {
		return nil, err
	}
	exponentDone := len(b.words)
	for _, pos := range []int{exponentBelow, exponentAbove} {
		if err := b.patchCondBranch(pos, exponentDone); err != nil {
			return nil, err
		}
	}
	failures = append(failures, arm64ExeFixup{b.cbzPlaceholder(27), arm64ExeFixupCBZ})
	zeroExponent := b.cbzPlaceholder(25)
	exponentApplyLoop := len(b.words)
	exponentPositive := b.cbzPlaceholder(26)
	b.fpBinaryD(0x1e601800, 0, 0, 1) // fdiv d0,d0,d1
	exponentApplied := b.branchPlaceholder()
	exponentMultiply := len(b.words)
	if err := b.patchCBZ(exponentPositive, exponentMultiply); err != nil {
		return nil, err
	}
	b.fpBinaryD(0x1e600800, 0, 0, 1)
	exponentStepDone := len(b.words)
	if err := b.patchBranch(exponentApplied, exponentStepDone); err != nil {
		return nil, err
	}
	if err := b.subRegImm(25, 25, 1); err != nil {
		return nil, err
	}
	exponentAgain := b.cbzPlaceholder(25)
	continueExponent := b.branchPlaceholder()
	if err := b.patchBranch(continueExponent, exponentApplyLoop); err != nil {
		return nil, err
	}
	afterExponent := len(b.words)
	if err := b.patchCBZ(exponentAgain, afterExponent); err != nil {
		return nil, err
	}
	if err := b.patchCBZ(zeroExponent, afterExponent); err != nil {
		return nil, err
	}
	afterExponentJump := b.branchPlaceholder()

	withoutExponent := len(b.words)
	if err := b.patchCondBranch(noExponent, withoutExponent); err != nil {
		return nil, err
	}
	delimiter := len(b.words)
	if err := b.patchBranch(afterExponentJump, delimiter); err != nil {
		return nil, err
	}
	if err := b.ldrbRegBase(22, 20, 0); err != nil {
		return nil, err
	}
	validNUL := b.cbzPlaceholder(22)
	failures = append(failures, arm64ExeFixup{b.branchPlaceholder(), arm64ExeFixupBranch})
	if err := b.patchCBZ(validNUL, len(b.words)); err != nil {
		return nil, err
	}
	nonNegative := b.cbzPlaceholder(23)
	b.fnegD(0, 0)
	if err := b.patchCBZ(nonNegative, len(b.words)); err != nil {
		return nil, err
	}
	b.fmovXD(21, 0)
	return failures, nil
}

func emitARM64ParseIntegerArg(b *arm64MachineBuilder, t Type) ([]arm64ExeFixup, error) {
	failures := make([]arm64ExeFixup, 0, 10)
	b.movImm64(23, 0)
	if t == I64 {
		if err := b.ldrbRegBase(22, 20, 0); err != nil {
			return nil, err
		}
		if err := b.cmpRegImm(22, '-'); err != nil {
			return nil, err
		}
		notNegative := b.condBranchPlaceholder(0x1) // NE
		b.movImm64(23, 1)
		if err := b.addRegImm(20, 20, 1); err != nil {
			return nil, err
		}
		if err := b.patchCondBranch(notNegative, len(b.words)); err != nil {
			return nil, err
		}
	}
	b.movImm64(21, 0)
	b.movImm64(24, 0)
	if t == U64 {
		b.movImm64(25, 1844674407370955161)
		b.movImm64(26, 5)
	} else {
		b.movImm64(25, 922337203685477580)
		b.movImm64(26, 7)
		negative := b.cbzPlaceholder(23)
		b.movImm64(26, 8)
		if err := b.patchCBZ(negative, len(b.words)); err != nil {
			return nil, err
		}
	}
	b.movImm64(27, 10)

	loop := len(b.words)
	if err := b.ldrbRegBase(22, 20, 0); err != nil {
		return nil, err
	}
	doneNUL := b.cbzPlaceholder(22)
	if err := b.cmpRegImm(22, '0'); err != nil {
		return nil, err
	}
	failures = append(failures, arm64ExeFixup{b.condBranchPlaceholder(0x3), arm64ExeFixupCond}) // LO
	if err := b.cmpRegImm(22, '9'); err != nil {
		return nil, err
	}
	failures = append(failures, arm64ExeFixup{b.condBranchPlaceholder(0x8), arm64ExeFixupCond}) // HI
	if err := b.subRegImm(22, 22, '0'); err != nil {
		return nil, err
	}
	b.cmpRegReg(21, 25)
	failures = append(failures, arm64ExeFixup{b.condBranchPlaceholder(0x8), arm64ExeFixupCond}) // HI
	belowThreshold := b.condBranchPlaceholder(0x3)                                              // LO
	b.cmpRegReg(22, 26)
	failures = append(failures, arm64ExeFixup{b.condBranchPlaceholder(0x8), arm64ExeFixupCond}) // HI
	if err := b.patchCondBranch(belowThreshold, len(b.words)); err != nil {
		return nil, err
	}
	b.mul(21, 21, 27)
	b.addRegReg(21, 21, 22)
	if err := b.addRegImm(20, 20, 1); err != nil {
		return nil, err
	}
	if err := b.addRegImm(24, 24, 1); err != nil {
		return nil, err
	}
	back := b.branchPlaceholder()
	if err := b.patchBranch(back, loop); err != nil {
		return nil, err
	}
	done := len(b.words)
	if err := b.patchCBZ(doneNUL, done); err != nil {
		return nil, err
	}
	failures = append(failures, arm64ExeFixup{b.cbzPlaceholder(24), arm64ExeFixupCBZ})
	if t == I64 {
		nonNegative := b.cbzPlaceholder(23)
		b.subRegReg(21, 31, 21)
		if err := b.patchCBZ(nonNegative, len(b.words)); err != nil {
			return nil, err
		}
	}
	return failures, nil
}

func emitARM64ParseBoolArg(b *arm64MachineBuilder) ([]arm64ExeFixup, error) {
	failures := make([]arm64ExeFixup, 0, 12)
	if err := b.ldrbRegBase(22, 20, 0); err != nil {
		return nil, err
	}
	if err := b.cmpRegImm(22, '0'); err != nil {
		return nil, err
	}
	isZero := b.condBranchPlaceholder(0x0)
	if err := b.cmpRegImm(22, '1'); err != nil {
		return nil, err
	}
	isOne := b.condBranchPlaceholder(0x0)
	if err := b.cmpRegImm(22, 't'); err != nil {
		return nil, err
	}
	isTrue := b.condBranchPlaceholder(0x0)
	if err := b.cmpRegImm(22, 'f'); err != nil {
		return nil, err
	}
	isFalse := b.condBranchPlaceholder(0x0)
	failures = append(failures, arm64ExeFixup{b.branchPlaceholder(), arm64ExeFixupBranch})

	zeroLabel := len(b.words)
	if err := b.patchCondBranch(isZero, zeroLabel); err != nil {
		return nil, err
	}
	b.movImm64(21, 0)
	if err := b.addRegImm(20, 20, 1); err != nil {
		return nil, err
	}
	zeroDone := b.branchPlaceholder()

	oneLabel := len(b.words)
	if err := b.patchCondBranch(isOne, oneLabel); err != nil {
		return nil, err
	}
	b.movImm64(21, 1)
	if err := b.addRegImm(20, 20, 1); err != nil {
		return nil, err
	}
	oneDone := b.branchPlaceholder()

	trueLabel := len(b.words)
	if err := b.patchCondBranch(isTrue, trueLabel); err != nil {
		return nil, err
	}
	if err := b.addRegImm(20, 20, 1); err != nil {
		return nil, err
	}
	for _, ch := range []byte{'r', 'u', 'e'} {
		if err := b.ldrbRegBase(22, 20, 0); err != nil {
			return nil, err
		}
		if err := b.cmpRegImm(22, int(ch)); err != nil {
			return nil, err
		}
		failures = append(failures, arm64ExeFixup{b.condBranchPlaceholder(0x1), arm64ExeFixupCond})
		if err := b.addRegImm(20, 20, 1); err != nil {
			return nil, err
		}
	}
	b.movImm64(21, 1)
	trueDone := b.branchPlaceholder()

	falseLabel := len(b.words)
	if err := b.patchCondBranch(isFalse, falseLabel); err != nil {
		return nil, err
	}
	if err := b.addRegImm(20, 20, 1); err != nil {
		return nil, err
	}
	for _, ch := range []byte{'a', 'l', 's', 'e'} {
		if err := b.ldrbRegBase(22, 20, 0); err != nil {
			return nil, err
		}
		if err := b.cmpRegImm(22, int(ch)); err != nil {
			return nil, err
		}
		failures = append(failures, arm64ExeFixup{b.condBranchPlaceholder(0x1), arm64ExeFixupCond})
		if err := b.addRegImm(20, 20, 1); err != nil {
			return nil, err
		}
	}
	b.movImm64(21, 0)

	delimiter := len(b.words)
	for _, pos := range []int{zeroDone, oneDone, trueDone} {
		if err := b.patchBranch(pos, delimiter); err != nil {
			return nil, err
		}
	}
	if err := b.ldrbRegBase(22, 20, 0); err != nil {
		return nil, err
	}
	valid := b.cbzPlaceholder(22)
	failures = append(failures, arm64ExeFixup{b.branchPlaceholder(), arm64ExeFixupBranch})
	if err := b.patchCBZ(valid, len(b.words)); err != nil {
		return nil, err
	}
	return failures, nil
}
