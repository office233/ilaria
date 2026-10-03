package coreir

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/bits"
)

// RunTurbo executes the same successful value semantics as RunFast but stores
// prepared scalar slots as raw 64-bit words. Core scalar types are statically
// known, so a boxed Value per slot is unnecessary on the hot path.
//
// Verification and exact-fuel claims must continue to use Run.
func (e *Executable) RunTurbo(ctx context.Context, entry string, args []Value, fuel int) (RunResult, error) {
	if ctx == nil || fuel < 1 || fuel > MaxFuel {
		return RunResult{}, diagnostic("invalid_budget", "context and fuel 1..1000000 required")
	}
	if e == nil {
		return RunResult{}, diagnostic("invalid_ir", "nil executable")
	}
	f, ok := e.functions[entry]
	if !ok {
		return RunResult{}, diagnostic("unknown_function", entry)
	}
	if semanticsForFunction(f.Function).Purity != "pure" {
		return RunResult{}, diagnostic("effectful_program", "Core executor does not execute host effects; submit an EffectRequest to the SwypikOS capability broker")
	}
	if len(args) != len(f.Params) {
		return RunResult{}, diagnostic("arity", "incorrect entry argument count")
	}
	var small [16]uint64
	rawArgs := small[:len(args)]
	for i, arg := range args {
		if arg.typ != f.Params[i].Type {
			return RunResult{}, diagnostic("type_mismatch", fmt.Sprintf("entry argument %d requires %s", i, f.Params[i].Type))
		}
		rawArgs[i] = valueToRaw(arg)
	}
	m := machine{executable: e, ctx: ctx, limit: fuel, fast: true}
	raw, err := m.callTurbo(entry, rawArgs, 1)
	return RunResult{Value: rawToValue(f.Result, raw), Steps: m.used, data: m.byteData()}, err
}

func valueToRaw(v Value) uint64 {
	switch v.typ {
	case I64:
		return uint64(v.i)
	case U64:
		return v.u
	case F64, IEEE64:
		return math.Float64bits(v.f)
	case Bool:
		if v.b {
			return 1
		}
		return 0
	case Bytes:
		return v.u
	default:
		return 0
	}
}

func rawToValue(t Type, raw uint64) Value {
	switch t {
	case I64:
		return Int(int64(raw))
	case U64:
		return Uint(raw)
	case F64:
		return Value{typ: F64, f: math.Float64frombits(raw)}
	case IEEE64:
		return Value{typ: IEEE64, f: math.Float64frombits(raw)}
	case Bool:
		return Boolean(raw != 0)
	case Bytes:
		return Value{typ: Bytes, u: raw}
	case Void:
		return Value{typ: Void}
	default:
		return Value{}
	}
}

// MaxCallDepth is the maximum call stack depth before execution traps with call_depth.
const MaxCallDepth = 128

func (m *machine) callTurbo(name string, args []uint64, depth int) (uint64, error) {
	if depth > MaxCallDepth {
		return 0, diagnostic("call_depth", fmt.Sprintf("call depth exceeds %d", MaxCallDepth))
	}
	if err := m.tick(Location{}); err != nil {
		return 0, err
	}
	f := m.executable.functions[name]
	const rawStackSlotLimit = 128
	var localSlots [rawStackSlotLimit]uint64
	var slots []uint64
	if len(f.Slots) <= rawStackSlotLimit {
		slots = localSlots[:len(f.Slots)]
	} else {
		slots = make([]uint64, len(f.Slots))
	}
	copy(slots, args)
	block := 0
	for {
		for _, ins := range f.turboBlocks[block] {
			value, err := m.executeTurboInstruction(ins, f, slots, depth)
			if err != nil {
				var d *Diagnostic
				if errors.As(err, &d) && d.Location.Line == 0 {
					copy := *d
					copy.Location = turboInstructionLocation(f, ins)
					err = &copy
				}
				return 0, err
			}
			if ins.dest >= 0 {
				slots[int(ins.dest)] = value
			}
		}
		t := f.turboTerminators[block]
		switch t.kind {
		case fastReturn:
			if t.value < 0 {
				return 0, nil
			}
			return slots[int(t.value)], nil
		case fastJump:
			target := int(t.target0)
			if target <= block {
				if err := m.tick(turboTerminatorLocation(f, t)); err != nil {
					return 0, err
				}
			}
			block = target
		case fastBranch:
			target := int(t.target1)
			if slots[int(t.value)] != 0 {
				target = int(t.target0)
			}
			if target <= block {
				if err := m.tick(turboTerminatorLocation(f, t)); err != nil {
					return 0, err
				}
			}
			block = target
		case fastUnreachable:
			return 0, &Diagnostic{Code: "unreachable", Message: "unreachable terminator executed", Location: turboTerminatorLocation(f, t)}
		}
	}
}

