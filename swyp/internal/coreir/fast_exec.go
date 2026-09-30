package coreir

import (
	"math"
	"math/bits"
)

type fastInstructionKind uint8

const (
	fastValue fastInstructionKind = iota
	fastConst
	fastMove
	fastCall
	fastBytesLen
	fastBytesGet
)

type fastValueOp uint8

const (
	fastFallback fastValueOp = iota
	fastNot
	fastI64Neg
	fastU64Neg
	fastF64Neg
	fastIEEE64Neg
	fastI64Add
	fastI64Sub
	fastI64Mul
	fastI64Div
	fastI64Rem
	fastU64Add
	fastU64Sub
	fastU64Mul
	fastU64Div
	fastU64Rem
	fastU64And
	fastU64Or
	fastU64Xor
	fastU64Shl
	fastU64Shr
	fastF64Add
	fastF64Sub
	fastF64Mul
	fastF64Div
	fastF64Rem
	fastIEEE64Add
	fastIEEE64Sub
	fastIEEE64Mul
	fastIEEE64Div
	fastIEEE64Rem
	fastI64LT
	fastI64LE
	fastI64GT
	fastI64GE
	fastU64LT
	fastU64LE
	fastU64GT
	fastU64GE
	fastF64LT
	fastF64LE
	fastF64GT
	fastF64GE
	fastIEEE64LT
	fastIEEE64LE
	fastIEEE64GT
	fastIEEE64GE
	fastI64EQ
	fastI64NE
	fastU64EQ
	fastU64NE
	fastBoolEQ
	fastBoolNE
	fastF64EQ
	fastF64NE
	fastIEEE64EQ
	fastIEEE64NE
)

type fastInstruction struct {
	kind     fastInstructionKind
	op       fastValueOp
	rawOp    string
	dest     int
	a        int
	b        int
	constant Value
	callee   string
	args     []int
	location Location
}

type fastTerminatorKind uint8

const (
	fastReturn fastTerminatorKind = iota
	fastJump
	fastBranch
	fastUnreachable
)

type fastTerminator struct {
	kind     fastTerminatorKind
	value    int
	target0  int
	target1  int
	location Location
}

func prepareFastTerminators(f Function) []fastTerminator {
	out := make([]fastTerminator, len(f.Blocks))
	for bi, block := range f.Blocks {
		t := block.Terminator
		ft := fastTerminator{
			value:    t.Value,
			target0:  -1,
			target1:  -1,
			location: t.Location,
		}
		switch t.Op {
		case "return":
			ft.kind = fastReturn
		case "jump":
			ft.kind = fastJump
			ft.target0 = t.Targets[0]
		case "branch":
			ft.kind = fastBranch
			ft.target0 = t.Targets[0]
			ft.target1 = t.Targets[1]
		case "unreachable":
			ft.kind = fastUnreachable
		}
		out[bi] = ft
	}
	return out
}

func prepareFastBlocks(f Function, constants [][]Value) [][]fastInstruction {
	out := make([][]fastInstruction, len(f.Blocks))
	for bi, block := range f.Blocks {
		out[bi] = make([]fastInstruction, len(block.Instructions))
		for ii, ins := range block.Instructions {
			fi := fastInstruction{
				kind:     fastValue,
				op:       fastValueOpFor(f, ins),
				rawOp:    ins.Op,
				dest:     ins.Dest,
				a:        -1,
				b:        -1,
				callee:   ins.Callee,
				args:     ins.Args,
				location: ins.Location,
			}
			switch ins.Op {
			case "const":
				fi.kind = fastConst
				fi.constant = constants[bi][ii]
			case "move":
				fi.kind = fastMove
				fi.a = ins.Args[0]
			case "call":
				fi.kind = fastCall
			case "bytes.len":
				fi.kind = fastBytesLen
				fi.a = ins.Args[0]
			case "bytes.get":
				fi.kind = fastBytesGet
				fi.a = ins.Args[0]
				fi.b = ins.Args[1]
			default:
				if len(ins.Args) > 0 {
					fi.a = ins.Args[0]
				}
				if len(ins.Args) > 1 {
					fi.b = ins.Args[1]
				}
			}
			out[bi][ii] = fi
		}
	}
	return out
}

