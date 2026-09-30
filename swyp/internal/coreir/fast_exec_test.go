package coreir

import (
	"math"
	"testing"
)

func TestFastValueOpsMatchApply(t *testing.T) {
	type tc struct {
		name string
		fast fastValueOp
		raw  string
		x    Value
		y    Value
		hasY bool
	}
	f64 := func(v float64) Value { return Value{typ: F64, f: v} }
	ieee := func(v float64) Value { return Value{typ: IEEE64, f: v} }

	cases := []tc{
		{"not", fastNot, "not", Boolean(true), Value{}, false},
		{"i64-neg", fastI64Neg, "neg", Int(-7), Value{}, false},
		{"i64-neg-overflow", fastI64Neg, "neg", Int(minI64), Value{}, false},
		{"u64-neg", fastU64Neg, "neg", Uint(7), Value{}, false},
		{"f64-neg", fastF64Neg, "neg", f64(1.5), Value{}, false},
		{"ieee-neg", fastIEEE64Neg, "neg", ieee(1.5), Value{}, false},

		{"i64-add", fastI64Add, "add", Int(20), Int(22), true},
		{"i64-add-overflow", fastI64Add, "add", Int(maxI64), Int(1), true},
		{"i64-sub", fastI64Sub, "sub", Int(20), Int(22), true},
		{"i64-sub-overflow", fastI64Sub, "sub", Int(minI64), Int(1), true},
		{"i64-mul", fastI64Mul, "mul", Int(-7), Int(9), true},
		{"i64-mul-overflow", fastI64Mul, "mul", Int(maxI64), Int(2), true},
		{"i64-div", fastI64Div, "div", Int(42), Int(5), true},
		{"i64-div-zero", fastI64Div, "div", Int(42), Int(0), true},
		{"i64-div-overflow", fastI64Div, "div", Int(minI64), Int(-1), true},
		{"i64-rem", fastI64Rem, "rem", Int(42), Int(5), true},
		{"i64-rem-edge", fastI64Rem, "rem", Int(minI64), Int(-1), true},

		{"u64-add", fastU64Add, "add", Uint(^uint64(0)), Uint(1), true},
		{"u64-sub", fastU64Sub, "sub", Uint(0), Uint(1), true},
		{"u64-mul", fastU64Mul, "mul", Uint(7), Uint(9), true},
		{"u64-div", fastU64Div, "div", Uint(42), Uint(5), true},
		{"u64-div-zero", fastU64Div, "div", Uint(42), Uint(0), true},
		{"u64-rem", fastU64Rem, "rem", Uint(42), Uint(5), true},
		{"u64-and", fastU64And, "band", Uint(0xf0), Uint(0xcc), true},
		{"u64-or", fastU64Or, "bor", Uint(0xf0), Uint(0x0f), true},
		{"u64-xor", fastU64Xor, "bxor", Uint(0xf0), Uint(0xff), true},
		{"u64-shl", fastU64Shl, "shl", Uint(1), Uint(63), true},
		{"u64-shl-bad", fastU64Shl, "shl", Uint(1), Uint(64), true},
		{"u64-shr", fastU64Shr, "shr", Uint(1 << 63), Uint(63), true},

		{"f64-add", fastF64Add, "add", f64(1.25), f64(2.5), true},
		{"f64-overflow", fastF64Mul, "mul", f64(math.MaxFloat64), f64(2), true},
		{"f64-div-zero", fastF64Div, "div", f64(1), f64(0), true},
		{"f64-rem", fastF64Rem, "rem", f64(7.5), f64(2), true},

		{"ieee-add", fastIEEE64Add, "add", ieee(1.25), ieee(2.5), true},
		{"ieee-div-zero", fastIEEE64Div, "div", ieee(1), ieee(0), true},
		{"ieee-rem-zero", fastIEEE64Rem, "rem", ieee(1), ieee(0), true},

		{"i64-lt", fastI64LT, "lt", Int(-1), Int(2), true},
		{"i64-le", fastI64LE, "le", Int(2), Int(2), true},
		{"i64-gt", fastI64GT, "gt", Int(3), Int(2), true},
		{"i64-ge", fastI64GE, "ge", Int(2), Int(2), true},
		{"u64-lt", fastU64LT, "lt", Uint(1), Uint(2), true},
		{"u64-ge", fastU64GE, "ge", Uint(2), Uint(2), true},
		{"f64-lt", fastF64LT, "lt", f64(1), f64(2), true},
		{"f64-ge", fastF64GE, "ge", f64(2), f64(2), true},
		{"ieee-lt-nan", fastIEEE64LT, "lt", ieee(math.NaN()), ieee(2), true},
		{"ieee-ge", fastIEEE64GE, "ge", ieee(2), ieee(2), true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fastValue, fastErr := applyFastValue(c.fast, c.raw, c.x, c.y, c.hasY)
			var exactValue Value
			var exactErr error
			if c.hasY {
				exactValue, exactErr = Apply(c.raw, c.x, c.y)
			} else {
				exactValue, exactErr = Apply(c.raw, c.x)
			}
			if errorCode(fastErr) != errorCode(exactErr) {
				t.Fatalf("error code fast=%q exact=%q fastErr=%v exactErr=%v", errorCode(fastErr), errorCode(exactErr), fastErr, exactErr)
			}
			if fastErr != nil || exactErr != nil {
				return
			}
			if !sameValue(fastValue, exactValue) {
				t.Fatalf("fast=%v exact=%v", fastValue.Literal(), exactValue.Literal())
			}
		})
	}
}

func sameValue(a, b Value) bool {
	if a.typ != b.typ {
		return false
	}
	switch a.typ {
	case I64:
		return a.i == b.i
	case U64:
		return a.u == b.u
	case Bool:
		return a.b == b.b
	case F64, IEEE64:
		if math.IsNaN(a.f) && math.IsNaN(b.f) {
			return true
		}
		return math.Float64bits(a.f) == math.Float64bits(b.f)
	default:
		return true
	}
}
