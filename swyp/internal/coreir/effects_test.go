package coreir

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func effectfulModule() Module {
	return Module{Version: Version, Functions: []Function{{
		Name:          "inspect",
		Params:        []Parameter{{Name: "x", Type: I64}},
		Result:        I64,
		EffectVersion: EffectVersion,
		Effects:       []string{"fs.read"},
		RequiredCapabilities: []CapabilityRequirement{{
			Name: "workspace_read", Effect: "fs.read",
		}},
		Slots:  []Type{I64},
		Blocks: []Block{{Terminator: Terminator{Op: "return", Value: 0}}},
	}}}
}

func effectContract() Contract {
	return Contract{
		Version:       1,
		Entry:         "inspect",
		Inputs:        []Domain{{Name: "x", Type: I64, Min: "0", Max: "0"}},
		Ensures:       []Predicate{{Op: "eq", Args: []Predicate{{Variable: "result"}, {Variable: "x"}}}},
		EffectVersion: EffectVersion,
		Effects:       []string{"fs.read"},
		MaxSteps:      32,
	}
}

func TestEffectMetadataRoundTripPrepareAndExecutorBoundary(t *testing.T) {
	m := effectfulModule()
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := Decode(data)
	if err != nil {
		t.Fatal(err)
	}
	data2, err := json.Marshal(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string(data2) {
		t.Fatalf("effect IR round-trip is not canonical:\n%s\n%s", data, data2)
	}
	e, err := Prepare(decoded)
	if err != nil {
		t.Fatal(err)
	}
	semantics, err := e.Semantics("inspect")
	if err != nil {
		t.Fatal(err)
	}
	if semantics.Purity != "effectful" || semantics.EffectVersion != EffectVersion || len(semantics.Effects) != 1 || semantics.Effects[0] != "fs.read" || len(semantics.RequiredCapabilities) != 1 {
		t.Fatalf("unexpected semantics: %+v", semantics)
	}
	semantics.Effects[0] = "fs.write"
	semantics.RequiredCapabilities[0].Name = "mutated"
	again, _ := e.Semantics("inspect")
	if again.Effects[0] != "fs.read" || again.RequiredCapabilities[0].Name != "workspace_read" {
		t.Fatal("prepared effect metadata did not retain ownership")
	}
	if _, err := e.Run(context.Background(), "inspect", []Value{Int(0)}, 32); errorCode(err) != "effectful_program" {
		t.Fatalf("effectful program reached Core executor: %v", err)
	}
}

func TestEffectVerifierReportDoesNotExecuteHostEffects(t *testing.T) {
	e, err := Prepare(effectfulModule())
	if err != nil {
		t.Fatal(err)
	}
	report, err := Verify(context.Background(), e, effectContract(), DefaultVerifyOptions())
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "unknown" || report.Method != "effect-contract-validation" || report.Reason != "effectful_execution_not_supported" || report.Purity != "effectful" || report.CasesExamined != 0 || report.CasesChecked != 0 || report.StepsConsumed != 0 {
		t.Fatalf("unexpected effectful verification report: %+v", report)
	}
	if len(report.Effects) != 1 || report.Effects[0] != "fs.read" || len(report.RequiredCapabilities) != 1 || report.RequiredCapabilities[0].Name != "workspace_read" {
		t.Fatalf("missing effect metadata in report: %+v", report)
	}
	c := effectContract()
	c.EffectVersion = 0
	c.Effects = nil
	if _, err := Verify(context.Background(), e, c, DefaultVerifyOptions()); err == nil {
		t.Fatal("effectful executable accepted a pure contract")
	}
}

func TestEffectValidationFailsClosed(t *testing.T) {
	mutations := map[string]func(*Module){
		"unknown effect": func(m *Module) {
			m.Functions[0].Effects[0] = "host.exec"
			m.Functions[0].RequiredCapabilities[0].Effect = "host.exec"
		},
		"wrong version": func(m *Module) { m.Functions[0].EffectVersion = 2 },
		"duplicate effect": func(m *Module) {
			m.Functions[0].Effects = []string{"fs.read", "fs.read"}
		},
		"noncanonical effects": func(m *Module) {
			m.Functions[0].Effects = []string{"fs.write", "fs.read"}
			m.Functions[0].RequiredCapabilities = []CapabilityRequirement{{Name: "workspace_write", Effect: "fs.write"}, {Name: "workspace_read", Effect: "fs.read"}}
		},
		"missing capability":           func(m *Module) { m.Functions[0].RequiredCapabilities = nil },
		"malformed capability":         func(m *Module) { m.Functions[0].RequiredCapabilities[0].Name = "cap://attacker" },
		"undeclared capability effect": func(m *Module) { m.Functions[0].RequiredCapabilities[0].Effect = "net.fetch" },
		"duplicate capability name": func(m *Module) {
			m.Functions[0].Effects = []string{"fs.read", "fs.write"}
			m.Functions[0].RequiredCapabilities = []CapabilityRequirement{{Name: "workspace", Effect: "fs.read"}, {Name: "workspace", Effect: "fs.write"}}
		},
		"noncanonical capabilities": func(m *Module) {
			m.Functions[0].RequiredCapabilities = []CapabilityRequirement{{Name: "z", Effect: "fs.read"}, {Name: "a", Effect: "fs.read"}}
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			m := effectfulModule()
			mutate(&m)
			if err := m.Validate(); err == nil {
				t.Fatal("accepted invalid effect/capability metadata")
			}
		})
	}

	pure := absModule()
	pure.Functions[0].RequiredCapabilities = []CapabilityRequirement{{Name: "workspace_read", Effect: "fs.read"}}
	if err := pure.Validate(); err == nil {
		t.Fatal("pure function accepted capability requirement")
	}
	pure = absModule()
	pure.Functions[0].EffectVersion = EffectVersion
	if err := pure.Validate(); err == nil {
		t.Fatal("pure function accepted noncanonical effect version")
	}
}

