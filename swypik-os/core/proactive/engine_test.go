package proactive

import (
	"testing"
)

func TestProactiveEngine(t *testing.T) {
	eng := NewEngine()
	actions := eng.GetRecentActions()
	if len(actions) == 0 {
		t.Fatal("expected at least one seeded proactive action")
	}

	act := eng.EvaluateContext("Low battery detected while navigating")
	if !act.AutoHandled || len(act.AudioBrief) == 0 {
		t.Errorf("invalid proactive action: %+v", act)
	}

	if len(eng.GetRecentActions()) < 2 {
		t.Errorf("expected at least 2 actions recorded")
	}
}
