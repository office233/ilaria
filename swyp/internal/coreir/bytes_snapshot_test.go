package coreir

import (
	"bytes"
	"context"
	"errors"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func snapshotConst(dest int, n uint64) Instruction {
	return Instruction{Op: "const", Dest: dest, Constant: &Literal{Type: U64, Value: strconv.FormatUint(n, 10)}}
}

// Three parameters let the same tiny fixture exercise dynamic validation in
// interpreters, the C reference and standalone native executables.
func snapshotFixture() Module {
	return Module{Version: Version, Data: []byte("constant"), Functions: []Function{{
		Name: "entry", Params: []Parameter{{Name: "capacity", Type: U64}, {Name: "length", Type: U64}, {Name: "word", Type: U64}},
		Result: Bytes, Slots: []Type{U64, U64, U64, U64, U64, Bytes, U64, Bytes, U64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "storage.alloc_u64", Dest: 3, Args: []int{0}, MayTrap: true},
				snapshotConst(4, 0),
				{Op: "storage.store_u64", Dest: -1, Args: []int{3, 4, 2}, MayTrap: true},
				{Op: "bytes.from_storage_u64", Dest: 5, Args: []int{3, 1}, MayTrap: true},
				snapshotConst(6, 90),
				{Op: "storage.store_u64", Dest: -1, Args: []int{3, 4, 6}, MayTrap: true},
				{Op: "bytes.from_storage_u64", Dest: 7, Args: []int{3, 1}, MayTrap: true},
				{Op: "storage.free", Dest: -1, Args: []int{3}, MayTrap: true},
			},
			Terminator: Terminator{Op: "return", Value: 5},
		}},
	}}}
}

func snapshotScalarFixture(lengthOnly bool) Module {
	m := snapshotFixture()
	f := &m.Functions[0]
	f.Result = U64
	ins := Instruction{Op: "bytes.get", Dest: 8, Args: []int{5, 4}, MayTrap: true}
	if lengthOnly {
		ins = Instruction{Op: "bytes.len", Dest: 8, Args: []int{5}}
	}
	f.Blocks[0].Instructions = append(f.Blocks[0].Instructions, ins)
	f.Blocks[0].Terminator.Value = 8
	return m
}

func snapshotRunners(e *Executable) map[string]func(context.Context, string, []Value, int) (RunResult, error) {
	return map[string]func(context.Context, string, []Value, int) (RunResult, error){
		"safe": e.Run, "fast": e.RunFast, "turbo": e.RunTurbo,
	}
}

func TestBytesSnapshotModesPreparedAndConcurrent(t *testing.T) {
	m := snapshotFixture()
	e, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	m.Data[0] = 'X'
	for name, run := range snapshotRunners(e) {
		t.Run(name, func(t *testing.T) {
			const n = 12
			var wg sync.WaitGroup
			errs := make(chan error, n)
			for i := 0; i < n; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					result, err := run(context.Background(), "entry", []Value{Uint(3), Uint(2), Uint(uint64(i))}, 200)
					if err != nil {
						errs <- err
						return
					}
					data, err := result.ResolveBytes(result.Value)
					if err != nil {
						errs <- err
						return
					}
					offset, length, ok := result.Value.ByteSpan()
					if !ok || offset != 8 || length != 2 || !bytes.Equal(data, []byte{byte(i), 0}) ||
						!bytes.Equal(result.data, append([]byte("constant"), byte(i), 0, 90, 0)) {
						errs <- diagnostic("test", "snapshot, monotonic cursor or per-run isolation mismatch")
						return
					}
					data[0] = 255
					again, err := result.ResolveBytes(result.Value)
					if err != nil || again[0] != byte(i) {
						errs <- diagnostic("test", "ResolveBytes exposed a mutable alias")
					}
				}(i)
			}
			wg.Wait()
			close(errs)
			for err := range errs {
				t.Fatal(err)
			}
		})
	}
}

