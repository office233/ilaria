package ilaria

import (
	"testing"
)

func TestClassifyIntent(t *testing.T) {
	e := NewEngine()

	cases := []struct {
		input    string
		expected IntentType
	}{
		{"search quantum computing", IntentSearch},
		{"cauta cele mai rapide masini", IntentSearch},
		{"open video studio", IntentStudio},
		{"check wallet balance", IntentWallet},
		{"calculate monthly budget", IntentTasks},
		{"call Andrei", IntentConnect},
		{"check shield privacy settings", IntentSettings},
		{"hello there", IntentChat},
	}

	for _, c := range cases {
		got := e.ClassifyIntent(c.input)
		if got != c.expected {
			t.Errorf("For input '%s', expected %s, got %s", c.input, c.expected, got)
		}
	}
}

func TestProcessPrompt(t *testing.T) {
	e := NewEngine()
	e.SetBackend(testBackend{})

	reply, intent := e.ProcessPrompt("search golang 1.26 performance")
	if intent != IntentSearch {
		t.Fatalf("Expected IntentSearch, got %s", intent)
	}

	if reply == "" {
		t.Fatalf("Expected non-empty response")
	}

	history := e.GetHistory()
	if len(history) != 2 {
		t.Fatalf("Expected 2 messages in history, got %d", len(history))
	}
}
