package coreir_test

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/swyplang"
)

func brokerExecutable(t *testing.T, source, entry string) *coreir.Executable {
	t.Helper()
	p, err := swyplang.ParseCore("broker.swyp", source+" fn main(){}")
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CoreIR(entry)
	if err != nil {
		t.Fatal(err)
	}
	e, err := coreir.Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func brokerCode(err error) string {
	var d *coreir.Diagnostic
	if errors.As(err, &d) {
		return d.Code
	}
	if err == nil {
		return ""
	}
	return err.Error()
}

func TestBrokerExecutionPreservesPureValuesAndExactFuel(t *testing.T) {
	e := brokerExecutable(t, `fn f(x:u64)->u64{return x*2+3;}`, "f")
	for fuel := 1; fuel < 32; fuel++ {
		plain, plainErr := e.Run(context.Background(), "f", []coreir.Value{coreir.Uint(7)}, fuel)
		brokered, brokerErr := e.RunWithEffects(context.Background(), "f", []coreir.Value{coreir.Uint(7)}, coreir.EffectRunOptions{Fuel: fuel}, nil)
		if !reflect.DeepEqual(plain, brokered.RunResult) || brokerCode(plainErr) != brokerCode(brokerErr) {
			t.Fatalf("fuel %d: plain=%+v/%v brokered=%+v/%v", fuel, plain, plainErr, brokered.RunResult, brokerErr)
		}
	}
}

func TestBrokerClockResumesNestedCallsWithExactInteger(t *testing.T) {
	e := brokerExecutable(t, `fn pure(x:u64)->u64{return x+2;} fn helper()->u64{return pure(clock());} fn f()->u64{return helper()+3;}`, "f")
	calls := 0
	r, err := e.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{Fuel: 100}, func(ctx context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		calls++
		if ctx == nil || call.Sequence != 1 || call.Function != "helper" || call.Effect != "clock.read" || call.Requirement != "clock_read" || call.ResultType != coreir.U64 || call.Path != nil {
			t.Fatalf("unexpected call: %+v", call)
		}
		return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Value: coreir.Uint(9007199254740993)}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if value, _ := r.Value.Uint64(); value != 9007199254740998 || calls != 1 {
		t.Fatalf("result=%+v calls=%d", r, calls)
	}
	if _, err := e.Run(context.Background(), "f", nil, 100); brokerCode(err) != "effectful_program" {
		t.Fatalf("pure boundary changed: %v", err)
	}
}

func TestBrokerReadBytesAreOwnedAndExecutableIsReusable(t *testing.T) {
	e := brokerExecutable(t, `fn f()->bytes{return read_file("input.txt");}`, "f")
	response := []byte("hello")
	handler := func(ctx context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		if string(call.Path) != "input.txt" || call.Requirement != "workspace_read" || call.ResultType != coreir.Bytes {
			t.Fatalf("unexpected call: %+v", call)
		}
		call.Path[0] = 'X'
		return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Bytes: response}, nil
	}
	r, err := e.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{Fuel: 100, MaxBytes: 5}, handler)
	if err != nil {
		t.Fatal(err)
	}
	response[0] = 'Y'
	data, err := r.ResolveBytes(r.Value)
	if err != nil || string(data) != "hello" {
		t.Fatalf("owned bytes=%q err=%v", data, err)
	}
	data[0] = 'Z'
	again, _ := r.ResolveBytes(r.Value)
	if string(again) != "hello" {
		t.Fatalf("resolver returned mutable alias: %q", again)
	}
	if _, err := e.ResolveBytes(r.Value); brokerCode(err) != "invalid_bytespan" {
		t.Fatalf("runtime bytes leaked into immutable executable: %v", err)
	}
	if _, err := e.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{Fuel: 100, MaxBytes: 5}, handler); err != nil {
		t.Fatalf("reused executable: %v", err)
	}
}

