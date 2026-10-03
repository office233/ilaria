package coreir

import (
	"fmt"
	"math"
)

const (
	x64ExeArgBaseOffset = 40
	x64ExeStatusOffset  = 80
)

func validateX64ExecutableSignature(f SSAFunction) error {
	if len(f.Params) > 4 {
		return fmt.Errorf("direct executable supports at most four program parameters")
	}
	for i, value := range f.Params {
		t := f.ValueTypes[value]
		if t != I64 && t != U64 && t != Bool && t != IEEE64 {
			return fmt.Errorf("direct executable parameter %d type %s is unsupported; use i64/u64/bool/ieee64", i, t)
		}
	}
	if f.Result != I64 && f.Result != U64 && f.Result != Bool {
		return fmt.Errorf("result type %s cannot be used as a process exit code", f.Result)
	}
	return nil
}

// emitX64ParseScalarArg parses one ASCII argument at RSI. It leaves the parsed
// value in RAX and RSI on the delimiter. When allowWhitespaceDelimiter is false
// only NUL terminates the argument; Windows command-line mode also accepts space
// and tab delimiters. Returned rel32 positions must be patched to the caller's
// argument-error path.
func emitX64ParseScalarArg(b *x64MachineBuilder, t Type, allowWhitespaceDelimiter bool) ([]int, error) {
	switch t {
	case Bool:
		return emitX64ParseBoolArg(b, allowWhitespaceDelimiter), nil
	case I64, U64:
		return emitX64ParseIntegerArg(b, t, allowWhitespaceDelimiter), nil
	case IEEE64:
		return emitX64ParseIEEE64Arg(b, allowWhitespaceDelimiter), nil
	default:
		return nil, fmt.Errorf("x64 executable parser: unsupported type %s", t)
	}
}

