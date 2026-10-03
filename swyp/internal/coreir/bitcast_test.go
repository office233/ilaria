package coreir

import (
	"context"
	"math"
	"testing"
)

func TestIntegerBitcastPreservesRawBitsAcrossExecutors(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name:   "main",
		Result: I64,
		Slots:  []Type{I64, U64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "const", Dest: 0, Constant: &Literal{Type: I64, Value: "-1"}},
				{Op: "bitcast_i64_u64", Dest: 1, Args: []int{0}},
				{Op: "bitcast_u64_i64", Dest: 2, Args: []int{1}},
			},
			Terminator: Terminator{Op: "return", Value: 2},
		}},
	}}}
	exec, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, run := range []struct {
		name string
		fn   func(context.Context, string, []Value, int) (RunResult, error)
	}{
		{"run", exec.Run},
		{"fast", exec.RunFast},
		{"turbo", exec.RunTurbo},
	} {
		t.Run(run.name, func(t *testing.T) {
			got, err := run.fn(context.Background(), "main", nil, 100)
			if err != nil {
				t.Fatal(err)
			}
			v, ok := got.Value.Int64()
			if !ok || v != -1 {
				t.Fatalf("value=%d ok=%v", v, ok)
			}
		})
	}
}

func TestIEEE64BitcastPreservesRawBitsAcrossExecutors(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name:   "main",
		Result: IEEE64,
		Slots:  []Type{IEEE64, U64, IEEE64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "const", Dest: 0, Constant: &Literal{Type: IEEE64, Value: "-0"}},
				{Op: "bitcast_ieee64_u64", Dest: 1, Args: []int{0}},
				{Op: "bitcast_u64_ieee64", Dest: 2, Args: []int{1}},
			},
			Terminator: Terminator{Op: "return", Value: 2},
		}},
	}}}
	exec, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, run := range []struct {
		name string
		fn   func(context.Context, string, []Value, int) (RunResult, error)
	}{
		{"run", exec.Run},
		{"fast", exec.RunFast},
		{"turbo", exec.RunTurbo},
	} {
		t.Run(run.name, func(t *testing.T) {
			got, err := run.fn(context.Background(), "main", nil, 100)
			if err != nil {
				t.Fatal(err)
			}
			v, ok := got.Value.Float64()
			if !ok || math.Float64bits(v) != math.Float64bits(math.Copysign(0, -1)) {
				t.Fatalf("value=%v bits=%x", v, math.Float64bits(v))
			}
		})
	}
}
