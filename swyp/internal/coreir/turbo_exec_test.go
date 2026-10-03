package coreir

import (
	"context"
	"math"
	"testing"
	"unsafe"
)

func TestTurboInstructionCompactLayout(t *testing.T) {
	turboSize := unsafe.Sizeof(turboInstruction{})
	fastSize := unsafe.Sizeof(fastInstruction{})
	if turboSize > 32 {
		t.Fatalf("turbo instruction size=%d want <=32", turboSize)
	}
	if turboSize*3 >= fastSize {
		t.Fatalf("turbo instruction size=%d not substantially smaller than fast=%d", turboSize, fastSize)
	}
	turboTermSize := unsafe.Sizeof(turboTerminator{})
	fastTermSize := unsafe.Sizeof(fastTerminator{})
	if turboTermSize > 16 {
		t.Fatalf("turbo terminator size=%d want <=16", turboTermSize)
	}
	if turboTermSize*2 >= fastTermSize {
		t.Fatalf("turbo terminator size=%d not substantially smaller than fast=%d", turboTermSize, fastTermSize)
	}
}

func TestTurboEqualityDoesNotUseFallbackSideTable(t *testing.T) {
	types := []Type{I64, U64, F64, IEEE64, Bool}
	for _, typ := range types {
		m := Module{Version: Version, Functions: []Function{{
			Name:   "eq",
			Params: []Parameter{{Name: "a", Type: typ}, {Name: "b", Type: typ}},
			Result: Bool,
			Slots:  []Type{typ, typ, Bool},
			Blocks: []Block{{
				Instructions: []Instruction{{Op: "eq", Dest: 2, Args: []int{0, 1}}},
				Terminator:   Terminator{Op: "return", Value: 2},
			}},
		}}}
		exe, err := Prepare(m)
		if err != nil {
			t.Fatalf("%s prepare: %v", typ, err)
		}
		f := exe.functions["eq"]
		if len(f.turboExtras) != 0 {
			t.Fatalf("%s equality unexpectedly uses turbo extras: %+v", typ, f.turboExtras)
		}
		if got := f.turboBlocks[0][0].op; got == fastFallback {
			t.Fatalf("%s equality still uses fallback opcode", typ)
		}
	}
}

func TestRunTurboMatchesRunFast(t *testing.T) {
	f64 := Literal{Type: F64, Value: "1.5"}
	m := Module{Version: Version, Functions: []Function{
		{
			Name:   "inc",
			Params: []Parameter{{Name: "x", Type: I64}},
			Result: I64,
			Slots:  []Type{I64, I64, I64},
			Blocks: []Block{{
				Instructions: []Instruction{
					{Op: "const", Dest: 1, Constant: &Literal{Type: I64, Value: "1"}},
					{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: true},
				},
				Terminator: Terminator{Op: "return", Value: 2},
			}},
		},
		{
			Name:   "mix",
			Params: []Parameter{{Name: "x", Type: I64}},
			Result: Bool,
			Slots:  []Type{I64, I64, I64, F64, F64, Bool},
			Blocks: []Block{{
				Instructions: []Instruction{
					{Op: "call", Dest: 1, Args: []int{0}, Callee: "inc", MayTrap: true},
					{Op: "const", Dest: 2, Constant: &Literal{Type: I64, Value: "42"}},
					{Op: "const", Dest: 3, Constant: &f64},
					{Op: "move", Dest: 4, Args: []int{3}},
					{Op: "eq", Dest: 5, Args: []int{1, 2}},
				},
				Terminator: Terminator{Op: "return", Value: 5},
			}},
		},
	}}
	exe, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []int64{0, 41, 99} {
		args := []Value{Int(input)}
		fast, fastErr := exe.RunFast(context.Background(), "mix", args, 100)
		turbo, turboErr := exe.RunTurbo(context.Background(), "mix", args, 100)
		if errorCode(fastErr) != errorCode(turboErr) {
			t.Fatalf("input=%d fastErr=%v turboErr=%v", input, fastErr, turboErr)
		}
		if fastErr == nil && !sameValue(fast.Value, turbo.Value) {
			t.Fatalf("input=%d fast=%v turbo=%v", input, fast.Value.Literal(), turbo.Value.Literal())
		}
	}
}

func TestTurboIEEEEqualityMatchesGoSemantics(t *testing.T) {
	nan := math.Float64bits(math.NaN())
	eq, err := applyTurboValue(fastFallback, "eq", nan, nan, true, IEEE64, IEEE64)
	if err != nil {
		t.Fatal(err)
	}
	if eq != 0 {
		t.Fatal("NaN == NaN must be false")
	}
	plusZero := math.Float64bits(0)
	minusZero := math.Float64bits(math.Copysign(0, -1))
	eq, err = applyTurboValue(fastFallback, "eq", plusZero, minusZero, true, IEEE64, IEEE64)
	if err != nil {
		t.Fatal(err)
	}
	if eq != 1 {
		t.Fatal("+0 == -0 must be true")
	}
}