func emitX64ParseIEEE64Arg(b *x64MachineBuilder, allowWhitespaceDelimiter bool) []int {
	failures := make([]int, 0, 16)
	b.xorRegReg(x64RBX, x64RBX) // sign flag
	b.movzxRegByteMem(x64RDX, x64RSI)
	b.cmpRegImm8(x64RDX, '-')
	notMinus := b.jccRel32(0x5)
	b.movRegImm64(x64RBX, 1)
	b.addRegImm8(x64RSI, 1)
	afterMinus := b.jmpRel32()
	checkPlus := len(b.code)
	patchX64Rel32(b.code, notMinus, checkPlus)
	b.cmpRegImm8(x64RDX, '+')
	notPlus := b.jccRel32(0x5)
	b.addRegImm8(x64RSI, 1)
	signDone := len(b.code)
	patchX64Rel32(b.code, afterMinus, signDone)
	patchX64Rel32(b.code, notPlus, signDone)

	b.xorpsRegReg(0, 0) // XMM0 result
	b.movRegImm64(x64R10, math.Float64bits(10.0))
	b.movqXMMReg(1, x64R10) // XMM1 = 10
	b.movRegImm64(x64R10, math.Float64bits(0.1))
	b.movqXMMReg(3, x64R10) // XMM3 = scale 0.1
	b.movqXMMReg(4, x64R10) // XMM4 = constant 0.1
	b.xorRegReg(x64R9, x64R9)

	integerLoop := len(b.code)
	b.movzxRegByteMem(x64RDX, x64RSI)
	b.cmpRegImm8(x64RDX, '0')
	integerBelow := b.jccRel32(0x2)
	b.cmpRegImm8(x64RDX, '9')
	integerAbove := b.jccRel32(0x7)
	b.subRegImm8(x64RDX, '0')
	b.scalarSDRegReg(0x59, 0, 1) // MULSD result,10
	b.cvtsi2sdXMMReg(2, x64RDX)
	b.scalarSDRegReg(0x58, 0, 2) // ADDSD result,digit
	b.addRegImm8(x64RSI, 1)
	b.addRegImm8(x64R9, 1)
	integerBack := b.jmpRel32()
	patchX64Rel32(b.code, integerBack, integerLoop)

	integerDone := len(b.code)
	patchX64Rel32(b.code, integerBelow, integerDone)
	patchX64Rel32(b.code, integerAbove, integerDone)
	b.cmpRegImm8(x64RDX, '.')
	noFraction := b.jccRel32(0x5)
	b.addRegImm8(x64RSI, 1)

	fractionLoop := len(b.code)
	b.movzxRegByteMem(x64RDX, x64RSI)
	b.cmpRegImm8(x64RDX, '0')
	fractionBelow := b.jccRel32(0x2)
	b.cmpRegImm8(x64RDX, '9')
	fractionAbove := b.jccRel32(0x7)
	b.subRegImm8(x64RDX, '0')
	b.cvtsi2sdXMMReg(2, x64RDX)
	b.scalarSDRegReg(0x59, 2, 3) // digit *= scale
	b.scalarSDRegReg(0x58, 0, 2) // result += digit
	b.scalarSDRegReg(0x59, 3, 4) // scale *= 0.1
	b.addRegImm8(x64RSI, 1)
	b.addRegImm8(x64R9, 1)
	fractionBack := b.jmpRel32()
	patchX64Rel32(b.code, fractionBack, fractionLoop)

	afterFraction := len(b.code)
	patchX64Rel32(b.code, fractionBelow, afterFraction)
	patchX64Rel32(b.code, fractionAbove, afterFraction)
	patchX64Rel32(b.code, noFraction, afterFraction)
	b.testRegReg(x64R9, x64R9)
	failures = append(failures, b.jccRel32(0x4)) // no mantissa digits

	b.movzxRegByteMem(x64RDX, x64RSI)
	b.cmpRegImm8(x64RDX, 'e')
	lowerExponent := b.jccRel32(0x4)
	b.cmpRegImm8(x64RDX, 'E')
	noExponent := b.jccRel32(0x5)
	exponentStart := len(b.code)
	patchX64Rel32(b.code, lowerExponent, exponentStart)
	b.addRegImm8(x64RSI, 1)
	b.xorRegReg(x64R8, x64R8) // exponent sign
	b.movzxRegByteMem(x64RDX, x64RSI)
	b.cmpRegImm8(x64RDX, '-')
	exponentNotMinus := b.jccRel32(0x5)
	b.movRegImm64(x64R8, 1)
	b.addRegImm8(x64RSI, 1)
	exponentSignDoneJump := b.jmpRel32()
	exponentCheckPlus := len(b.code)
	patchX64Rel32(b.code, exponentNotMinus, exponentCheckPlus)
	b.cmpRegImm8(x64RDX, '+')
	exponentNotPlus := b.jccRel32(0x5)
	b.addRegImm8(x64RSI, 1)
	exponentSignDone := len(b.code)
	patchX64Rel32(b.code, exponentSignDoneJump, exponentSignDone)
	patchX64Rel32(b.code, exponentNotPlus, exponentSignDone)

	b.xorRegReg(x64R10, x64R10) // exponent magnitude
	b.xorRegReg(x64RAX, x64RAX) // exponent digit count
	b.movRegImm64(x64R11, 400)
	exponentLoop := len(b.code)
	b.movzxRegByteMem(x64RDX, x64RSI)
	b.cmpRegImm8(x64RDX, '0')
	exponentBelow := b.jccRel32(0x2)
	b.cmpRegImm8(x64RDX, '9')
	exponentAbove := b.jccRel32(0x7)
	b.subRegImm8(x64RDX, '0')
	b.cmpRegReg(x64R10, x64R11)
	exponentAtCap := b.jccRel32(0x3) // JAE
	b.imulRegImm8(x64R10, x64R10, 10)
	b.binaryRegReg(0x01, x64R10, x64RDX)
	b.cmpRegReg(x64R10, x64R11)
	exponentWithinCap := b.jccRel32(0x6) // JBE
	b.movRegImm64(x64R10, 400)
	exponentAccumDone := len(b.code)
	patchX64Rel32(b.code, exponentAtCap, exponentAccumDone)
	patchX64Rel32(b.code, exponentWithinCap, exponentAccumDone)
	b.addRegImm8(x64RSI, 1)
	b.addRegImm8(x64RAX, 1)
	exponentBack := b.jmpRel32()
	patchX64Rel32(b.code, exponentBack, exponentLoop)

	exponentDone := len(b.code)
	patchX64Rel32(b.code, exponentBelow, exponentDone)
	patchX64Rel32(b.code, exponentAbove, exponentDone)
	b.testRegReg(x64RAX, x64RAX)
	failures = append(failures, b.jccRel32(0x4)) // exponent marker without digits
	b.testRegReg(x64R10, x64R10)
	zeroExponent := b.jccRel32(0x4)
	exponentApplyLoop := len(b.code)
	b.testRegReg(x64R8, x64R8)
	exponentPositive := b.jccRel32(0x4)
	b.scalarSDRegReg(0x5e, 0, 1) // DIVSD result,10
	exponentApplied := b.jmpRel32()
	exponentMultiply := len(b.code)
	patchX64Rel32(b.code, exponentPositive, exponentMultiply)
	b.scalarSDRegReg(0x59, 0, 1) // MULSD result,10
	exponentStepDone := len(b.code)
	patchX64Rel32(b.code, exponentApplied, exponentStepDone)
	b.subRegImm8(x64R10, 1)
	b.testRegReg(x64R10, x64R10)
	exponentAgain := b.jccRel32(0x5)
	patchX64Rel32(b.code, exponentAgain, exponentApplyLoop)
	afterExponent := len(b.code)
	patchX64Rel32(b.code, zeroExponent, afterExponent)
	afterExponentJump := b.jmpRel32()

	withoutExponent := len(b.code)
	patchX64Rel32(b.code, noExponent, withoutExponent)
	delimiterStart := len(b.code)
	patchX64Rel32(b.code, afterExponentJump, delimiterStart)
	failures = append(failures, emitX64RequireCurrentDelimiter(b, allowWhitespaceDelimiter)...)

	b.testRegReg(x64RBX, x64RBX)
	nonNegative := b.jccRel32(0x4)
	b.movqRegXMM(x64RDX, 0)
	b.movRegImm64(x64R10, 0x8000000000000000)
	b.binaryRegReg(0x31, x64RDX, x64R10)
	b.movqXMMReg(0, x64RDX)
	patchX64Rel32(b.code, nonNegative, len(b.code))
	b.movqRegXMM(x64RAX, 0)
	return failures
}