func fastValueOpFor(f Function, ins Instruction) fastValueOp {
	if ins.Op == "not" && len(ins.Args) == 1 {
		return fastNot
	}
	if ins.Op == "neg" && len(ins.Args) == 1 {
		switch f.Slots[ins.Args[0]] {
		case I64:
			return fastI64Neg
		case U64:
			return fastU64Neg
		case F64:
			return fastF64Neg
		case IEEE64:
			return fastIEEE64Neg
		}
	}
	if len(ins.Args) != 2 {
		return fastFallback
	}
	if (ins.Op == "eq" || ins.Op == "ne") && f.Slots[ins.Args[0]] != f.Slots[ins.Args[1]] {
		// Core deliberately defines cross-type equality instead of rejecting it:
		// eq=false and ne=true. Keep that case on the semantic fallback path.
		return fastFallback
	}
	t := f.Slots[ins.Args[0]]
	switch t {
	case I64:
		switch ins.Op {
		case "add":
			return fastI64Add
		case "sub":
			return fastI64Sub
		case "mul":
			return fastI64Mul
		case "div":
			return fastI64Div
		case "rem":
			return fastI64Rem
		case "lt":
			return fastI64LT
		case "le":
			return fastI64LE
		case "gt":
			return fastI64GT
		case "ge":
			return fastI64GE
		case "eq":
			return fastI64EQ
		case "ne":
			return fastI64NE
		}
	case U64:
		switch ins.Op {
		case "add":
			return fastU64Add
		case "sub":
			return fastU64Sub
		case "mul":
			return fastU64Mul
		case "div":
			return fastU64Div
		case "rem":
			return fastU64Rem
		case "band":
			return fastU64And
		case "bor":
			return fastU64Or
		case "bxor":
			return fastU64Xor
		case "shl":
			return fastU64Shl
		case "shr":
			return fastU64Shr
		case "lt":
			return fastU64LT
		case "le":
			return fastU64LE
		case "gt":
			return fastU64GT
		case "ge":
			return fastU64GE
		case "eq":
			return fastU64EQ
		case "ne":
			return fastU64NE
		}
	case F64:
		switch ins.Op {
		case "add":
			return fastF64Add
		case "sub":
			return fastF64Sub
		case "mul":
			return fastF64Mul
		case "div":
			return fastF64Div
		case "rem":
			return fastF64Rem
		case "lt":
			return fastF64LT
		case "le":
			return fastF64LE
		case "gt":
			return fastF64GT
		case "ge":
			return fastF64GE
		case "eq":
			return fastF64EQ
		case "ne":
			return fastF64NE
		}
	case IEEE64:
		switch ins.Op {
		case "add":
			return fastIEEE64Add
		case "sub":
			return fastIEEE64Sub
		case "mul":
			return fastIEEE64Mul
		case "div":
			return fastIEEE64Div
		case "rem":
			return fastIEEE64Rem
		case "lt":
			return fastIEEE64LT
		case "le":
			return fastIEEE64LE
		case "gt":
			return fastIEEE64GT
		case "ge":
			return fastIEEE64GE
		case "eq":
			return fastIEEE64EQ
		case "ne":
			return fastIEEE64NE
		}
	case Bool:
		switch ins.Op {
		case "eq":
			return fastBoolEQ
		case "ne":
			return fastBoolNE
		}
	}
	return fastFallback
}

