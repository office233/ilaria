package ilaria

import (
	"context"
	"testing"
)

func TestUnconfiguredEngineFailsExplicitly(t *testing.T) {
	e := NewEngine()
	if _, err := e.ProcessPromptContext(context.Background(), "salut"); err == nil {
		t.Fatal("an engine without a backend must not answer")
	}
	if len(e.GetHistory()) != 0 {
		t.Fatal("failed turn stored")
	}
}

func TestProcessPromptRecordsExchange(t *testing.T) {
	e := NewEngine()
	e.SetBackend(testBackend{})
	reply, err := e.ProcessPromptContext(context.Background(), "search golang performance")
	if err != nil || reply == "" {
		t.Fatalf("reply=%q err=%v", reply, err)
	}
	if h := e.GetHistory(); len(h) != 2 || h[0].Sender != "user" || h[1].Sender != "ilaria" {
		t.Fatalf("history=%+v", h)
	}
	if _, err := e.Complete(context.Background(), "plan"); err != nil {
		t.Fatal(err)
	}
	if len(e.GetHistory()) != 2 {
		t.Fatal("Complete must not change chat history")
	}
	e.ClearHistory()
	if len(e.GetHistory()) != 0 {
		t.Fatal("history not cleared")
	}
}