func emitX64RequireCurrentDelimiter(b *x64MachineBuilder, allowWhitespaceDelimiter bool) []int {
	b.movzxRegByteMem(x64RDX, x64RSI)
	b.testRegReg(x64RDX, x64RDX)
	validNUL := b.jccRel32(0x4)
	validWhitespace := make([]int, 0, 2)
	if allowWhitespaceDelimiter {
		b.cmpRegImm8(x64RDX, ' ')
		validWhitespace = append(validWhitespace, b.jccRel32(0x4))
		b.cmpRegImm8(x64RDX, '\t')
		validWhitespace = append(validWhitespace, b.jccRel32(0x4))
	}
	failure := b.jmpRel32()
	valid := len(b.code)
	patchX64Rel32(b.code, validNUL, valid)
	for _, pos := range validWhitespace {
		patchX64Rel32(b.code, pos, valid)
	}
	return []int{failure}
}

func emitX64ParseIntegerArg(b *x64MachineBuilder, t Type, allowWhitespaceDelimiter bool) []int {
	failures := make([]int, 0, 10)
	b.xorRegReg(x64RBX, x64RBX) // sign flag
	if t == I64 {
		b.movzxRegByteMem(x64RDX, x64RSI)
		b.cmpRegImm8(x64RDX, '-')
		notNegative := b.jccRel32(0x5) // JNE
		b.movRegImm64(x64RBX, 1)
		b.addRegImm8(x64RSI, 1)
		patchX64Rel32(b.code, notNegative, len(b.code))
	}

	b.xorRegReg(x64RAX, x64RAX)
	b.xorRegReg(x64R9, x64R9) // digit count
	if t == U64 {
		b.movRegImm64(x64R10, 1844674407370955161)
		b.movRegImm64(x64R11, 5)
	} else {
		b.movRegImm64(x64R10, 922337203685477580)
		b.movRegImm64(x64R11, 7)
		b.testRegReg(x64RBX, x64RBX)
		positive := b.jccRel32(0x4) // JE
		b.movRegImm64(x64R11, 8)
		patchX64Rel32(b.code, positive, len(b.code))
	}

	loop := len(b.code)
	b.movzxRegByteMem(x64RDX, x64RSI)
	b.testRegReg(x64RDX, x64RDX)
	doneNUL := b.jccRel32(0x4)
	doneWhitespace := make([]int, 0, 2)
	if allowWhitespaceDelimiter {
		b.cmpRegImm8(x64RDX, ' ')
		doneWhitespace = append(doneWhitespace, b.jccRel32(0x4))
		b.cmpRegImm8(x64RDX, '\t')
		doneWhitespace = append(doneWhitespace, b.jccRel32(0x4))
	}
	b.cmpRegImm8(x64RDX, '0')
	failures = append(failures, b.jccRel32(0x2)) // JB
	b.cmpRegImm8(x64RDX, '9')
	failures = append(failures, b.jccRel32(0x7)) // JA
	b.subRegImm8(x64RDX, '0')
	b.cmpRegReg(x64RAX, x64R10)
	failures = append(failures, b.jccRel32(0x7)) // JA
	belowThreshold := b.jccRel32(0x2)            // JB
	b.cmpRegReg(x64RDX, x64R11)
	failures = append(failures, b.jccRel32(0x7)) // JA
	patchX64Rel32(b.code, belowThreshold, len(b.code))
	b.imulRegImm8(x64RAX, x64RAX, 10)
	b.binaryRegReg(0x01, x64RAX, x64RDX)
	b.addRegImm8(x64RSI, 1)
	b.addRegImm8(x64R9, 1)
	back := b.jmpRel32()
	patchX64Rel32(b.code, back, loop)

	done := len(b.code)
	patchX64Rel32(b.code, doneNUL, done)
	for _, pos := range doneWhitespace {
		patchX64Rel32(b.code, pos, done)
	}
	b.testRegReg(x64R9, x64R9)
	failures = append(failures, b.jccRel32(0x4)) // no digits
	if t == I64 {
		b.testRegReg(x64RBX, x64RBX)
		positive := b.jccRel32(0x4)
		b.neg(x64RAX)
		patchX64Rel32(b.code, positive, len(b.code))
	}
	return failures
}

