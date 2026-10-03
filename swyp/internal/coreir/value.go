// Package coreir implements the experimental, pure scalar Swyp semantic core.
// It is independent of the source parser and of the STV2 wire format.
package coreir

import (
	"encoding/json"
	"fmt"
	"math"
	"math/bits"
	"strconv"
	"strings"
)

type Type string

const (
	I64    Type  = "i64"
	U64    Type  = "u64"
	F64    Type  = "f64"
	IEEE64 Type  = "ieee64"
	Bool   Type  = "bool"
	Bytes  Type  = "bytes"
	Void   Type  = "void"
	minI64 int64 = -1 << 63
	maxI64 int64 = 1<<63 - 1
	// MaxByteArenaBytes bounds immutable module-owned byte data. Keeping this
	// comfortably below the 1 MiB JSON module limit leaves room for code and the
	// base64 expansion used by encoding/json for []byte.
	MaxByteArenaBytes = 256 << 10
	// MaxProcessRuntimeArenaBytes bounds zero-initialized mutable storage owned by
	// a standalone process image. It is deliberately separate from the immutable
	// module byte arena and is never mapped executable.
	MaxProcessRuntimeArenaBytes     = 1 << 20
	DefaultProcessRuntimeArenaBytes = 64 << 10
	// DefaultNativeStorageArenaBytes is the standalone native storage budget.
	// It shares the RW runtime-data section but is partitioned from process I/O.
	DefaultNativeStorageArenaBytes = 512 << 10
)

func (t Type) scalar() bool   { return t == I64 || t == U64 || t == F64 || t == IEEE64 || t == Bool }
func (t Type) numeric() bool  { return t == I64 || t == U64 || t == F64 || t == IEEE64 }
func (t Type) storable() bool { return t.scalar() || t == Bytes }

type Location struct {
	File   string `json:"file,omitempty"`
	Line   int    `json:"line,omitempty"`
	Column int    `json:"column,omitempty"`
}

type Diagnostic struct {
	Code     string   `json:"code"`
	Message  string   `json:"message"`
	Location Location `json:"location"`
}

func (d *Diagnostic) Error() string {
	if d.Location.Line > 0 {
		return fmt.Sprintf("%s:%d:%d: %s: %s", d.Location.File, d.Location.Line, d.Location.Column, d.Code, d.Message)
	}
	return d.Code + ": " + d.Message
}
func diagnostic(code, message string) *Diagnostic { return &Diagnostic{Code: code, Message: message} }

// Literal uses text, including for integers, so JSON consumers never round i64
// values through JavaScript's binary64 number representation.
type Literal struct {
	Type  Type   `json:"type"`
	Value string `json:"value"`
}

type Value struct {
	typ Type
	i   int64
	u   uint64
	f   float64
	b   bool
}

func Int(v int64) Value    { return Value{typ: I64, i: v} }
func Uint(v uint64) Value  { return Value{typ: U64, u: v} }
func Boolean(v bool) Value { return Value{typ: Bool, b: v} }
func ByteSpan(offset, length uint32) (Value, error) {
	if uint64(offset)+uint64(length) > 1<<32 {
		return Value{}, diagnostic("invalid_bytespan", "byte span offset+length exceeds 32-bit arena")
	}
	return Value{typ: Bytes, u: uint64(offset)<<32 | uint64(length)}, nil
}
func (v Value) Type() Type               { return v.typ }
func (v Value) Int64() (int64, bool)     { return v.i, v.typ == I64 }
func (v Value) Uint64() (uint64, bool)   { return v.u, v.typ == U64 }
func (v Value) Float64() (float64, bool) { return v.f, v.typ == F64 || v.typ == IEEE64 }
func (v Value) Boolean() (bool, bool)    { return v.b, v.typ == Bool }
func (v Value) ByteSpan() (offset, length uint32, ok bool) {
	if v.typ != Bytes {
		return 0, 0, false
	}
	return uint32(v.u >> 32), uint32(v.u), true
}
func (v Value) Literal() Literal {
	s := ""
	switch v.typ {
	case I64:
		s = strconv.FormatInt(v.i, 10)
	case U64:
		s = strconv.FormatUint(v.u, 10)
	case F64, IEEE64:
		s = strconv.FormatFloat(v.f, 'g', -1, 64)
	case Bool:
		s = strconv.FormatBool(v.b)
	case Bytes:
		offset, length, _ := v.ByteSpan()
		s = fmt.Sprintf("%08x:%08x", offset, length)
	}
	return Literal{Type: v.typ, Value: s}
}
func (v Value) MarshalJSON() ([]byte, error) { return json.Marshal(v.Literal()) }

