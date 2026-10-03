package coreir_test

import (
	"context"
	"reflect"
	"testing"

	"swyp-lang/internal/coreir"
)

func TestEffectPreflightReportsDetachedTransitiveBindingsWithoutExecuting(t *testing.T) {
	e := brokerExecutable(t, `fn load()->bytes{return read_file("not-opened.txt");} fn now()->u64{return clock();} fn f(x:u64)->u64{return bytes_len(load())+now()+x;}`, "f")
	plan, err := e.PreflightEffects("f")
	if err != nil {
		t.Fatal(err)
	}
	want := coreir.EffectPreflight{
		Entry: "f", Effects: []string{"clock.read", "fs.read"},
		CapabilityBindings: map[string]string{"load/fs.read": "workspace_read", "now/clock.read": "clock_read"},
	}
	if !reflect.DeepEqual(plan, want) {
		t.Fatalf("plan=%+v", plan)
	}
	plan.Effects[0] = "mutated"
	plan.CapabilityBindings["load/fs.read"] = "mutated"
	again, err := e.PreflightEffects("f")
	if err != nil || !reflect.DeepEqual(again, want) {
		t.Fatalf("mutated executable plan=%+v err=%v", again, err)
	}
	// A division trap is checked structurally but must not execute in preflight.
	trapping := brokerExecutable(t, `fn f()->u64{return 1/0;}`, "f")
	pure, err := trapping.PreflightEffects("f")
	if err != nil || pure.Effects == nil || pure.CapabilityBindings == nil || len(pure.Effects) != 0 || len(pure.CapabilityBindings) != 0 {
		t.Fatalf("pure plan=%+v err=%v", pure, err)
	}
	if _, err := trapping.Run(context.Background(), "f", nil, 100); brokerCode(err) != "division_by_zero" {
		t.Fatalf("test fixture does not trap: %v", err)
	}
}

func TestEffectPreflightSharesUnsupportedAndAmbiguousExecutionChecks(t *testing.T) {
	unsupported := brokerExecutable(t, `fn f()->u64{return random();}`, "f")
	if _, err := unsupported.PreflightEffects("f"); brokerCode(err) != "unsupported_effect" {
		t.Fatalf("unsupported plan: %v", err)
	}
	module := coreir.Module{Version: 1, Functions: []coreir.Function{{
		Name: "f", Result: coreir.U64, EffectVersion: 1, Effects: []string{"clock.read"},
		RequiredCapabilities: []coreir.CapabilityRequirement{{Name: "a", Effect: "clock.read"}, {Name: "b", Effect: "clock.read"}},
		Slots:                []coreir.Type{coreir.U64}, Blocks: []coreir.Block{{Instructions: []coreir.Instruction{{Op: "clock.read", Dest: 0, MayTrap: true}}, Terminator: coreir.Terminator{Op: "return", Value: 0}}},
	}}}
	ambiguous, err := coreir.Prepare(module)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ambiguous.PreflightEffects("f"); brokerCode(err) != "ambiguous_capability" {
		t.Fatalf("ambiguous plan: %v", err)
	}
	if _, err := unsupported.PreflightEffects("missing"); brokerCode(err) != "unknown_function" {
		t.Fatalf("unknown entry: %v", err)
	}
	var absent *coreir.Executable
	if _, err := absent.PreflightEffects("f"); brokerCode(err) != "invalid_ir" {
		t.Fatalf("nil executable: %v", err)
	}
}