func emitX64ParseBoolArg(b *x64MachineBuilder, allowWhitespaceDelimiter bool) []int {
	failures := make([]int, 0, 12)
	b.movzxRegByteMem(x64RDX, x64RSI)
	b.cmpRegImm8(x64RDX, '0')
	isZero := b.jccRel32(0x4)
	b.cmpRegImm8(x64RDX, '1')
	isOne := b.jccRel32(0x4)
	b.cmpRegImm8(x64RDX, 't')
	isTrue := b.jccRel32(0x4)
	b.cmpRegImm8(x64RDX, 'f')
	isFalse := b.jccRel32(0x4)
	failures = append(failures, b.jmpRel32())

	zeroLabel := len(b.code)
	patchX64Rel32(b.code, isZero, zeroLabel)
	b.xorRegReg(x64RAX, x64RAX)
	b.addRegImm8(x64RSI, 1)
	zeroDone := b.jmpRel32()

	oneLabel := len(b.code)
	patchX64Rel32(b.code, isOne, oneLabel)
	b.movRegImm64(x64RAX, 1)
	b.addRegImm8(x64RSI, 1)
	oneDone := b.jmpRel32()

	trueLabel := len(b.code)
	patchX64Rel32(b.code, isTrue, trueLabel)
	b.addRegImm8(x64RSI, 1)
	for _, ch := range []byte{'r', 'u', 'e'} {
		b.movzxRegByteMem(x64RDX, x64RSI)
		b.cmpRegImm8(x64RDX, ch)
		failures = append(failures, b.jccRel32(0x5))
		b.addRegImm8(x64RSI, 1)
	}
	b.movRegImm64(x64RAX, 1)
	trueDone := b.jmpRel32()

	falseLabel := len(b.code)
	patchX64Rel32(b.code, isFalse, falseLabel)
	b.addRegImm8(x64RSI, 1)
	for _, ch := range []byte{'a', 'l', 's', 'e'} {
		b.movzxRegByteMem(x64RDX, x64RSI)
		b.cmpRegImm8(x64RDX, ch)
		failures = append(failures, b.jccRel32(0x5))
		b.addRegImm8(x64RSI, 1)
	}
	b.xorRegReg(x64RAX, x64RAX)

	delimiterCheck := len(b.code)
	for _, pos := range []int{zeroDone, oneDone, trueDone} {
		patchX64Rel32(b.code, pos, delimiterCheck)
	}
	b.movzxRegByteMem(x64RDX, x64RSI)
	b.testRegReg(x64RDX, x64RDX)
	validNUL := b.jccRel32(0x4)
	validWhitespace := make([]int, 0, 2)
	if allowWhitespaceDelimiter {
		b.cmpRegImm8(x64RDX, ' ')
		validWhitespace = append(validWhitespace, b.jccRel32(0x4))
		b.cmpRegImm8(x64RDX, '\t')
		validWhitespace = append(validWhitespace, b.jccRel32(0x4))
	}
	failures = append(failures, b.jmpRel32())
	valid := len(b.code)
	patchX64Rel32(b.code, validNUL, valid)
	for _, pos := range validWhitespace {
		patchX64Rel32(b.code, pos, valid)
	}
	return failures
}