func (m *machine) executeTurboInstruction(ins turboInstruction, f executableFunction, slots []uint64, depth int) (uint64, error) {
	switch ins.kind {
	case fastConst:
		return ins.constant, nil
	case fastMove:
		return slots[int(ins.a)], nil
	case fastCall:
		extra, err := turboInstructionExtra(f, ins)
		if err != nil {
			return 0, err
		}
		var small [16]uint64
		inputs := small[:len(extra.args)]
		for i, slot := range extra.args {
			inputs[i] = slots[int(slot)]
		}
		return m.callTurbo(extra.callee, inputs, depth+1)
	case fastBytesLen:
		return m.bytesLenRaw(slots[int(ins.a)])
	case fastBytesGet:
		return m.bytesGetRaw(slots[int(ins.a)], slots[int(ins.b)])
	case fastBytesFromStorageU64:
		value, err := m.bytesFromStorageU64(Uint(slots[int(ins.a)]), Uint(slots[int(ins.b)]))
		return value.u, err
	case fastStorageAllocU64:
		value, err := m.storageAllocU64(Uint(slots[int(ins.a)]))
		if err != nil {
			return 0, err
		}
		return value.u, nil
	case fastStorageLoadU64:
		value, err := m.storageLoadU64(Uint(slots[int(ins.a)]), Uint(slots[int(ins.b)]))
		if err != nil {
			return 0, err
		}
		return value.u, nil
	case fastStorageStoreU64:
		extra, err := turboInstructionExtra(f, ins)
		if err != nil {
			return 0, err
		}
		if len(extra.args) != 3 {
			return 0, diagnostic("invalid_ir", "storage.store_u64 turbo arity")
		}
		if err := m.storageStoreU64(Uint(slots[int(extra.args[0])]), Uint(slots[int(extra.args[1])]), Uint(slots[int(extra.args[2])])); err != nil {
			return 0, err
		}
		return 0, nil
	case fastStorageFree:
		if err := m.storageFree(Uint(slots[int(ins.a)])); err != nil {
			return 0, err
		}
		return 0, nil
	case fastStorageLenU64:
		value, err := m.storageLenU64(Uint(slots[int(ins.a)]))
		if err != nil {
			return 0, err
		}
		return value.u, nil
	case fastStorageCapacityU64:
		value, err := m.storageCapacityU64(Uint(slots[int(ins.a)]))
		if err != nil {
			return 0, err
		}
		return value.u, nil
	case fastStorageSetLenU64:
		if err := m.storageSetLenU64(Uint(slots[int(ins.a)]), Uint(slots[int(ins.b)])); err != nil {
			return 0, err
		}
		return 0, nil
	default:
		a := int(ins.a)
		x := slots[a]
		var y uint64
		var typeB Type
		hasY := ins.b >= 0
		if hasY {
			bi := int(ins.b)
			y = slots[bi]
			typeB = f.Slots[bi]
		}
		rawOp := ""
		if ins.extra != turboNoExtra {
			extra, err := turboInstructionExtra(f, ins)
			if err != nil {
				return 0, err
			}
			rawOp = extra.rawOp
		}
		return applyTurboValue(ins.op, rawOp, x, y, hasY, f.Slots[a], typeB)
	}
}

