package swypbroker

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"testing"
)

func TestPolicyResolverScopesGrantToCapabilityTargetAndSymbol(t *testing.T) {
	resolver := NewPolicyResolver()
	grant := NewGrant("opaque-native-math-grant")
	if err := resolver.Grant("native_math", "c_add", "c_add", grant); err != nil {
		t.Fatal(err)
	}
	auth := Authorization{Target: "c_add", Symbol: "c_add", Capability: CapabilityRequirement{Name: "native_math", Effect: ForeignCallEffect}}
	got, err := resolver.Resolve(context.Background(), auth)
	if err != nil || got.Value() != "opaque-native-math-grant" {
		t.Fatalf("grant=%v err=%v", got.Value(), err)
	}

	for name, mutate := range map[string]func(*Authorization){
		"capability": func(a *Authorization) { a.Capability.Name = "native_other" },
		"target":     func(a *Authorization) { a.Target = "other_target" },
		"symbol":     func(a *Authorization) { a.Symbol = "other_symbol" },
		"effect":     func(a *Authorization) { a.Capability.Effect = "fs.read" },
	} {
		t.Run(name, func(t *testing.T) {
			changed := auth
			mutate(&changed)
			if _, err := resolver.Resolve(context.Background(), changed); err != ErrCapabilityDenied {
				t.Fatalf("unexpected resolve error: %v", err)
			}
		})
	}
	if !resolver.Revoke("native_math", "c_add", "c_add") {
		t.Fatal("revoke failed")
	}
	if _, err := resolver.Resolve(context.Background(), auth); err != ErrCapabilityDenied {
		t.Fatalf("revoked grant still resolved: %v", err)
	}
}

func TestAdapterRegistryRequiresExactPreRegistration(t *testing.T) {
	registry := NewAdapterRegistry()
	called := 0
	if err := registry.Register("c_add", "c_add", "C", "swyp-c64-v1", func(_ context.Context, invocation Invocation) (WireValue, error) {
		called++
		if invocation.Grant.Value() != "grant" {
			t.Fatalf("grant=%v", invocation.Grant.Value())
		}
		data := make([]byte, 8)
		binary.LittleEndian.PutUint64(data, 42)
		return WireValue{Type: invocation.Result, Encoding: WireEncoding, Data: base64.StdEncoding.EncodeToString(data)}, nil
	}); err != nil {
		t.Fatal(err)
	}
	invocation := Invocation{Target: "c_add", Symbol: "c_add", ABI: "C", ABIVersion: "swyp-c64-v1", Result: ABIType{Kind: "i64", Size: 8, Align: 8}, Grant: NewGrant("grant")}
	if _, err := registry.Execute(context.Background(), invocation); err != nil {
		t.Fatal(err)
	}
	if called != 1 {
		t.Fatalf("called=%d", called)
	}
	invocation.Symbol = "attacker_symbol"
	if _, err := registry.Execute(context.Background(), invocation); err == nil {
		t.Fatal("unregistered symbol reached adapter")
	}
}

func TestConcretePolicyAndAdapterEndToEnd(t *testing.T) {
	plans := NewRegistry()
	if _, err := plans.ApproveJSON(loadFixture(t, "swyp_scalar_plan_v1.json")); err != nil {
		t.Fatal(err)
	}
	resolver := NewPolicyResolver()
	if err := resolver.Grant("native_math", "c_add", "c_add", NewGrant(struct{ scope string }{scope: "math"})); err != nil {
		t.Fatal(err)
	}
	adapters := NewAdapterRegistry()
	if err := adapters.Register("c_add", "c_add", "C", "swyp-c64-v1", func(_ context.Context, invocation Invocation) (WireValue, error) {
		if invocation.Grant.Value().(struct{ scope string }).scope != "math" {
			t.Fatal("wrong host grant")
		}
		left, _ := base64.StdEncoding.DecodeString(invocation.Arguments[0].Data)
		right, _ := base64.StdEncoding.DecodeString(invocation.Arguments[1].Data)
		sum := int64(binary.LittleEndian.Uint64(left)) + int64(binary.LittleEndian.Uint64(right))
		data := make([]byte, 8)
		binary.LittleEndian.PutUint64(data, uint64(sum))
		return WireValue{Type: invocation.Result, Encoding: WireEncoding, Data: base64.StdEncoding.EncodeToString(data)}, nil
	}); err != nil {
		t.Fatal(err)
	}
	broker, err := New(plans, resolver, adapters)
	if err != nil {
		t.Fatal(err)
	}
	response, err := broker.Dispatch(context.Background(), "host-exec-001", loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != "ok" || response.Result == nil {
		t.Fatalf("response=%+v", response)
	}
	data, _ := base64.StdEncoding.DecodeString(response.Result.Data)
	if got := int64(binary.LittleEndian.Uint64(data)); got != 9007199254740995 {
		t.Fatalf("result=%d", got)
	}
}