func TestBrokerReadBytesSupportPureOperationsAndCumulativeBudget(t *testing.T) {
	e := brokerExecutable(t, `fn first(b:bytes)->u64{return bytes_get(b,0)+bytes_len(b);} fn f()->u64{let a:bytes=read_file("a");let b:bytes=read_file("b");return first(a)+first(b);}`, "f")
	for _, test := range []struct {
		budget int
		code   string
	}{{5, ""}, {4, "effect_bytes_exhausted"}, {0, "effect_bytes_exhausted"}} {
		calls := 0
		r, err := e.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{Fuel: 100, MaxBytes: test.budget}, func(ctx context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
			calls++
			data := []byte("AB")
			if calls == 2 {
				data = []byte("xyz")
				if call.Sequence != 2 || call.MaxBytes != test.budget-2 {
					t.Fatalf("second budget: %+v", call)
				}
			}
			return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Bytes: data}, nil
		})
		if brokerCode(err) != test.code {
			t.Fatalf("budget %d: %+v/%v", test.budget, r, err)
		}
		if err == nil {
			if value, _ := r.Value.Uint64(); value != 190 || calls != 2 {
				t.Fatalf("result=%+v calls=%d", r, calls)
			}
		}
	}
}

func TestBrokerRejectsMismatchedAndUntypedResults(t *testing.T) {
	e := brokerExecutable(t, `fn f()->u64{return clock();}`, "f")
	for _, test := range []struct {
		name   string
		mutate func(*coreir.EffectReply)
		code   string
	}{
		{"sequence", func(r *coreir.EffectReply) { r.Sequence++ }, "effect_result_mismatch"},
		{"effect", func(r *coreir.EffectReply) { r.Effect = "fs.read" }, "effect_result_mismatch"},
		{"type", func(r *coreir.EffectReply) { r.Value = coreir.Int(1) }, "type_mismatch"},
		{"bytes", func(r *coreir.EffectReply) { r.Bytes = []byte{} }, "type_mismatch"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := e.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{Fuel: 100}, func(ctx context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
				reply := coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Value: coreir.Uint(1)}
				test.mutate(&reply)
				return reply, nil
			})
			if brokerCode(err) != test.code {
				t.Fatal(err)
			}
		})
	}
	bytes := brokerExecutable(t, `fn f()->bytes{return read_file("a");}`, "f")
	_, err := bytes.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{Fuel: 100, MaxBytes: 1}, func(ctx context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		view, _ := coreir.ByteSpan(0, 0)
		return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Value: view, Bytes: []byte("a")}, nil
	})
	if brokerCode(err) != "type_mismatch" {
		t.Fatalf("host descriptor accepted: %v", err)
	}
}

func TestBrokerCancellationAndFuelDoNotResumeAfterEffect(t *testing.T) {
	e := brokerExecutable(t, `fn f()->u64{return clock();}`, "f")
	for _, fuel := range []int{1, 2, 3} {
		calls := 0
		_, err := e.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{Fuel: fuel}, func(ctx context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
			calls++
			return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Value: coreir.Uint(1)}, nil
		})
		wantCalls := 1
		wantCode := ""
		if fuel == 1 {
			wantCalls = 0
		}
		if fuel < 3 {
			wantCode = "fuel_exhausted"
		}
		if calls != wantCalls || brokerCode(err) != wantCode {
			t.Fatalf("fuel %d: calls=%d err=%v", fuel, calls, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	_, err := e.RunWithEffects(ctx, "f", nil, coreir.EffectRunOptions{Fuel: 100}, func(ctx context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		cancel()
		return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Value: coreir.Uint(1)}, nil
	})
	if brokerCode(err) != "cancelled" {
		t.Fatalf("cancelled handler resumed: %v", err)
	}
	_, err = e.RunWithEffects(ctx, "f", nil, coreir.EffectRunOptions{Fuel: 100}, func(ctx context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		t.Fatal("cancelled run invoked handler")
		return coreir.EffectReply{}, nil
	})
	if brokerCode(err) != "cancelled" {
		t.Fatal(err)
	}
}

