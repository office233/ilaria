package coreir_test

import (
	"bytes"
	"context"
	"errors"
	"strconv"
	"testing"

	"swyp-lang/internal/coreir"
)

var errCheckpointStop = errors.New("test stop after durable checkpoint")

func TestContinuationResumesNestedStackAndEffectArenaWithoutReplay(t *testing.T) {
	e := brokerExecutable(t, `
fn leaf()->u64{let b:bytes=read_file("a.txt");return bytes_len(b)+2;}
fn mid()->u64{return leaf()+clock();}
fn f()->u64{return mid()+3;}`, "f")

	uninterruptedCalls := 0
	uninterrupted, err := e.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{Fuel: 200, MaxBytes: 32}, func(_ context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		uninterruptedCalls++
		switch call.Effect {
		case "fs.read":
			return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Bytes: []byte("abc")}, nil
		case "clock.read":
			return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Value: coreir.Uint(10)}, nil
		default:
			t.Fatalf("unexpected effect: %+v", call)
			return coreir.EffectReply{}, nil
		}
	})
	if err != nil || uninterruptedCalls != 2 {
		t.Fatalf("uninterrupted=%+v calls=%d err=%v", uninterrupted, uninterruptedCalls, err)
	}

	var checkpoint coreir.Continuation
	firstCalls := 0
	_, err = e.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{
		Fuel: 200, MaxBytes: 32, RunID: "run-1",
		Checkpoint: func(_ context.Context, c coreir.Continuation) error {
			checkpoint = c
			return errCheckpointStop
		},
	}, func(_ context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		firstCalls++
		if call.Sequence != 1 || call.Effect != "fs.read" || string(call.Path) != "a.txt" {
			t.Fatalf("unexpected first effect: %+v", call)
		}
		return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Bytes: []byte("abc")}, nil
	})
	if !errors.Is(err, errCheckpointStop) || firstCalls != 1 {
		t.Fatalf("checkpoint stop err=%v calls=%d", err, firstCalls)
	}
	if checkpoint.EffectCursor != 1 || checkpoint.EffectBytes != 3 || len(checkpoint.Frames) != 3 {
		t.Fatalf("checkpoint=%+v", checkpoint)
	}
	if checkpoint.ModuleHash != e.ModuleHash() || checkpoint.Entry != "f" || checkpoint.RunID != "run-1" {
		t.Fatalf("checkpoint identity=%+v executable_hash=%s", checkpoint, e.ModuleHash())
	}
	if !checkpoint.Frames[0].AwaitingChild || !checkpoint.Frames[1].AwaitingChild || checkpoint.Frames[2].AwaitingChild {
		t.Fatalf("unexpected call stack flags: %+v", checkpoint.Frames)
	}

	raw, err := coreir.EncodeContinuation(checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := coreir.DecodeContinuation(raw)
	if err != nil {
		t.Fatal(err)
	}

	resumeCalls := 0
	resumed, err := e.ResumeWithEffects(context.Background(), "f", decoded, coreir.EffectRunOptions{
		Fuel: 200, MaxBytes: 32, RunID: "run-1",
	}, func(_ context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		resumeCalls++
		if call.Sequence != 2 || call.Effect != "clock.read" {
			t.Fatalf("effect replay or sequence drift: %+v", call)
		}
		return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Value: coreir.Uint(10)}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	value, ok := resumed.Value.Uint64()
	want, wantOK := uninterrupted.Value.Uint64()
	if !ok || !wantOK || value != want || resumed.Steps != uninterrupted.Steps || resumeCalls != 1 || resumed.Steps <= checkpoint.StepsUsed {
		t.Fatalf("resumed=%+v uninterrupted=%+v value=%d want=%d calls=%d checkpoint_steps=%d", resumed, uninterrupted, value, want, resumeCalls, checkpoint.StepsUsed)
	}
}

func TestContinuationRestoresMutableStorageExactly(t *testing.T) {
	lit := func(v string) *coreir.Literal { return &coreir.Literal{Type: coreir.U64, Value: v} }
	module := coreir.Module{Version: coreir.Version, Functions: []coreir.Function{{
		Name:          "f",
		Result:        coreir.U64,
		EffectVersion: coreir.EffectVersion,
		Effects:       []string{coreir.EffectClockRead},
		RequiredCapabilities: []coreir.CapabilityRequirement{{
			Name: "clock_read", Effect: coreir.EffectClockRead,
		}},
		Slots: []coreir.Type{coreir.U64, coreir.U64, coreir.U64, coreir.U64, coreir.U64, coreir.U64, coreir.U64},
		Blocks: []coreir.Block{{
			Instructions: []coreir.Instruction{
				{Op: "const", Dest: 0, Constant: lit("1")},
				{Op: "storage.alloc_u64", Dest: 1, Args: []int{0}, MayTrap: true},
				{Op: "const", Dest: 2, Constant: lit("7")},
				{Op: "const", Dest: 3, Constant: lit("0")},
				{Op: "storage.store_u64", Dest: -1, Args: []int{1, 3, 2}, MayTrap: true},
				{Op: coreir.EffectClockRead, Dest: 4, MayTrap: true},
				{Op: "storage.load_u64", Dest: 5, Args: []int{1, 3}, MayTrap: true},
				{Op: "add", Dest: 6, Args: []int{4, 5}},
			},
			Terminator: coreir.Terminator{Op: "return", Value: 6},
		}},
	}}}
	e, err := coreir.Prepare(module)
	if err != nil {
		t.Fatal(err)
	}

	var checkpoint coreir.Continuation
	_, err = e.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{
		Fuel: 100, MaxBytes: 0, RunID: "run-1",
		Checkpoint: func(_ context.Context, c coreir.Continuation) error {
			checkpoint = c
			return errCheckpointStop
		},
	}, func(_ context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Value: coreir.Uint(5)}, nil
	})
	if !errors.Is(err, errCheckpointStop) || checkpoint.Storage == nil {
		t.Fatalf("storage checkpoint err=%v checkpoint=%+v", err, checkpoint)
	}

	raw, err := coreir.EncodeContinuation(checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := coreir.DecodeContinuation(raw)
	if err != nil {
		t.Fatal(err)
	}
	resumed, err := e.ResumeWithEffects(context.Background(), "f", decoded, coreir.EffectRunOptions{Fuel: 100, MaxBytes: 0, RunID: "run-1"}, func(_ context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		t.Fatalf("resume unexpectedly replayed an effect: %+v", call)
		return coreir.EffectReply{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	value, ok := resumed.Value.Uint64()
	if !ok || value != 12 {
		t.Fatalf("resumed value=%d result=%+v", value, resumed)
	}

	tampered := checkpoint
	storage := *checkpoint.Storage
	storage.MaxBytes++
	tampered.Storage = &storage
	if _, err := coreir.EncodeContinuation(tampered); brokerCode(err) != "invalid_continuation" {
		t.Fatalf("expanded storage budget accepted: %v", err)
	}
}

func TestContinuationRejectsTamperedStackAndBudget(t *testing.T) {
	e := brokerExecutable(t, `fn f()->u64{return clock()+1;}`, "f")
	var checkpoint coreir.Continuation
	_, err := e.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{
		Fuel: 100, RunID: "run-1",
		Checkpoint: func(_ context.Context, c coreir.Continuation) error {
			checkpoint = c
			return errCheckpointStop
		},
	}, func(_ context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Value: coreir.Uint(1)}, nil
	})
	if !errors.Is(err, errCheckpointStop) {
		t.Fatal(err)
	}

	if _, err := e.ResumeWithEffects(context.Background(), "f", checkpoint, coreir.EffectRunOptions{Fuel: 99, RunID: "run-1"}, nil); brokerCode(err) != "continuation_policy_changed" {
		t.Fatalf("changed budget accepted: %v", err)
	}
	if _, err := e.ResumeWithEffects(context.Background(), "f", checkpoint, coreir.EffectRunOptions{Fuel: 100, MaxBytes: 1, RunID: "run-1"}, nil); brokerCode(err) != "continuation_policy_changed" {
		t.Fatalf("changed byte budget accepted: %v", err)
	}
	if _, err := e.ResumeWithEffects(context.Background(), "f", checkpoint, coreir.EffectRunOptions{Fuel: 100, RunID: "other-run"}, nil); brokerCode(err) != "continuation_identity_mismatch" {
		t.Fatalf("changed run accepted: %v", err)
	}

	tampered := checkpoint
	tampered.Frames = append([]coreir.ContinuationFrame(nil), checkpoint.Frames...)
	tampered.Frames[0].Function = "missing"
	if _, err := e.ResumeWithEffects(context.Background(), "f", tampered, coreir.EffectRunOptions{Fuel: 100, RunID: "run-1"}, nil); brokerCode(err) != "continuation_identity_mismatch" {
		t.Fatalf("tampered function accepted: %v", err)
	}

	tampered = checkpoint
	tampered.Frames = append([]coreir.ContinuationFrame(nil), checkpoint.Frames...)
	tampered.Frames[0].Slots = append([]string(nil), checkpoint.Frames[0].Slots...)
	for i := range tampered.Frames[0].Slots {
		if tampered.Frames[0].Slots[i] != "" {
			tampered.Frames[0].Slots[i] = "bool:0000000000000001"
			break
		}
	}
	if _, err := e.ResumeWithEffects(context.Background(), "f", tampered, coreir.EffectRunOptions{Fuel: 100, RunID: "run-1"}, nil); brokerCode(err) != "invalid_continuation" {
		t.Fatalf("tampered slot accepted: %v", err)
	}

	tampered = checkpoint
	tampered.Frames = append([]coreir.ContinuationFrame(nil), checkpoint.Frames...)
	tampered.Frames[len(tampered.Frames)-1].Instruction = 0
	if _, err := e.ResumeWithEffects(context.Background(), "f", tampered, coreir.EffectRunOptions{Fuel: 100, RunID: "run-1"}, nil); brokerCode(err) != "invalid_continuation" {
		t.Fatalf("non-post-effect PC accepted: %v", err)
	}

	other := brokerExecutable(t, `fn f()->u64{return clock()+2;}`, "f")
	if _, err := other.ResumeWithEffects(context.Background(), "f", checkpoint, coreir.EffectRunOptions{Fuel: 100, RunID: "run-1"}, nil); brokerCode(err) != "continuation_identity_mismatch" {
		t.Fatalf("different module accepted: %v", err)
	}

	raw, err := coreir.EncodeContinuation(checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	for name, corrupt := range map[string][]byte{
		"duplicate": bytes.Replace(raw, []byte(`"version":1`), []byte(`"version":1,"version":1`), 1),
		"unknown":   bytes.Replace(raw, []byte(`"version":1`), []byte(`"unknown":1,"version":1`), 1),
		"trailing":  append(append([]byte(nil), raw...), []byte("{}")...),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := coreir.DecodeContinuation(corrupt); err == nil {
				t.Fatalf("accepted corrupted continuation: %s", corrupt)
			}
		})
	}
}