func ParseValue(t Type, s string) (Value, error) {
	switch t {
	case I64:
		x, err := strconv.ParseInt(s, 10, 64)
		if err == nil {
			return Int(x), nil
		}
	case U64:
		x, err := strconv.ParseUint(s, 10, 64)
		if err == nil {
			return Uint(x), nil
		}
	case F64:
		x, err := strconv.ParseFloat(s, 64)
		if err == nil && !math.IsNaN(x) && !math.IsInf(x, 0) {
			return Value{typ: F64, f: x}, nil
		}
	case IEEE64:
		x, err := strconv.ParseFloat(s, 64)
		if err == nil {
			return Value{typ: IEEE64, f: x}, nil
		}
	case Bool:
		if s == "true" || s == "false" {
			return Boolean(s == "true"), nil
		}
	case Bytes:
		parts := strings.Split(s, ":")
		if len(parts) == 2 && len(parts[0]) == 8 && len(parts[1]) == 8 {
			offset, errOffset := strconv.ParseUint(parts[0], 16, 32)
			length, errLength := strconv.ParseUint(parts[1], 16, 32)
			if errOffset == nil && errLength == nil {
				return ByteSpan(uint32(offset), uint32(length))
			}
		}
	}
	if t == F64 {
		return Value{}, diagnostic("invalid_literal", fmt.Sprintf("%q is not a finite %s value", s, t))
	}
	if t == IEEE64 || t == U64 || t == I64 || t == Bool || t == Bytes {
		return Value{}, diagnostic("invalid_literal", fmt.Sprintf("%q is not a valid %s value", s, t))
	}
	return Value{}, diagnostic("invalid_literal", fmt.Sprintf("%q has unsupported type %s", s, t))
}

func resultType(op string, types []Type) (Type, bool, error) {
	bad := func() (Type, bool, error) {
		return "", false, diagnostic("type_mismatch", fmt.Sprintf("invalid operands %v for %s", types, op))
	}
	if op == "neg" && len(types) == 1 && types[0].numeric() {
		return types[0], types[0] == I64, nil
	}
	if op == "not" && len(types) == 1 && types[0] == Bool {
		return Bool, false, nil
	}
	if op == "bitcast_i64_u64" && len(types) == 1 && types[0] == I64 {
		return U64, false, nil
	}
	if op == "bitcast_u64_i64" && len(types) == 1 && types[0] == U64 {
		return I64, false, nil
	}
	if op == "bitcast_ieee64_u64" && len(types) == 1 && types[0] == IEEE64 {
		return U64, false, nil
	}
	if op == "bitcast_u64_ieee64" && len(types) == 1 && types[0] == U64 {
		return IEEE64, false, nil
	}
	if len(types) != 2 {
		return bad()
	}
	if (op == "eq" || op == "ne") && types[0].scalar() && types[1].scalar() {
		return Bool, false, nil
	}
	if types[0] != types[1] || !types[0].numeric() {
		return bad()
	}
	switch op {
	case "add", "sub", "mul", "div", "rem":
		if types[0] == U64 {
			return U64, op == "div" || op == "rem", nil
		}
		return types[0], types[0] != IEEE64, nil
	case "band", "bor", "bxor":
		if types[0] == U64 {
			return U64, false, nil
		}
		return bad()
	case "shl", "shr":
		if types[0] == U64 {
			return U64, true, nil
		}
		return bad()
	case "lt", "le", "gt", "ge":
		return Bool, false, nil
	}
	return bad()
}

