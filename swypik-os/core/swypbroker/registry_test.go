package swypbroker

import "testing"

func TestRegistryApprovesImmutablePlanAndRevokes(t *testing.T) {
	registry := NewRegistry()
	plan, err := registry.ApproveJSON(loadFixture(t, "swyp_scalar_plan_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if registry.Count() != 1 {
		t.Fatalf("count=%d", registry.Count())
	}
	got, ok := registry.Lookup(plan.PlanID)
	if !ok {
		t.Fatal("approved plan not found")
	}
	got.ForeignCalls[0].Symbol = "mutated"
	again, ok := registry.Lookup(plan.PlanID)
	if !ok || again.ForeignCalls[0].Symbol != "c_add" {
		t.Fatalf("registry exposed mutable plan: %+v", again)
	}
	if !registry.Revoke(plan.PlanID) || registry.Count() != 0 {
		t.Fatal("plan revoke failed")
	}
	if registry.Revoke(plan.PlanID) {
		t.Fatal("second revoke unexpectedly succeeded")
	}
}