func TestCapabilityFabricationIsNotRepresentableInCoreIR(t *testing.T) {
	data, err := json.Marshal(effectfulModule())
	if err != nil {
		t.Fatal(err)
	}
	withRefs := strings.Replace(string(data), `"required_capabilities":`, `"capability_refs":["cap_secret"],"required_capabilities":`, 1)
	if _, err := Decode([]byte(withRefs)); err == nil || errorCode(err) != "invalid_json" {
		t.Fatalf("guest capability_refs were not rejected: %v", err)
	}
	withToken := strings.Replace(string(data), `"effect":"fs.read"}`, `"effect":"fs.read","token":"cap_secret"}`, 1)
	if _, err := Decode([]byte(withToken)); err == nil || errorCode(err) != "invalid_json" {
		t.Fatalf("guest capability token was not rejected: %v", err)
	}
}

func TestEffectCallGraphPropagation(t *testing.T) {
	leaf := effectfulModule().Functions[0]
	leaf.Name = "leaf"
	caller := Function{
		Name:   "caller",
		Params: []Parameter{{Name: "x", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "call", Dest: 1, Args: []int{0}, Callee: "leaf", MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 1},
		}},
	}
	m := Module{Version: Version, Functions: []Function{caller, leaf}}
	if err := m.Validate(); err == nil || !strings.Contains(err.Error(), "propagated effect") {
		t.Fatalf("missing effect propagation was not rejected: %v", err)
	}
	m.Functions[0].EffectVersion = EffectVersion
	m.Functions[0].Effects = []string{"fs.read"}
	m.Functions[0].RequiredCapabilities = []CapabilityRequirement{{Name: "workspace_read", Effect: "fs.read"}}
	if err := m.Validate(); err != nil {
		t.Fatalf("valid propagated effect metadata rejected: %v", err)
	}
}

func TestPureCoreIRBackwardCompatibilityAndRegistry(t *testing.T) {
	legacyPure := `{"version":1,"functions":[{"name":"identity","params":[{"name":"x","type":"i64"}],"result":"i64","effects":[],"slots":["i64"],"blocks":[{"terminator":{"op":"return","value":0,"location":{}}}]}]}`
	m, err := Decode([]byte(legacyPure))
	if err != nil {
		t.Fatal(err)
	}
	e, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	semantics, err := e.Semantics("identity")
	if err != nil || semantics.Purity != "pure" || semantics.EffectVersion != 0 || len(semantics.Effects) != 0 || len(semantics.RequiredCapabilities) != 0 {
		t.Fatalf("legacy pure semantics changed: %+v %v", semantics, err)
	}
	result, err := e.Run(context.Background(), "identity", []Value{Int(7)}, 16)
	value, ok := result.Value.Int64()
	if err != nil || !ok || value != 7 {
		t.Fatalf("legacy pure execution changed: %+v %v", result, err)
	}
	want := []string{"clock.read", "fs.read", "fs.write", "model.infer", "net.connect", "net.fetch", "process.exec", "rng.sample", "tool.call"}
	got := CanonicalEffectRegistry()
	if len(got) != len(want) {
		t.Fatalf("effect registry mismatch: %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("effect registry is not stable: %v", got)
		}
	}
}
