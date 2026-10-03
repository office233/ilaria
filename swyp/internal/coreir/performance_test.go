package coreir

import (
	"context"
	"testing"
)

func TestApplyI64AddZeroAllocations(t *testing.T) {
	x := Int(123456)
	y := Int(789)
	var runErr error
	allocs := testing.AllocsPerRun(1000, func() {
		_, runErr = Apply("add", x, y)
	})
	if runErr != nil {
		t.Fatal(runErr)
	}
	if allocs != 0 {
		t.Fatalf("Apply(i64 add) allocations=%v want 0", allocs)
	}
}

func TestCoreRunFastSmallFrameZeroAllocations(t *testing.T) {
	exe := benchmarkAddChainExecutable(t, 64)
	args := []Value{Int(10)}
	ctx := context.Background()
	var (
		result RunResult
		runErr error
	)
	allocs := testing.AllocsPerRun(1000, func() {
		result, runErr = exe.RunFast(ctx, "chain", args, 1000)
	})
	if runErr != nil {
		t.Fatal(runErr)
	}
	if got, _ := result.Value.Int64(); got != 74 {
		t.Fatalf("result=%d want 74", got)
	}
	if allocs != 0 {
		t.Fatalf("RunFast small-frame allocations=%v want 0", allocs)
	}
}

func TestCoreRunTurboSmallFrameZeroAllocations(t *testing.T) {
	exe := benchmarkAddChainExecutable(t, 64)
	args := []Value{Int(10)}
	ctx := context.Background()
	var (
		result RunResult
		runErr error
	)
	allocs := testing.AllocsPerRun(1000, func() {
		result, runErr = exe.RunTurbo(ctx, "chain", args, 1000)
	})
	if runErr != nil {
		t.Fatal(runErr)
	}
	if got, _ := result.Value.Int64(); got != 74 {
		t.Fatalf("result=%d want 74", got)
	}
	if allocs != 0 {
		t.Fatalf("RunTurbo small-frame allocations=%v want 0", allocs)
	}
}

func BenchmarkApplyI64Add(b *testing.B) {
	x := Int(123456)
	y := Int(789)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		v, err := Apply("add", x, y)
		if err != nil {
			b.Fatal(err)
		}
		if got, _ := v.Int64(); got != 124245 {
			b.Fatal(got)
		}
	}
}

func BenchmarkPrepareAddChain64(b *testing.B) {
	m := benchmarkAddChainModule(64)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := Prepare(m); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkOptimizeAddChain64(b *testing.B) {
	m := benchmarkAddChainModule(64)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, _, err := Optimize(m); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkCoreRunAddChain64(b *testing.B) {
	exe := benchmarkAddChainExecutable(b, 64)
	args := []Value{Int(10)}
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		result, err := exe.Run(ctx, "chain", args, 1000)
		if err != nil {
			b.Fatal(err)
		}
		if got, _ := result.Value.Int64(); got != 74 {
			b.Fatal(got)
		}
	}
}

func BenchmarkCoreRunFastAddChain64(b *testing.B) {
	exe := benchmarkAddChainExecutable(b, 64)
	args := []Value{Int(10)}
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		result, err := exe.RunFast(ctx, "chain", args, 1000)
		if err != nil {
			b.Fatal(err)
		}
		if got, _ := result.Value.Int64(); got != 74 {
			b.Fatal(got)
		}
	}
}

func BenchmarkCoreRunTurboAddChain64(b *testing.B) {
	exe := benchmarkAddChainExecutable(b, 64)
	args := []Value{Int(10)}
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		result, err := exe.RunTurbo(ctx, "chain", args, 1000)
		if err != nil {
			b.Fatal(err)
		}
		if got, _ := result.Value.Int64(); got != 74 {
			b.Fatal(got)
		}
	}
}

func benchmarkAddChainExecutable(b testing.TB, adds int) *Executable {
	b.Helper()
	exe, err := Prepare(benchmarkAddChainModule(adds))
	if err != nil {
		b.Fatal(err)
	}
	return exe
}

func benchmarkAddChainModule(adds int) Module {
	slots := make([]Type, adds+2)
	for i := range slots {
		slots[i] = I64
	}
	instructions := make([]Instruction, 0, adds+1)
	one := Literal{Type: I64, Value: "1"}
	instructions = append(instructions, Instruction{
		Op:       "const",
		Dest:     1,
		Constant: &one,
		MayTrap:  false,
	})
	for i := 0; i < adds; i++ {
		source := 0
		if i > 0 {
			source = i + 1
		}
		instructions = append(instructions, Instruction{
			Op:      "add",
			Dest:    i + 2,
			Args:    []int{source, 1},
			MayTrap: true,
		})
	}
	return Module{Version: Version, Functions: []Function{{
		Name:   "chain",
		Params: []Parameter{{Name: "x", Type: I64}},
		Result: I64,
		Slots:  slots,
		Blocks: []Block{{
			Instructions: instructions,
			Terminator:   Terminator{Op: "return", Value: adds + 1},
		}},
	}}}
}
