package proactive

import "testing"

func TestContextIsAnOwnedBoundedObservation(t *testing.T) {
	e := NewEngine()
	e.maxActions = 2
	if e.EvaluateContext("  ") != nil {
		t.Fatal("empty context created an action")
	}
	first := e.EvaluateContext("first")
	first.AutoHandled, first.Description = true, "mutated"
	if got := e.GetRecentActions()[0]; got.AutoHandled || got.Description != "first" {
		t.Fatal("returned context aliases internal state")
	}
	e.EvaluateContext("second")
	e.EvaluateContext("third")
	got := e.GetRecentActions()
	if len(got) != 2 || got[0].Description != "second" || got[1].Description != "third" {
		t.Fatalf("history is not bounded: %+v", got)
	}
	for _, action := range got {
		if action.AutoHandled || !action.ExecutedAt.IsZero() || action.ObservedAt.IsZero() {
			t.Fatalf("observation claims execution: %+v", action)
		}
	}
	got[0].Description = "mutated"
	if e.GetRecentActions()[0].Description != "second" {
		t.Fatal("history result aliases internal state")
	}
}
