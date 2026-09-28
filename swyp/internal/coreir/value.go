// Package coreir implements the experimental, pure scalar Swyp semantic core.
// It is independent of the source parser and of the STV2 wire format.
package coreir

import (
	"encoding/json"
	"fmt"
	"math"
	"math/bits"
	"strconv"
)

type Type string

const (
	I64    Type  = "i64"
	F64    Type  = "f64"
	Bool   Type  = "bool"
	Void   Type  = "void"
	minI64 int64 = -1 << 63
	maxI64 int64 = 1<<63 - 1
)

func (t Type) scalar() bool  { return t == I64 || t == F64 || t == Bool }
func (t Type) numeric() bool { return t == I64 || t == F64 }

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
	f   float64
	b   bool
}

func Int(v int64) Value                  { return Value{typ: I64, i: v} }
func Boolean(v bool) Value               { return Value{typ: Bool, b: v} }
func (v Value) Type() Type               { return v.typ }
func (v Value) Int64() (int64, bool)     { return v.i, v.typ == I64 }
func (v Value) Float64() (float64, bool) { return v.f, v.typ == F64 }
func (v Value) Boolean() (bool, bool)    { return v.b, v.typ == Bool }
func (v Value) Literal() Literal {
	s := ""
	switch v.typ {
	case I64:
		s = strconv.FormatInt(v.i, 10)
	case F64:
		s = strconv.FormatFloat(v.f, 'g', -1, 64)
	case Bool:
		s = strconv.FormatBool(v.b)
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
	case F64:
		x, err := strconv.ParseFloat(s, 64)
		if err == nil && !math.IsNaN(x) && !math.IsInf(x, 0) {
			return Value{typ: F64, f: x}, nil
		}
	case Bool:
		if s == "true" || s == "false" {
			return Boolean(s == "true"), nil
		}
	}
	return Value{}, diagnostic("invalid_literal", fmt.Sprintf("%q is not a finite %s value", s, t))
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
		return types[0], true, nil
	case "lt", "le", "gt", "ge":
		return Bool, false, nil
	}
	return bad()
}

// Apply performs one typed operation. There is no implicit numeric conversion,
// reassociation, unchecked integer wraparound, or fused floating-point operation.
func Apply(op string, args ...Value) (Value, error) {
	types := make([]Type, len(args))
	for i := range args {
		types[i] = args[i].typ
	}
	if _, _, err := resultType(op, types); err != nil {
		return Value{}, err
	}
	x := args[0]
	if op == "not" {
		return Boolean(!x.b), nil
	}
	if op == "neg" {
		if x.typ == F64 {
			return Value{typ: F64, f: -x.f}, nil
		}
		if x.i == minI64 {
			return Value{}, diagnostic("overflow", "i64 negation overflow")
		}
		return Int(-x.i), nil
	}
	y := args[1]
	if op == "eq" || op == "ne" {
		equal := x.typ == y.typ && ((x.typ == I64 && x.i == y.i) || (x.typ == F64 && x.f == y.f) || (x.typ == Bool && x.b == y.b))
		if op == "ne" {
			equal = !equal
		}
		return Boolean(equal), nil
	}
	if op == "lt" || op == "le" || op == "gt" || op == "ge" {
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
	if x.typ == F64 {
		var z float64
		switch op {
		case "add":
			z = float64(x.f + y.f)
		case "sub":
			z = float64(x.f - y.f)
		case "mul":
			z = float64(x.f * y.f)
		case "div", "rem":
			if y.f == 0 {
				return Value{}, diagnostic("division_by_zero", "zero divisor")
			}
			if op == "div" {
				z = float64(x.f / y.f)
			} else {
				z = math.Mod(x.f, y.f)
			}
		}
		if math.IsNaN(z) || math.IsInf(z, 0) {
			return Value{}, diagnostic("non_finite", "non-finite f64 result")
		}
		return Value{typ: F64, f: z}, nil
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