func TestBytesSnapshotEmptyAndExecutorBounds(t *testing.T) {
	for _, tc := range []struct {
		name     string
		capacity uint64
		length   uint64
		word     uint64
		want     string
	}{
		{"empty", 1, 0, 256, ""},
		{"invalid-octet", 2, 2, 256, "invalid_octet"},
		{"max-word", 2, 2, math.MaxUint64, "invalid_octet"},
		{"oversize", 2, 3, 65, "bounds"},
		{"overflow", 2, math.MaxUint64, 65, "storage_limit"},
		{"arena-exhaustion", MaxRunByteArenaBytes + 1, MaxRunByteArenaBytes + 1, 65, "byte_arena_exhausted"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e, err := Prepare(snapshotFixture())
			if err != nil {
				t.Fatal(err)
			}
			for name, run := range snapshotRunners(e) {
				result, err := run(context.Background(), "entry", []Value{Uint(tc.capacity), Uint(tc.length), Uint(tc.word)}, 200)
				if errorCode(err) != tc.want {
					t.Fatalf("%s err=%v want=%s", name, err, tc.want)
				}
				if tc.want == "" {
					data, err := result.ResolveBytes(result.Value)
					offset, length, ok := result.Value.ByteSpan()
					if err != nil || len(data) != 0 || !ok || offset != 8 || length != 0 {
						t.Fatalf("%s empty=%v data=%v err=%v", name, result.Value, data, err)
					}
				}
			}
		})
	}
	for _, id := range []uint64{0, 1, 65, math.MaxUint64} {
		m := Module{Version: Version, Functions: []Function{{
			Name: "entry", Result: Bytes, Slots: []Type{U64, U64, Bytes},
			Blocks: []Block{{Instructions: []Instruction{
				snapshotConst(0, id), snapshotConst(1, 0),
				{Op: "bytes.from_storage_u64", Dest: 2, Args: []int{0, 1}, MayTrap: true},
			}, Terminator: Terminator{Op: "return", Value: 2}}},
		}}}
		e, err := Prepare(m)
		if err != nil {
			t.Fatal(err)
		}
		for name, run := range snapshotRunners(e) {
			if _, err := run(context.Background(), "entry", nil, 200); errorCode(err) != "storage" {
				t.Fatalf("%s id=%d err=%v", name, id, err)
			}
		}
	}
	m := snapshotFixture()
	ops := m.Functions[0].Blocks[0].Instructions
	m.Functions[0].Blocks[0].Instructions = append(append([]Instruction{}, ops[:3]...),
		Instruction{Op: "storage.free", Dest: -1, Args: []int{3}, MayTrap: true}, ops[3])
	e, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	for name, run := range snapshotRunners(e) {
		if _, err := run(context.Background(), "entry", []Value{Uint(2), Uint(0), Uint(65)}, 200); errorCode(err) != "storage" {
			t.Fatalf("%s stale empty snapshot err=%v", name, err)
		}
	}
}