func TestBrokerPreflightRejectsUnsupportedAmbiguousAndAbsentHandlers(t *testing.T) {
	unsupported := brokerExecutable(t, `fn f()->u64{return random();}`, "f")
	_, err := unsupported.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{Fuel: 100}, func(ctx context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		t.Fatal("unsupported entry invoked handler")
		return coreir.EffectReply{}, nil
	})
	if brokerCode(err) != "unsupported_effect" {
		t.Fatal(err)
	}
	e := brokerExecutable(t, `fn f()->u64{return clock();}`, "f")
	_, err = e.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{Fuel: 100}, nil)
	if brokerCode(err) != "effect_handler_required" {
		t.Fatal(err)
	}
	m := coreir.Module{Version: 1, Functions: []coreir.Function{{
		Name: "f", Result: coreir.U64, EffectVersion: 1, Effects: []string{"clock.read"},
		RequiredCapabilities: []coreir.CapabilityRequirement{{Name: "a", Effect: "clock.read"}, {Name: "b", Effect: "clock.read"}},
		Slots:                []coreir.Type{coreir.U64}, Blocks: []coreir.Block{{Instructions: []coreir.Instruction{{Op: "clock.read", Dest: 0, MayTrap: true}}, Terminator: coreir.Terminator{Op: "return", Value: 0}}},
	}}}
	ambiguous, err := coreir.Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	_, err = ambiguous.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{Fuel: 100}, func(ctx context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		t.Fatal("ambiguous entry invoked handler")
		return coreir.EffectReply{}, nil
	})
	if brokerCode(err) != "ambiguous_capability" {
		t.Fatal(err)
	}
}

func TestBrokerConcurrentRunsKeepIndependentArenasAndSequences(t *testing.T) {
	e := brokerExecutable(t, `fn f()->bytes{return read_file("a");}`, "f")
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r, err := e.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{Fuel: 100, MaxBytes: 1}, func(ctx context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
				if call.Sequence != 1 {
					t.Errorf("sequence=%d", call.Sequence)
				}
				return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Bytes: []byte{byte(i)}}, nil
			})
			if err != nil {
				t.Error(err)
				return
			}
			data, err := r.ResolveBytes(r.Value)
			if err != nil || len(data) != 1 || data[0] != byte(i) {
				t.Errorf("bytes=%v err=%v", data, err)
			}
		}(i)
	}
	wg.Wait()
}

func TestBrokerRuntimeBytesCanBecomeNextPathAndStillTrap(t *testing.T) {
	e := brokerExecutable(t, `fn f()->u64{let path:bytes=read_file("path.txt");let content:bytes=read_file(path);return bytes_get(content,2);}`, "f")
	calls := 0
	_, err := e.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{Fuel: 100, MaxBytes: 10}, func(ctx context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		calls++
		data := []byte("next.txt")
		if calls == 2 {
			if string(call.Path) != "next.txt" {
				t.Fatalf("runtime path=%q", call.Path)
			}
			data = []byte("ab")
		}
		return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect, Bytes: data}, nil
	})
	var diagnostic *coreir.Diagnostic
	if brokerCode(err) != "bounds" || calls != 2 || !errors.As(err, &diagnostic) || diagnostic.Location.File != "broker.swyp" || diagnostic.Location.Line != 1 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
	empty := brokerExecutable(t, `fn f()->u64{return bytes_len(read_file("empty.txt"));}`, "f")
	r, err := empty.RunWithEffects(context.Background(), "f", nil, coreir.EffectRunOptions{Fuel: 100, MaxBytes: 0}, func(ctx context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		return coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect}, nil
	})
	if value, _ := r.Value.Uint64(); err != nil || value != 0 {
		t.Fatalf("empty result=%+v err=%v", r, err)
	}
}