// Apply performs one typed operation. There is no implicit numeric conversion,
// reassociation, unchecked integer wraparound, or fused floating-point operation.
func Apply(op string, args ...Value) (Value, error) {
	if _, _, err := resultTypeValues(op, args); err != nil {
		return Value{}, err
	}
	x := args[0]
	if op == "not" {
		return Boolean(!x.b), nil
	}
	if op == "neg" {
		if x.typ == F64 || x.typ == IEEE64 {
			return Value{typ: x.typ, f: -x.f}, nil
		}
		if x.typ == U64 {
			return Uint(0 - x.u), nil
		}
		if x.i == minI64 {
			return Value{}, diagnostic("overflow", "i64 negation overflow")
		}
		return Int(-x.i), nil
	}
	if op == "bitcast_i64_u64" {
		return Uint(uint64(x.i)), nil
	}
	if op == "bitcast_u64_i64" {
		return Int(int64(x.u)), nil
	}
	if op == "bitcast_ieee64_u64" {
		return Uint(math.Float64bits(x.f)), nil
	}
	if op == "bitcast_u64_ieee64" {
		return Value{typ: IEEE64, f: math.Float64frombits(x.u)}, nil
	}
	y := args[1]
	if op == "eq" || op == "ne" {
		equal := x.typ == y.typ && ((x.typ == I64 && x.i == y.i) || (x.typ == U64 && x.u == y.u) || ((x.typ == F64 || x.typ == IEEE64) && x.f == y.f) || (x.typ == Bool && x.b == y.b))
		if op == "ne" {
			equal = !equal
		}
		return Boolean(equal), nil
	}
	if op == "lt" || op == "le" || op == "gt" || op == "ge" {
		if x.typ == IEEE64 {
			switch op {
			case "lt":
				return Boolean(x.f < y.f), nil
			case "le":
				return Boolean(x.f <= y.f), nil
			case "gt":
				return Boolean(x.f > y.f), nil
			default:
				return Boolean(x.f >= y.f), nil
			}
		}
		if x.typ == U64 {
			switch op {
			case "lt":
				return Boolean(x.u < y.u), nil
			case "le":
				return Boolean(x.u <= y.u), nil
			case "gt":
				return Boolean(x.u > y.u), nil
			default:
				return Boolean(x.u >= y.u), nil
			}
		}
		less, equal := x.i < y.i, x.i == y.i
		if x.typ == F64 {
			less, equal = x.f < y.f, x.f == y.f
		}
		switch op {
		case "lt":
			return Boolean(less), nil
		case "le":
			return Boolean(less || equal), nil
		case "gt":
			return Boolean(!less && !equal), nil
		default:
			return Boolean(!less), nil
		}
	}
	if x.typ == F64 || x.typ == IEEE64 {
		var z float64
		switch op {
		case "add":
			z = float64(x.f + y.f)
		case "sub":
			z = float64(x.f - y.f)
		case "mul":
			z = float64(x.f * y.f)
		case "div", "rem":
			if x.typ == F64 && y.f == 0 {
				return Value{}, diagnostic("division_by_zero", "zero divisor")
			}
			if op == "div" {
				z = float64(x.f / y.f)
			} else {
				z = math.Mod(x.f, y.f)
			}
		}
		if x.typ == F64 && (math.IsNaN(z) || math.IsInf(z, 0)) {
			return Value{}, diagnostic("non_finite", "non-finite f64 result")
		}
		return Value{typ: x.typ, f: z}, nil
	}
	if x.typ == U64 {
		a, b := x.u, y.u
		switch op {
		case "add":
			return Uint(a + b), nil
		case "sub":
			return Uint(a - b), nil
		case "mul":
			return Uint(a * b), nil
		case "div":
			if b == 0 {
				return Value{}, diagnostic("division_by_zero", "zero divisor")
			}
			return Uint(a / b), nil
		case "rem":
			if b == 0 {
				return Value{}, diagnostic("division_by_zero", "zero divisor")
			}
			return Uint(a % b), nil
		case "band":
			return Uint(a & b), nil
		case "bor":
			return Uint(a | b), nil
		case "bxor":
			return Uint(a ^ b), nil
		case "shl":
			if b >= 64 {
				return Value{}, diagnostic("shift_out_of_range", "u64 shift count must be below 64")
			}
			return Uint(a << b), nil
		case "shr":
			if b >= 64 {
				return Value{}, diagnostic("shift_out_of_range", "u64 shift count must be below 64")
			}
			return Uint(a >> b), nil
		}
	}
	a, b := x.i, y.i
	overflow := func() (Value, error) { return Value{}, diagnostic("overflow", "i64 "+op+" overflow") }
	switch op {
	case "add":
		if (b > 0 && a > maxI64-b) || (b < 0 && a < minI64-b) {
			return overflow()
		}
		return Int(a + b), nil
	case "sub":
		if (b > 0 && a < minI64+b) || (b < 0 && a > maxI64+b) {
			return overflow()
		}
		return Int(a - b), nil
	case "mul":
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
			return overflow()
		}
		if negative {
			if lo == 1<<63 {
				return Int(minI64), nil
			}
			return Int(-int64(lo)), nil
		}
		return Int(int64(lo)), nil
	case "div", "rem":
		if b == 0 {
			return Value{}, diagnostic("division_by_zero", "zero divisor")
		}
		if a == minI64 && b == -1 {
			if op == "rem" {
				return Int(0), nil
			}
			return overflow()
		}
		if op == "div" {
			return Int(a / b), nil
		}
		return Int(a % b), nil
	}
	return Value{}, diagnostic("invalid_opcode", op)
}