func TestContinuationPreservesIEEE64RawBits(t *testing.T) {
	for _, bits := range []uint64{0x8000000000000000, 0x7ff8000000000042} {
		t.Run(strconv.FormatUint(bits, 16), func(t *testing.T) {
			lit := func(typ coreir.Type, value string) *coreir.Literal { return &coreir.Literal{Type: typ, Value: value} }
			module := coreir.Module{Version: coreir.Version, Functions: []coreir.Function{{
				Name: "f", Result: coreir.U64, EffectVersion: coreir.EffectVersion,
				Effects:              []string{coreir.EffectClockRead},
				RequiredCapabilities: []coreir.CapabilityRequirement{{Name: "clock_read", Effect: coreir.EffectClockRead}},
				Slots:                []coreir.Type{coreir.U64, coreir.IEEE64, coreir.U64, coreir.U64},
				Blocks: []coreir.Block{{
					Instructions: []coreir.Instruction{
						{Op: "const", Dest: 0, Constant: lit(coreir.U64, strconv.FormatUint(bits, 10))},
						{Op: "bitcast_u64_ieee64", Dest: 1, Args: []int{0}},
						{Op: coreir.EffectClockRead, Dest: 2, MayTrap: true},
						{Op: "bitcast_ieee64_u64", Dest: 3, Args: []int{1}},
					},
					Terminator: coreir.Terminator{Op: "return", Value: 3},
				}},
			}}}
			executable, err := coreir.Prepare(module)
			if err != nil {
				t.Fatal(err)
			}
			var checkpoint coreir.Continuation
			_, err = executable.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{
				Fuel: 100, RunID: "bits-run",
				Checkpoint: func(_ context.Context, c coreir.Continuation) error {
					checkpoint = c
					return errCheckpointStop
				},
			}, func(_ context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
				return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Value: coreir.Uint(1)}, nil
			})
			if !errors.Is(err, errCheckpointStop) {
				t.Fatal(err)
			}
			raw, err := coreir.EncodeContinuation(checkpoint)
			if err != nil {
				t.Fatal(err)
			}
			decoded, err := coreir.DecodeContinuation(raw)
			if err != nil {
				t.Fatal(err)
			}
			resumed, err := executable.ResumeWithEffects(context.Background(), "f", decoded, coreir.EffectRunOptions{Fuel: 100, RunID: "bits-run"}, func(_ context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
				t.Fatalf("resolved effect replayed: %+v", call)
				return coreir.EffectReply{}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			got, ok := resumed.Value.Uint64()
			if !ok || got != bits {
				t.Fatalf("bits=%016x got=%016x ok=%v", bits, got, ok)
			}
		})
	}
}