func turboInstructionExtra(f executableFunction, ins turboInstruction) (turboExtra, error) {
	if ins.extra == turboNoExtra || int(ins.extra) >= len(f.turboExtras) {
		return turboExtra{}, diagnostic("invalid_ir", "turbo bytecode extra index out of range")
	}
	return f.turboExtras[ins.extra], nil
}

func turboInstructionLocation(f executableFunction, ins turboInstruction) Location {
	if int(ins.location) >= len(f.turboLocations) {
		return Location{}
	}
	return f.turboLocations[ins.location]
}

func turboTerminatorLocation(f executableFunction, term turboTerminator) Location {
	if int(term.location) >= len(f.turboLocations) {
		return Location{}
	}
	return f.turboLocations[term.location]
}

func applyTurboValue(op fastValueOp, rawOp string, x, y uint64, hasY bool, typeA, typeB Type) (uint64, error) {
	boolRaw := func(v bool) uint64 {
		if v {
			return 1
		}
		return 0
	}
	switch op {
	case fastNot:
		return boolRaw(x == 0), nil
	case fastI64Neg:
		a := int64(x)
		if a == minI64 {
			return 0, diagnostic("overflow", "i64 negation overflow")
		}
		return uint64(-a), nil
	case fastU64Neg:
		return 0 - x, nil
	case fastF64Neg, fastIEEE64Neg:
		return math.Float64bits(-math.Float64frombits(x)), nil
	case fastI64Add:
		a, b := int64(x), int64(y)
		if (b > 0 && a > maxI64-b) || (b < 0 && a < minI64-b) {
			return 0, diagnostic("overflow", "i64 add overflow")
		}
		return uint64(a + b), nil
	case fastI64Sub:
		a, b := int64(x), int64(y)
		if (b > 0 && a < minI64+b) || (b < 0 && a > maxI64+b) {
			return 0, diagnostic("overflow", "i64 sub overflow")
		}
		return uint64(a - b), nil
	case fastI64Mul:
		return turboI64Multiply(int64(x), int64(y))
	case fastI64Div:
		return turboI64Divide(int64(x), int64(y), false)
	case fastI64Rem:
		return turboI64Divide(int64(x), int64(y), true)
	case fastU64Add:
		return x + y, nil
	case fastU64Sub:
		return x - y, nil
	case fastU64Mul:
		return x * y, nil
	case fastU64Div:
		if y == 0 {
			return 0, diagnostic("division_by_zero", "zero divisor")
		}
		return x / y, nil
	case fastU64Rem:
		if y == 0 {
			return 0, diagnostic("division_by_zero", "zero divisor")
		}
		return x % y, nil
	case fastU64And:
		return x & y, nil
	case fastU64Or:
		return x | y, nil
	case fastU64Xor:
		return x ^ y, nil
	case fastU64Shl:
		if y >= 64 {
			return 0, diagnostic("shift_out_of_range", "u64 shift count must be below 64")
		}
		return x << y, nil
	case fastU64Shr:
		if y >= 64 {
			return 0, diagnostic("shift_out_of_range", "u64 shift count must be below 64")
		}
		return x >> y, nil
	case fastF64Add:
		return turboFiniteFloat(math.Float64frombits(x) + math.Float64frombits(y))
	case fastF64Sub:
		return turboFiniteFloat(math.Float64frombits(x) - math.Float64frombits(y))
	case fastF64Mul:
		return turboFiniteFloat(math.Float64frombits(x) * math.Float64frombits(y))
	case fastF64Div:
		b := math.Float64frombits(y)
		if b == 0 {
			return 0, diagnostic("division_by_zero", "zero divisor")
		}
		return turboFiniteFloat(math.Float64frombits(x) / b)
	case fastF64Rem:
		b := math.Float64frombits(y)
		if b == 0 {
			return 0, diagnostic("division_by_zero", "zero divisor")
		}
		return turboFiniteFloat(math.Mod(math.Float64frombits(x), b))
	case fastIEEE64Add:
		return math.Float64bits(math.Float64frombits(x) + math.Float64frombits(y)), nil
	case fastIEEE64Sub:
		return math.Float64bits(math.Float64frombits(x) - math.Float64frombits(y)), nil
	case fastIEEE64Mul:
		return math.Float64bits(math.Float64frombits(x) * math.Float64frombits(y)), nil
	case fastIEEE64Div:
		return math.Float64bits(math.Float64frombits(x) / math.Float64frombits(y)), nil
	case fastIEEE64Rem:
		return math.Float64bits(math.Mod(math.Float64frombits(x), math.Float64frombits(y))), nil
	case fastI64LT:
		return boolRaw(int64(x) < int64(y)), nil
	case fastI64LE:
		return boolRaw(int64(x) <= int64(y)), nil
	case fastI64GT:
		return boolRaw(int64(x) > int64(y)), nil
	case fastI64GE:
		return boolRaw(int64(x) >= int64(y)), nil
	case fastU64LT:
		return boolRaw(x < y), nil
	case fastU64LE:
		return boolRaw(x <= y), nil
	case fastU64GT:
		return boolRaw(x > y), nil
	case fastU64GE:
		return boolRaw(x >= y), nil
	case fastF64LT, fastIEEE64LT:
		return boolRaw(math.Float64frombits(x) < math.Float64frombits(y)), nil
	case fastF64LE, fastIEEE64LE:
		return boolRaw(math.Float64frombits(x) <= math.Float64frombits(y)), nil
	case fastF64GT, fastIEEE64GT:
		return boolRaw(math.Float64frombits(x) > math.Float64frombits(y)), nil
	case fastF64GE, fastIEEE64GE:
		return boolRaw(math.Float64frombits(x) >= math.Float64frombits(y)), nil
	case fastI64EQ, fastU64EQ, fastBoolEQ:
		return boolRaw(x == y), nil
	case fastI64NE, fastU64NE, fastBoolNE:
		return boolRaw(x != y), nil
	case fastF64EQ, fastIEEE64EQ:
		return boolRaw(math.Float64frombits(x) == math.Float64frombits(y)), nil
	case fastF64NE, fastIEEE64NE:
		return boolRaw(math.Float64frombits(x) != math.Float64frombits(y)), nil
	}

	if (rawOp == "eq" || rawOp == "ne") && hasY && typeA == typeB {
		var equal bool
		switch typeA {
		case F64, IEEE64:
			equal = math.Float64frombits(x) == math.Float64frombits(y)
		default:
			equal = x == y
		}
		if rawOp == "ne" {
			equal = !equal
		}
		return boolRaw(equal), nil
	}
	xv := rawToValue(typeA, x)
	if hasY {
		yv := rawToValue(typeB, y)
		v, err := Apply(rawOp, xv, yv)
		return valueToRaw(v), err
	}
	v, err := Apply(rawOp, xv)
	return valueToRaw(v), err
}

func turboFiniteFloat(v float64) (uint64, error) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, diagnostic("non_finite", "non-finite f64 result")
	}
	return math.Float64bits(v), nil
}

func turboI64Multiply(a, b int64) (uint64, error) {
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
		return 0, diagnostic("overflow", "i64 mul overflow")
	}
	if negative {
		if lo == 1<<63 {
			return uint64(1) << 63, nil
		}
		return uint64(-int64(lo)), nil
	}
	return lo, nil
}

func turboI64Divide(a, b int64, remainder bool) (uint64, error) {
	if b == 0 {
		return 0, diagnostic("division_by_zero", "zero divisor")
	}
	if a == minI64 && b == -1 {
		if remainder {
			return 0, nil
		}
		return 0, diagnostic("overflow", "i64 div overflow")
	}
	if remainder {
		return uint64(a % b), nil
	}
	return uint64(a / b), nil
}