// resultTypeValues is the allocation-free hot-path counterpart of resultType.
// It intentionally mirrors resultType semantics for Value operands so Apply
// does not allocate a temporary []Type for every arithmetic instruction.
func resultTypeValues(op string, args []Value) (Type, bool, error) {
	bad := func() (Type, bool, error) {
		if len(args) == 1 {
			return "", false, diagnostic("type_mismatch", fmt.Sprintf("invalid operands [%s] for %s", args[0].typ, op))
		}
		if len(args) == 2 {
			return "", false, diagnostic("type_mismatch", fmt.Sprintf("invalid operands [%s %s] for %s", args[0].typ, args[1].typ, op))
		}
		return "", false, diagnostic("type_mismatch", fmt.Sprintf("invalid operand count %d for %s", len(args), op))
	}
	if len(args) == 1 {
		t := args[0].typ
		if op == "neg" && t.numeric() {
			return t, t == I64, nil
		}
		if op == "not" && t == Bool {
			return Bool, false, nil
		}
		if op == "bitcast_i64_u64" && t == I64 {
			return U64, false, nil
		}
		if op == "bitcast_u64_i64" && t == U64 {
			return I64, false, nil
		}
		if op == "bitcast_ieee64_u64" && t == IEEE64 {
			return U64, false, nil
		}
		if op == "bitcast_u64_ieee64" && t == U64 {
			return IEEE64, false, nil
		}
		return bad()
	}
	if len(args) != 2 {
		return bad()
	}
	a, b := args[0].typ, args[1].typ
	if (op == "eq" || op == "ne") && a.scalar() && b.scalar() {
		return Bool, false, nil
	}
	if a != b || !a.numeric() {
		return bad()
	}
	switch op {
	case "add", "sub", "mul", "div", "rem":
		if a == U64 {
			return U64, op == "div" || op == "rem", nil
		}
		return a, a != IEEE64, nil
	case "band", "bor", "bxor":
		if a == U64 {
			return U64, false, nil
		}
		return bad()
	case "shl", "shr":
		if a == U64 {
			return U64, true, nil
		}
		return bad()
	case "lt", "le", "gt", "ge":
		return Bool, false, nil
	default:
		return bad()
	}
}
