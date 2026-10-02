package proactive

import (
	"testing"
)

func TestProactiveEngine(t *testing.T) {
	eng := NewEngine()
	actions := eng.GetRecentActions()
	if len(actions) != 0 {
		t.Fatal("new engine invented user actions")
	}

	act := eng.EvaluateContext("Low battery detected while navigating")
	if act.AutoHandled || !act.ExecutedAt.IsZero() || act.Status != "REQUIRES_REVIEW" || len(act.AudioBrief) == 0 {
		t.Errorf("invalid proactive action: %+v", act)
	}

	if len(eng.GetRecentActions()) != 1 {
		t.Errorf("expected one real context observation")
	}
}