func TestContinuationRejectsOutOfArenaByteReference(t *testing.T) {
	executable := brokerExecutable(t, `fn f()->u64{let b:bytes=read_file("a");return bytes_len(b);}`, "f")
	var checkpoint coreir.Continuation
	_, err := executable.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{
		Fuel: 100, MaxBytes: 16, RunID: "bytes-run",
		Checkpoint: func(_ context.Context, c coreir.Continuation) error {
			checkpoint = c
			return errCheckpointStop
		},
	}, func(_ context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Bytes: []byte("abc")}, nil
	})
	if !errors.Is(err, errCheckpointStop) {
		t.Fatal(err)
	}
	tampered := checkpoint
	tampered.Frames = append([]coreir.ContinuationFrame(nil), checkpoint.Frames...)
	tampered.Frames[0].Slots = append([]string(nil), checkpoint.Frames[0].Slots...)
	changed := false
	for i, encoded := range tampered.Frames[0].Slots {
		if len(encoded) >= len("bytes:") && encoded[:len("bytes:")] == "bytes:" {
			tampered.Frames[0].Slots[i] = "bytes:ffffffff00000001"
			changed = true
			break
		}
	}
	if !changed {
		t.Fatalf("checkpoint has no bytes slot: %+v", checkpoint.Frames[0])
	}
	if _, err := executable.ResumeWithEffects(context.Background(), "f", tampered, coreir.EffectRunOptions{
		Fuel: 100, MaxBytes: 16, RunID: "bytes-run",
	}, nil); brokerCode(err) != "invalid_continuation" {
		t.Fatalf("out-of-arena byte reference accepted: %v", err)
	}
}