func applyFastValue(op fastValueOp, raw string, x, y Value, hasY bool) (Value, error) {
	switch op {
	case fastNot:
		return Boolean(!x.b), nil
	case fastI64Neg:
		if x.i == minI64 {
			return Value{}, diagnostic("overflow", "i64 negation overflow")
		}
		return Int(-x.i), nil
	case fastU64Neg:
		return Uint(0 - x.u), nil
	case fastF64Neg:
		return Value{typ: F64, f: -x.f}, nil
	case fastIEEE64Neg:
		return Value{typ: IEEE64, f: -x.f}, nil

	case fastI64Add:
		a, b := x.i, y.i
		if (b > 0 && a > maxI64-b) || (b < 0 && a < minI64-b) {
			return Value{}, diagnostic("overflow", "i64 add overflow")
		}
		return Int(a + b), nil
	case fastI64Sub:
		a, b := x.i, y.i
		if (b > 0 && a < minI64+b) || (b < 0 && a > maxI64+b) {
			return Value{}, diagnostic("overflow", "i64 sub overflow")
		}
		return Int(a - b), nil
	case fastI64Mul:
		return fastI64Multiply(x.i, y.i)
	case fastI64Div:
		return fastI64Divide(x.i, y.i, false)
	case fastI64Rem:
		return fastI64Divide(x.i, y.i, true)

	case fastU64Add:
		return Uint(x.u + y.u), nil
	case fastU64Sub:
		return Uint(x.u - y.u), nil
	case fastU64Mul:
		return Uint(x.u * y.u), nil
	case fastU64Div:
		if y.u == 0 {
			return Value{}, diagnostic("division_by_zero", "zero divisor")
		}
		return Uint(x.u / y.u), nil
	case fastU64Rem:
		if y.u == 0 {
			return Value{}, diagnostic("division_by_zero", "zero divisor")
		}
		return Uint(x.u % y.u), nil
	case fastU64And:
		return Uint(x.u & y.u), nil
	case fastU64Or:
		return Uint(x.u | y.u), nil
	case fastU64Xor:
		return Uint(x.u ^ y.u), nil
	case fastU64Shl:
		if y.u >= 64 {
			return Value{}, diagnostic("shift_out_of_range", "u64 shift count must be below 64")
		}
		return Uint(x.u << y.u), nil
	case fastU64Shr:
		if y.u >= 64 {
			return Value{}, diagnostic("shift_out_of_range", "u64 shift count must be below 64")
		}
		return Uint(x.u >> y.u), nil

	case fastF64Add:
		return fastFiniteFloat(x.f + y.f)
	case fastF64Sub:
		return fastFiniteFloat(x.f - y.f)
	case fastF64Mul:
		return fastFiniteFloat(x.f * y.f)
	case fastF64Div:
		if y.f == 0 {
			return Value{}, diagnostic("division_by_zero", "zero divisor")
		}
		return fastFiniteFloat(x.f / y.f)
	case fastF64Rem:
		if y.f == 0 {
			return Value{}, diagnostic("division_by_zero", "zero divisor")
		}
		return fastFiniteFloat(math.Mod(x.f, y.f))

	case fastIEEE64Add:
		return Value{typ: IEEE64, f: x.f + y.f}, nil
	case fastIEEE64Sub:
		return Value{typ: IEEE64, f: x.f - y.f}, nil
	case fastIEEE64Mul:
		return Value{typ: IEEE64, f: x.f * y.f}, nil
	case fastIEEE64Div:
		return Value{typ: IEEE64, f: x.f / y.f}, nil
	case fastIEEE64Rem:
		return Value{typ: IEEE64, f: math.Mod(x.f, y.f)}, nil

	case fastI64LT:
		return Boolean(x.i < y.i), nil
	case fastI64LE:
		return Boolean(x.i <= y.i), nil
	case fastI64GT:
		return Boolean(x.i > y.i), nil
	case fastI64GE:
		return Boolean(x.i >= y.i), nil
	case fastU64LT:
		return Boolean(x.u < y.u), nil
	case fastU64LE:
		return Boolean(x.u <= y.u), nil
	case fastU64GT:
		return Boolean(x.u > y.u), nil
	case fastU64GE:
		return Boolean(x.u >= y.u), nil
	case fastF64LT:
		return Boolean(x.f < y.f), nil
	case fastF64LE:
		return Boolean(x.f <= y.f), nil
	case fastF64GT:
		return Boolean(x.f > y.f), nil
	case fastF64GE:
		return Boolean(x.f >= y.f), nil
	case fastIEEE64LT:
		return Boolean(x.f < y.f), nil
	case fastIEEE64LE:
		return Boolean(x.f <= y.f), nil
	case fastIEEE64GT:
		return Boolean(x.f > y.f), nil
	case fastIEEE64GE:
		return Boolean(x.f >= y.f), nil
	case fastI64EQ:
		return Boolean(x.i == y.i), nil
	case fastI64NE:
		return Boolean(x.i != y.i), nil
	case fastU64EQ:
		return Boolean(x.u == y.u), nil
	case fastU64NE:
		return Boolean(x.u != y.u), nil
	case fastBoolEQ:
		return Boolean(x.b == y.b), nil
	case fastBoolNE:
		return Boolean(x.b != y.b), nil
	case fastF64EQ, fastIEEE64EQ:
		return Boolean(x.f == y.f), nil
	case fastF64NE, fastIEEE64NE:
		return Boolean(x.f != y.f), nil
	}

	if hasY {
		return Apply(raw, x, y)
	}
	return Apply(raw, x)
}

func fastFiniteFloat(v float64) (Value, error) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return Value{}, diagnostic("non_finite", "non-finite f64 result")
	}
	return Value{typ: F64, f: v}, nil
}

func fastI64Multiply(a, b int64) (Value, error) {
	abs := func(v int64) uint64 {
		if v < 0 {
			return uint64(-(v + 1)) + 1
		}
		return uint64(v)
	}
	hi, lo := bits.Mul64(abs(a), abs(b))
	negative := (a < 0) != (b < 0)
	limit := uint64(maxI64)
	if negative {
		limit++
	}
	if hi != 0 || lo > limit {
		return Value{}, diagnostic("overflow", "i64 mul overflow")
	}
	if negative {
		if lo == 1<<63 {
			return Int(minI64), nil
		}
		return Int(-int64(lo)), nil
	}
	return Int(int64(lo)), nil
}

func fastI64Divide(a, b int64, remainder bool) (Value, error) {
	if b == 0 {
		return Value{}, diagnostic("division_by_zero", "zero divisor")
	}
	if a == minI64 && b == -1 {
		if remainder {
			return Int(0), nil
		}
		return Value{}, diagnostic("overflow", "i64 div overflow")
	}
	if remainder {
		return Int(a % b), nil
	}
	return Int(a / b), nil
}

func (m *machine) executeFastInstruction(ins fastInstruction, slots []Value, depth int) (Value, error) {
	switch ins.kind {
	case fastConst:
		return ins.constant, nil
	case fastMove:
		return slots[ins.a], nil
	case fastCall:
		var small [16]Value
		inputs := small[:len(ins.args)]
		for i, slot := range ins.args {
			inputs[i] = slots[slot]
		}
		return m.call(ins.callee, inputs, depth+1)
	case fastBytesLen:
		return m.bytesLenValue(slots[ins.a])
	case fastBytesGet:
		return m.bytesGetValue(slots[ins.a], slots[ins.b])
	default:
		x := slots[ins.a]
		var y Value
		hasY := ins.b >= 0
		if hasY {
			y = slots[ins.b]
		}
		return applyFastValue(ins.op, ins.rawOp, x, y, hasY)
	}
}
