//go:build windows && amd64

package coreir

import (
	"math"
	"testing"
)

// These regressions pin register-allocation shapes that a real allocator only
// produces occasionally, so two-address lowering bugs cannot hide behind a
// lucky assignment.

func TestX64CFGMachineFPDestinationMayAliasEitherOperand(t *testing.T) {
	fp := func(register, spill int) RegisterLocation {
		return RegisterLocation{Class: RegisterFP, Register: register, Spill: spill}
	}
	gpr := RegisterLocation{Class: RegisterGPR, Register: 0, Spill: -1}
	shapes := []struct {
		name        string
		left, right RegisterLocation
		dest        RegisterLocation
	}{
		{"dest-aliases-right", fp(0, -1), fp(1, -1), fp(1, -1)},
		{"dest-aliases-left", fp(0, -1), fp(1, -1), fp(0, -1)},
		{"distinct", fp(0, -1), fp(1, -1), fp(2, -1)},
		{"spilled-left-dest-aliases-right", fp(-1, 0), fp(1, -1), fp(1, -1)},
		{"spilled-right", fp(0, -1), fp(-1, 0), fp(2, -1)},
		{"spilled-dest", fp(0, -1), fp(1, -1), fp(-1, 0)},
	}
	const x, y = 12.5, 2.5
	for _, op := range []struct {
		name string
		want float64
	}{{"sub", x - y}, {"div", x / y}, {"add", x + y}, {"mul", x * y}} {
		for _, shape := range shapes {
			f := SSAFunction{
				Name:       "fp_alias",
				Params:     []SSAValue{0, 1},
				ParamNames: []string{"x", "y"},
				Result:     U64,
				ValueTypes: []Type{U64, U64, IEEE64, IEEE64, IEEE64, U64},
				Blocks: []SSABlock{{
					Reachable: true,
					Instructions: []SSAInstruction{
						{Op: "bitcast_u64_ieee64", Dest: 2, Args: []SSAValue{0}},
						{Op: "bitcast_u64_ieee64", Dest: 3, Args: []SSAValue{1}},
						{Op: op.name, Dest: 4, Args: []SSAValue{2, 3}},
						{Op: "bitcast_ieee64_u64", Dest: 5, Args: []SSAValue{4}},
					},
					Terminator: SSATerminator{Op: "return", Value: 5},
				}},
			}
			plan := SSARegisterPlan{Locations: []RegisterLocation{
				gpr, {Class: RegisterGPR, Register: 1, Spill: -1}, shape.left, shape.right, shape.dest, gpr,
			}}
			code, err := EmitX64CFGMachineCode(f, plan)
			if err != nil {
				t.Fatalf("%s/%s: %v", op.name, shape.name, err)
			}
			raw, status := runX64MachineCodeForTest(t, code, uintptr(math.Float64bits(x)), uintptr(math.Float64bits(y)))
			if got := math.Float64frombits(uint64(raw)); status != 0 || got != op.want {
				t.Errorf("%s/%s: got=%v status=%d want=%v", op.name, shape.name, got, status, op.want)
			}
		}
	}
}

func TestX64CFGMachineCheckedDivRemMatchesCoreSemantics(t *testing.T) {
	gpr := func(register, spill int) RegisterLocation {
		return RegisterLocation{Class: RegisterGPR, Register: register, Spill: spill}
	}
	shapes := []struct {
		name              string
		left, right, dest RegisterLocation
	}{
		{"dest-aliases-left", gpr(0, -1), gpr(1, -1), gpr(0, -1)},
		{"dest-aliases-right", gpr(0, -1), gpr(1, -1), gpr(1, -1)},
		{"distinct", gpr(0, -1), gpr(1, -1), gpr(2, -1)},
		{"all-spilled", gpr(-1, 0), gpr(-1, 1), gpr(-1, 2)},
	}
	signed := [][2]int64{{85, 2}, {-85, 2}, {-85, -2}, {47, -5}, {-47, 5}, {7, 0}, {math.MinInt64, -1}, {math.MaxInt64, -1}, {math.MinInt64, 1}, {0, -1}}
	unsigned := [][2]uint64{{100, 7}, {math.MaxUint64, 2}, {math.MaxUint64, math.MaxUint64}, {1, 0}, {0, 3}}
	for _, typ := range []Type{I64, U64} {
		for _, op := range []string{"div", "rem"} {
			for _, shape := range shapes {
				f := SSAFunction{
					Name:       "divrem",
					Params:     []SSAValue{0, 1},
					ParamNames: []string{"a", "b"},
					Result:     typ,
					ValueTypes: []Type{typ, typ, typ},
					Blocks: []SSABlock{{
						Reachable:    true,
						Instructions: []SSAInstruction{{Op: op, Dest: 2, Args: []SSAValue{0, 1}, MayTrap: true}},
						Terminator:   SSATerminator{Op: "return", Value: 2},
					}},
				}
				plan := SSARegisterPlan{Locations: []RegisterLocation{shape.left, shape.right, shape.dest}}
				code, err := EmitX64CFGMachineCode(f, plan)
				if err != nil {
					t.Fatalf("%s %s/%s: %v", typ, op, shape.name, err)
				}
				check := func(a, b Value, rawA, rawB uint64) {
					want, wantErr := Apply(op, a, b)
					raw, status := runX64MachineCodeForTest(t, code, uintptr(rawA), uintptr(rawB))
					if wantErr != nil {
						if status != 1 {
							t.Errorf("%s %s/%s(%v,%v): status=%d want arithmetic trap status 1 (%v)", typ, op, shape.name, a.Literal().Value, b.Literal().Value, status, wantErr)
						}
						return
					}
					if status != 0 || uint64(raw) != valueToRaw(want) {
						t.Errorf("%s %s/%s(%v,%v): raw=%d status=%d want=%s", typ, op, shape.name, a.Literal().Value, b.Literal().Value, uint64(raw), status, want.Literal().Value)
					}
				}
				if typ == I64 {
					for _, in := range signed {
						check(Int(in[0]), Int(in[1]), uint64(in[0]), uint64(in[1]))
					}
				} else {
					for _, in := range unsigned {
						check(Uint(in[0]), Uint(in[1]), in[0], in[1])
					}
				}
			}
		}
	}
}
