package coreir

import (
	"context"
	"sync"
	"testing"
)

func storageRoundTripModule() Module {
	return Module{Version: Version, Functions: []Function{{
		Name:   "roundtrip",
		Result: U64,
		Slots:  []Type{U64, U64, U64, U64, U64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "const", Dest: 0, Constant: &Literal{Type: U64, Value: "3"}},
				{Op: "storage.alloc_u64", Dest: 1, Args: []int{0}, MayTrap: true},
				{Op: "const", Dest: 2, Constant: &Literal{Type: U64, Value: "1"}},
				{Op: "const", Dest: 3, Constant: &Literal{Type: U64, Value: "42"}},
				{Op: "storage.store_u64", Dest: -1, Args: []int{1, 2, 3}, MayTrap: true},
				{Op: "storage.load_u64", Dest: 4, Args: []int{1, 2}, MayTrap: true},
				{Op: "storage.free", Dest: -1, Args: []int{1}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 4},
		}},
	}}}
}

func TestStorageOpsParityAcrossCoreExecutionModes(t *testing.T) {
	e, err := Prepare(storageRoundTripModule())
	if err != nil {
		t.Fatal(err)
	}
	for name, run := range map[string]func(context.Context, string, []Value, int) (RunResult, error){
		"run": e.Run, "fast": e.RunFast, "turbo": e.RunTurbo,
	} {
		result, err := run(context.Background(), "roundtrip", nil, 1000)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		value, ok := result.Value.Uint64()
		if !ok || value != 42 {
			t.Fatalf("%s value=%v got=%d ok=%v", name, result.Value, value, ok)
		}
	}
}

func TestStorageOpsBoundsAndStaleIDFailClosed(t *testing.T) {
	cases := []struct {
		name string
		ops  []Instruction
		want string
	}{
		{
			name: "bounds",
			ops: []Instruction{
				{Op: "const", Dest: 0, Constant: &Literal{Type: U64, Value: "1"}},
				{Op: "storage.alloc_u64", Dest: 1, Args: []int{0}, MayTrap: true},
				{Op: "const", Dest: 2, Constant: &Literal{Type: U64, Value: "1"}},
				{Op: "storage.load_u64", Dest: 3, Args: []int{1, 2}, MayTrap: true},
			},
			want: "bounds",
		},
		{
			name: "stale",
			ops: []Instruction{
				{Op: "const", Dest: 0, Constant: &Literal{Type: U64, Value: "1"}},
				{Op: "storage.alloc_u64", Dest: 1, Args: []int{0}, MayTrap: true},
				{Op: "storage.free", Dest: -1, Args: []int{1}, MayTrap: true},
				{Op: "const", Dest: 2, Constant: &Literal{Type: U64, Value: "0"}},
				{Op: "storage.load_u64", Dest: 3, Args: []int{1, 2}, MayTrap: true},
			},
			want: "storage",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := Module{Version: Version, Functions: []Function{{
				Name: "entry", Result: U64, Slots: []Type{U64, U64, U64, U64},
				Blocks: []Block{{Instructions: tc.ops, Terminator: Terminator{Op: "return", Value: 3}}},
			}}}
			e, err := Prepare(m)
			if err != nil {
				t.Fatal(err)
			}
			for name, run := range map[string]func(context.Context, string, []Value, int) (RunResult, error){
				"run": e.Run, "fast": e.RunFast, "turbo": e.RunTurbo,
			} {
				_, err := run(context.Background(), "entry", nil, 1000)
				if errorCode(err) != tc.want {
					t.Fatalf("%s error=%v code=%s want=%s", name, err, errorCode(err), tc.want)
				}
			}
		})
	}
}

func TestStorageRuntimeIsPerRunAndConcurrent(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name: "alloc", Result: U64, Slots: []Type{U64, U64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "const", Dest: 0, Constant: &Literal{Type: U64, Value: "1"}},
				{Op: "storage.alloc_u64", Dest: 1, Args: []int{0}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 1},
		}},
	}}}
	e, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	const n = 8
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := e.Run(context.Background(), "alloc", nil, 100)
			if err != nil {
				errs <- err
				return
			}
			id, ok := result.Value.Uint64()
			if !ok || id != 1 {
				errs <- &Diagnostic{Code: "test", Message: "per-run storage ID did not restart at 1"}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
}

func TestStorageMetadataParityAcrossCoreExecutionModes(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name: "meta", Result: U64, Slots: []Type{U64, U64, U64, U64, U64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "const", Dest: 0, Constant: &Literal{Type: U64, Value: "4"}},
				{Op: "storage.alloc_u64", Dest: 1, Args: []int{0}, MayTrap: true},
				{Op: "storage.capacity_u64", Dest: 2, Args: []int{1}, MayTrap: true},
				{Op: "const", Dest: 3, Constant: &Literal{Type: U64, Value: "2"}},
				{Op: "storage.set_len_u64", Dest: -1, Args: []int{1, 3}, MayTrap: true},
				{Op: "storage.len_u64", Dest: 4, Args: []int{1}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 4},
		}},
	}}}
	e, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	for name, run := range map[string]func(context.Context, string, []Value, int) (RunResult, error){
		"run": e.Run, "fast": e.RunFast, "turbo": e.RunTurbo,
	} {
		result, err := run(context.Background(), "meta", nil, 1000)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		value, ok := result.Value.Uint64()
		if !ok || value != 2 {
			t.Fatalf("%s len=%d ok=%v", name, value, ok)
		}
	}
}

func TestStorageMetadataRejectsLogicalLengthBeyondCapacity(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name: "bad", Result: U64, Slots: []Type{U64, U64, U64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "const", Dest: 0, Constant: &Literal{Type: U64, Value: "2"}},
				{Op: "storage.alloc_u64", Dest: 1, Args: []int{0}, MayTrap: true},
				{Op: "const", Dest: 2, Constant: &Literal{Type: U64, Value: "3"}},
				{Op: "storage.set_len_u64", Dest: -1, Args: []int{1, 2}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 2},
		}},
	}}}
	e, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	for name, run := range map[string]func(context.Context, string, []Value, int) (RunResult, error){
		"run": e.Run, "fast": e.RunFast, "turbo": e.RunTurbo,
	} {
		if _, err := run(context.Background(), "bad", nil, 1000); errorCode(err) != "storage" {
			t.Fatalf("%s error=%v code=%s", name, err, errorCode(err))
		}
	}
}