func TestBytesSnapshotAtomicCommitAndCapacityNotLogicalLength(t *testing.T) {
	e, err := Prepare(Module{Version: Version, Data: []byte("constant"), Functions: storageRoundTripModule().Functions})
	if err != nil {
		t.Fatal(err)
	}
	m := machine{executable: e, ctx: context.Background(), effects: &effectExecution{maxBytes: 5}}
	id, err := m.storageAllocU64(Uint(3))
	if err != nil {
		t.Fatal(err)
	}
	if err := m.storageSetLenU64(id, Uint(0)); err != nil {
		t.Fatal(err)
	}
	for i, n := range []uint64{0, 255, 256} {
		if err := m.storageStoreU64(id, Uint(uint64(i)), Uint(n)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := m.bytesFromStorageU64(id, Uint(3)); errorCode(err) != "invalid_octet" ||
		m.effects.data != nil || m.effects.bytesUsed != 0 || !bytes.Equal(e.data, []byte("constant")) {
		t.Fatalf("invalid snapshot published arena: err=%v state=%+v", err, m.effects)
	}
	first, err := m.bytesFromStorageU64(id, Uint(2))
	if err != nil {
		t.Fatal(err)
	}
	if err := m.storageStoreU64(id, Uint(0), Uint(42)); err != nil {
		t.Fatal(err)
	}
	second, err := m.bytesFromStorageU64(id, Uint(2))
	if err != nil {
		t.Fatal(err)
	}
	for i, span := range []Value{first, second} {
		offset, length, _ := span.ByteSpan()
		if offset != uint32(8+i*2) || length != 2 {
			t.Fatalf("span %d=%v", i, span)
		}
	}
	before := append([]byte(nil), m.byteData()...)
	if _, err := m.bytesFromStorageU64(id, Uint(2)); errorCode(err) != "byte_arena_exhausted" ||
		m.effects.bytesUsed != 4 || !bytes.Equal(before, m.byteData()) {
		t.Fatalf("exhausted snapshot committed: err=%v arena=%v", err, m.byteData())
	}
	if !bytes.Equal(before[8:], []byte{0, 255, 42, 255}) {
		t.Fatalf("immutability=%v", before)
	}
	if value, err := m.storageLoadU64(id, Uint(2)); err != nil || value.u != 256 {
		t.Fatalf("source changed: value=%v err=%v", value, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	m.ctx = ctx
	if _, err := m.bytesFromStorageU64(id, Uint(0)); errorCode(err) != "cancelled" ||
		m.effects.bytesUsed != 4 || !bytes.Equal(before, m.byteData()) {
		t.Fatalf("cancelled snapshot committed: err=%v arena=%v", err, m.byteData())
	}
}

func snapshotZeroCapacityFixture() Module {
	m := snapshotScalarFixture(true)
	ops := m.Functions[0].Blocks[0].Instructions
	out := make([]Instruction, 0, len(ops))
	for _, ins := range ops {
		if ins.Op != "storage.store_u64" {
			out = append(out, ins)
		}
	}
	m.Functions[0].Blocks[0].Instructions = out
	return m
}

func snapshotFreedFixture() Module {
	m := snapshotScalarFixture(true)
	ops := m.Functions[0].Blocks[0].Instructions
	m.Functions[0].Blocks[0].Instructions = append(append([]Instruction{}, ops[:3]...),
		Instruction{Op: "storage.free", Dest: -1, Args: []int{3}, MayTrap: true})
	m.Functions[0].Blocks[0].Instructions = append(m.Functions[0].Blocks[0].Instructions, ops[3:]...)
	return m
}

func snapshotWrapFixture() Module {
	m := snapshotScalarFixture(false)
	ops := m.Functions[0].Blocks[0].Instructions
	m.Functions[0].Blocks[0].Instructions = append([]Instruction{
		snapshotConst(6, 1), {Op: "add", Dest: 2, Args: []int{2, 6}},
	}, ops...)
	return m
}

func TestBytesSnapshotZeroCapacityAndU64Modulo(t *testing.T) {
	for _, m := range []Module{snapshotZeroCapacityFixture(), snapshotWrapFixture()} {
		e, err := Prepare(m)
		if err != nil {
			t.Fatal(err)
		}
		args := []Value{Uint(0), Uint(0), Uint(256)}
		if m.Functions[0].Blocks[0].Instructions[0].Op == "const" {
			args = []Value{Uint(1), Uint(1), Uint(math.MaxUint64)}
		}
		for name, run := range snapshotRunners(e) {
			result, err := run(context.Background(), "entry", args, 200)
			if err != nil || result.Value.u != 0 {
				t.Fatalf("%s args=%v result=%v err=%v", name, args, result.Value, err)
			}
		}
	}
}

func TestBytesSnapshotValidationOptimizerAndSSA(t *testing.T) {
	m := snapshotScalarFixture(false)
	for _, bad := range []func(*Instruction){
		func(i *Instruction) { i.MayTrap = false },
		func(i *Instruction) { i.Args = i.Args[:1] },
		func(i *Instruction) { i.Args[0] = 5 },
		func(i *Instruction) { i.Dest = 6 },
	} {
		copy := cloneModule(m)
		bad(&copy.Functions[0].Blocks[0].Instructions[3])
		if err := copy.Validate(); err == nil {
			t.Fatal("malformed snapshot accepted")
		}
	}
	optimized, _, err := Optimize(m)
	if err != nil {
		t.Fatal(err)
	}
	snapshots := 0
	for _, ins := range optimized.Functions[0].Blocks[0].Instructions {
		if ins.Op == "bytes.from_storage_u64" {
			snapshots++
			if !ins.MayTrap {
				t.Fatal("optimizer lost memory trap classification")
			}
		}
	}
	if snapshots != 2 {
		t.Fatalf("unused but arena-consuming snapshot removed: %d", snapshots)
	}
	ssa, err := BuildSSA(optimized.Functions[0])
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AnalyzeSSALiveness(ssa); err != nil {
		t.Fatal(err)
	}
	e, err := Prepare(optimized)
	if err != nil {
		t.Fatal(err)
	}
	for name, run := range snapshotRunners(e) {
		result, err := run(context.Background(), "entry", []Value{Uint(2), Uint(2), Uint(65)}, 200)
		if err != nil || result.Value.u != 65 {
			t.Fatalf("%s optimized=%v err=%v", name, result.Value, err)
		}
	}
}

func TestBytesSnapshotEffectsAndContinuation(t *testing.T) {
	m := snapshotFixture()
	f := &m.Functions[0]
	f.EffectVersion, f.Effects = EffectVersion, []string{EffectClockRead, EffectFSRead}
	f.RequiredCapabilities = []CapabilityRequirement{{Name: "clock", Effect: EffectClockRead}, {Name: "read", Effect: EffectFSRead}}
	f.Slots = append(f.Slots, Bytes, Bytes, U64)
	path, _ := ByteSpan(0, 8)
	lit := path.Literal()
	ops := f.Blocks[0].Instructions
	f.Blocks[0].Instructions = append([]Instruction{
		{Op: "const", Dest: 9, Constant: &lit},
		{Op: EffectFSRead, Dest: 10, Args: []int{9}, MayTrap: true},
	}, ops[:4]...)
	f.Blocks[0].Instructions = append(f.Blocks[0].Instructions,
		Instruction{Op: EffectClockRead, Dest: 11, MayTrap: true})
	f.Blocks[0].Instructions = append(f.Blocks[0].Instructions, ops[4:]...)
	e, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	handler := func(_ context.Context, call EffectCall) (EffectReply, error) {
		if call.Effect == EffectFSRead {
			return EffectReply{Sequence: call.Sequence, Effect: call.Effect, Bytes: []byte("read")}, nil
		}
		return EffectReply{Sequence: call.Sequence, Effect: call.Effect, Value: Uint(1)}, nil
	}
	var checkpoint Continuation
	stop := errors.New("checkpoint")
	options := EffectRunOptions{Fuel: 200, MaxBytes: 8, RunID: "snapshot-run", Checkpoint: func(_ context.Context, c Continuation) error {
		if c.EffectCursor == 2 {
			checkpoint = c
			return stop
		}
		return nil
	}}
	_, err = e.RunWithEffects(context.Background(), "entry", []Value{Uint(2), Uint(2), Uint(65)}, options, handler)
	if !errors.Is(err, stop) || checkpoint.EffectBytes != 6 || !bytes.Equal(checkpoint.EffectData, []byte{'r', 'e', 'a', 'd', 65, 0}) {
		t.Fatalf("checkpoint=%+v err=%v", checkpoint, err)
	}
	raw, err := EncodeContinuation(checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeContinuation(raw)
	if err != nil {
		t.Fatal(err)
	}
	options.Checkpoint = nil
	result, err := e.ResumeWithEffects(context.Background(), "entry", decoded, options, func(_ context.Context, call EffectCall) (EffectReply, error) {
		t.Fatalf("replayed effect: %+v", call)
		return EffectReply{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	data, err := result.ResolveBytes(result.Value)
	if err != nil || !bytes.Equal(data, []byte{65, 0}) || !bytes.Equal(result.data[8:], []byte{'r', 'e', 'a', 'd', 65, 0, 90, 0}) {
		t.Fatalf("restored arena=%v data=%v err=%v", result.data, data, err)
	}
	options.MaxBytes = 7
	if _, err := e.RunWithEffects(context.Background(), "entry", []Value{Uint(2), Uint(2), Uint(65)}, options, handler); errorCode(err) != "byte_arena_exhausted" {
		t.Fatalf("shared budget not enforced: %v", err)
	}
}

func TestBytesSnapshotCReferenceParity(t *testing.T) {
	for _, profile := range []NativeProfile{NativeSafe, NativeFast} {
		exe := buildNativeCore(t, snapshotScalarFixture(false), "entry", profile)
		for _, tc := range []struct {
			args []string
			want string
			fail string
		}{
			{[]string{"3", "2", "65"}, "65", ""},
			{[]string{"3", "2", "255"}, "255", ""},
			{[]string{"2", "2", "256"}, "", "invalid_octet"},
			{[]string{"2", "3", "65"}, "", "bounds"},
			{[]string{"2", "18446744073709551615", "65"}, "", "storage_limit"},
			{[]string{"1048577", "1048577", "65"}, "", "byte_arena_exhausted"},
		} {
			out, err := exec.Command(exe, tc.args...).CombinedOutput()
			if tc.fail == "" {
				if err != nil || strings.TrimSpace(string(out)) != tc.want {
					t.Fatalf("%s args=%v out=%q err=%v", profile, tc.args, out, err)
				}
			} else if err == nil || !strings.Contains(string(out), tc.fail) {
				t.Fatalf("%s args=%v out=%q err=%v want=%s", profile, tc.args, out, err, tc.fail)
			}
		}
		emptyExe := buildNativeCore(t, snapshotScalarFixture(true), "entry", profile)
		out, err := exec.Command(emptyExe, "1", "0", "256").CombinedOutput()
		if err != nil || strings.TrimSpace(string(out)) != "0" {
			t.Fatalf("%s empty out=%q err=%v", profile, out, err)
		}
		for _, tc := range []struct {
			module Module
			args   []string
			fail   bool
		}{
			{snapshotZeroCapacityFixture(), []string{"0", "0", "256"}, false},
			{snapshotWrapFixture(), []string{"1", "1", "18446744073709551615"}, false},
			{snapshotFreedFixture(), []string{"1", "0", "65"}, true},
		} {
			exe := buildNativeCore(t, tc.module, "entry", profile)
			out, err := exec.Command(exe, tc.args...).CombinedOutput()
			if tc.fail {
				if err == nil || !strings.Contains(string(out), "storage") {
					t.Fatalf("%s stale out=%q err=%v", profile, out, err)
				}
			} else if err != nil || strings.TrimSpace(string(out)) != "0" {
				t.Fatalf("%s args=%v out=%q err=%v", profile, tc.args, out, err)
			}
		}
	}
}