func TestContinuationPreservesFullIntegerWidths(t *testing.T) {
	lit := func(typ coreir.Type, value string) *coreir.Literal { return &coreir.Literal{Type: typ, Value: value} }
	module := coreir.Module{Version: coreir.Version, Functions: []coreir.Function{{
		Name: "f", Result: coreir.U64, EffectVersion: coreir.EffectVersion,
		Effects:              []string{coreir.EffectClockRead},
		RequiredCapabilities: []coreir.CapabilityRequirement{{Name: "clock_read", Effect: coreir.EffectClockRead}},
		Slots:                []coreir.Type{coreir.I64, coreir.U64, coreir.U64, coreir.U64},
		Blocks: []coreir.Block{{
			Instructions: []coreir.Instruction{
				{Op: "const", Dest: 0, Constant: lit(coreir.I64, "-9223372036854775808")},
				{Op: "const", Dest: 1, Constant: lit(coreir.U64, "18446744073709551615")},
				{Op: coreir.EffectClockRead, Dest: 2, MayTrap: true},
				{Op: "bitcast_i64_u64", Dest: 3, Args: []int{0}},
			},
			Terminator: coreir.Terminator{Op: "return", Value: 3},
		}},
	}}}
	executable, err := coreir.Prepare(module)
	if err != nil {
		t.Fatal(err)
	}
	var checkpoint coreir.Continuation
	_, err = executable.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{
		Fuel: 100, RunID: "integer-run",
		Checkpoint: func(_ context.Context, c coreir.Continuation) error {
			checkpoint = c
			return errCheckpointStop
		},
	}, func(_ context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Value: coreir.Uint(1)}, nil
	})
	if !errors.Is(err, errCheckpointStop) {
		t.Fatal(err)
	}
	if len(checkpoint.Frames) != 1 || len(checkpoint.Frames[0].Slots) < 2 ||
		checkpoint.Frames[0].Slots[0] != "i64:8000000000000000" ||
		checkpoint.Frames[0].Slots[1] != "u64:ffffffffffffffff" {
		t.Fatalf("integer slots lost width: %+v", checkpoint.Frames)
	}
	raw, err := coreir.EncodeContinuation(checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := coreir.DecodeContinuation(raw)
	if err != nil {
		t.Fatal(err)
	}
	resumed, err := executable.ResumeWithEffects(context.Background(), "f", decoded, coreir.EffectRunOptions{
		Fuel: 100, RunID: "integer-run",
	}, func(_ context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		t.Fatalf("resolved effect replayed: %+v", call)
		return coreir.EffectReply{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	got, ok := resumed.Value.Uint64()
	if !ok || got != uint64(1)<<63 {
		t.Fatalf("resumed integer=%016x ok=%v", got, ok)
	}
}