func emitX64SkipCommandWhitespace(b *x64MachineBuilder) {
	loop := len(b.code)
	b.movzxRegByteMem(x64RDX, x64RSI)
	b.cmpRegImm8(x64RDX, ' ')
	isSpace := b.jccRel32(0x4)
	b.cmpRegImm8(x64RDX, '\t')
	notTab := b.jccRel32(0x5)
	patchX64Rel32(b.code, isSpace, len(b.code))
	b.addRegImm8(x64RSI, 1)
	back := b.jmpRel32()
	patchX64Rel32(b.code, back, loop)
	patchX64Rel32(b.code, notTab, len(b.code))
}

// emitX64SkipWindowsProgramName advances RSI from the beginning of an ANSI
// GetCommandLineA string to the first program argument. The executable path may
// be quoted; program arguments themselves are intentionally restricted to
// unquoted scalar tokens by the direct-executable ABI.
func emitX64SkipWindowsProgramName(b *x64MachineBuilder) []int {
	failures := make([]int, 0, 2)
	emitX64SkipCommandWhitespace(b)
	b.movzxRegByteMem(x64RDX, x64RSI)
	b.testRegReg(x64RDX, x64RDX)
	failures = append(failures, b.jccRel32(0x4)) // empty command line
	b.cmpRegImm8(x64RDX, '"')
	unquoted := b.jccRel32(0x5) // JNE

	// Quoted executable path.
	b.addRegImm8(x64RSI, 1)
	quotedLoop := len(b.code)
	b.movzxRegByteMem(x64RDX, x64RSI)
	b.testRegReg(x64RDX, x64RDX)
	failures = append(failures, b.jccRel32(0x4)) // unterminated quote
	b.cmpRegImm8(x64RDX, '"')
	quotedDone := b.jccRel32(0x4)
	b.addRegImm8(x64RSI, 1)
	backQuoted := b.jmpRel32()
	patchX64Rel32(b.code, backQuoted, quotedLoop)
	quotedEnd := len(b.code)
	patchX64Rel32(b.code, quotedDone, quotedEnd)
	b.addRegImm8(x64RSI, 1)
	quotedAfter := b.jmpRel32()

	// Unquoted executable path.
	unquotedLabel := len(b.code)
	patchX64Rel32(b.code, unquoted, unquotedLabel)
	unquotedLoop := len(b.code)
	b.movzxRegByteMem(x64RDX, x64RSI)
	b.testRegReg(x64RDX, x64RDX)
	unquotedDoneNUL := b.jccRel32(0x4)
	b.cmpRegImm8(x64RDX, ' ')
	unquotedDoneSpace := b.jccRel32(0x4)
	b.cmpRegImm8(x64RDX, '\t')
	unquotedDoneTab := b.jccRel32(0x4)
	b.addRegImm8(x64RSI, 1)
	backUnquoted := b.jmpRel32()
	patchX64Rel32(b.code, backUnquoted, unquotedLoop)

	afterName := len(b.code)
	patchX64Rel32(b.code, quotedAfter, afterName)
	for _, pos := range []int{unquotedDoneNUL, unquotedDoneSpace, unquotedDoneTab} {
		patchX64Rel32(b.code, pos, afterName)
	}
	emitX64SkipCommandWhitespace(b)
	return failures
}

func emitX64StageWin64ExecutableArgs(b *x64MachineBuilder, f SSAFunction) {
	for i, value := range f.Params {
		if f.ValueTypes[value] == IEEE64 {
			b.movsdXMMMemDisp32(i, x64RSP, int32(x64ExeArgBaseOffset+i*8))
		} else {
			b.movRegMemDisp32(x64WinArgRegs[i], x64RSP, int32(x64ExeArgBaseOffset+i*8))
		}
	}
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, x64ExeStatusOffset, x64R10)
	if len(f.Params) < 4 {
		statusReg := x64WinArgRegs[len(f.Params)]
		b.movRegReg(statusReg, x64RSP)
		b.addRegImm32(statusReg, x64ExeStatusOffset)
	} else {
		b.movRegReg(x64R10, x64RSP)
		b.addRegImm32(x64R10, x64ExeStatusOffset)
		b.movMemDisp32Reg(x64RSP, 32, x64R10)
	}
}