func TestTurboOverflowMatchesFast(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name:   "add",
		Params: []Parameter{{Name: "x", Type: I64}, {Name: "y", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 2},
		}},
	}}}
	exe, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	args := []Value{Int(maxI64), Int(1)}
	_, fastErr := exe.RunFast(context.Background(), "add", args, 10)
	_, turboErr := exe.RunTurbo(context.Background(), "add", args, 10)
	if errorCode(fastErr) != "overflow" || errorCode(turboErr) != "overflow" {
		t.Fatalf("fast=%v turbo=%v", fastErr, turboErr)
	}
}

func TestDifferentialEqNeAllTypePairs(t *testing.T) {
	type sample struct {
		typ Type
		val Value
	}
	samples := []sample{
		{typ: I64, val: Int(5)},
		{typ: I64, val: Int(0)},
		{typ: U64, val: Uint(5)},
		{typ: U64, val: Uint(0)},
		{typ: F64, val: Value{typ: F64, f: 5.0}},
		{typ: F64, val: Value{typ: F64, f: 0.0}},
		{typ: IEEE64, val: Value{typ: IEEE64, f: 5.0}},
		{typ: IEEE64, val: Value{typ: IEEE64, f: 0.0}},
		{typ: Bool, val: Boolean(true)},
		{typ: Bool, val: Boolean(false)},
	}

	for _, s1 := range samples {
		for _, s2 := range samples {
			m := Module{
				Version: Version,
				Functions: []Function{
					{
						Name:   "test_eq",
						Params: []Parameter{{Name: "a", Type: s1.typ}, {Name: "b", Type: s2.typ}},
						Result: Bool,
						Slots:  []Type{s1.typ, s2.typ, Bool},
						Blocks: []Block{{
							Instructions: []Instruction{{Op: "eq", Dest: 2, Args: []int{0, 1}}},
							Terminator:   Terminator{Op: "return", Value: 2},
						}},
					},
					{
						Name:   "test_ne",
						Params: []Parameter{{Name: "a", Type: s1.typ}, {Name: "b", Type: s2.typ}},
						Result: Bool,
						Slots:  []Type{s1.typ, s2.typ, Bool},
						Blocks: []Block{{
							Instructions: []Instruction{{Op: "ne", Dest: 2, Args: []int{0, 1}}},
							Terminator:   Terminator{Op: "return", Value: 2},
						}},
					},
				},
			}
			exe, err := Prepare(m)
			if err != nil {
				t.Fatalf("prepare %s vs %s: %v", s1.typ, s2.typ, err)
			}
			ctx := context.Background()
			args := []Value{s1.val, s2.val}

			// Test eq
			refEq, refErr := exe.Run(ctx, "test_eq", args, 100)
			turboEq, turboErr := exe.RunTurbo(ctx, "test_eq", args, 100)
			if refErr != turboErr {
				t.Fatalf("eq err mismatch for %v (%s) == %v (%s): ref=%v turbo=%v", s1.val, s1.typ, s2.val, s2.typ, refErr, turboErr)
			}
			if refEq.Value != turboEq.Value {
				t.Fatalf("eq value mismatch for %v (%s) == %v (%s): ref=%v turbo=%v", s1.val, s1.typ, s2.val, s2.typ, refEq.Value, turboEq.Value)
			}

			// Test ne
			refNe, refNeErr := exe.Run(ctx, "test_ne", args, 100)
			turboNe, turboNeErr := exe.RunTurbo(ctx, "test_ne", args, 100)
			if refNeErr != turboNeErr {
				t.Fatalf("ne err mismatch for %v (%s) != %v (%s): ref=%v turbo=%v", s1.val, s1.typ, s2.val, s2.typ, refNeErr, turboNeErr)
			}
			if refNe.Value != turboNe.Value {
				t.Fatalf("ne value mismatch for %v (%s) != %v (%s): ref=%v turbo=%v", s1.val, s1.typ, s2.val, s2.typ, refNe.Value, turboNe.Value)
			}

			// When types differ, eq must be false and ne must be true
			if s1.typ != s2.typ {
				if turboEq.Value != Boolean(false) {
					t.Fatalf("mixed-type eq must be false for %v (%s) == %v (%s)", s1.val, s1.typ, s2.val, s2.typ)
				}
				if turboNe.Value != Boolean(true) {
					t.Fatalf("mixed-type ne must be true for %v (%s) != %v (%s)", s1.val, s1.typ, s2.val, s2.typ)
				}
			}
		}
	}
}
