package ilaria

import (
	"context"
	"fmt"
	"testing"

	resourcepolicy "swypik-os/core/resource"
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

func TestPhoneProfileBoundsChatHistory(t *testing.T) {
	t.Setenv("SWYPIK_RESOURCE_PROFILE", "phone")
	e := NewEngine()
	e.SetBackend(testBackend{})
	for i := 0; i < 25; i++ {
		if _, err := e.ProcessPromptContext(context.Background(), fmt.Sprintf("prompt-%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	h := e.GetHistory()
	want := resourcepolicy.ForProfile(resourcepolicy.ProfilePhone).MaxChatHistoryMessages
	if len(h) != want {
		t.Fatalf("history=%d want %d", len(h), want)
	}
	oldestPrompt := 25 - want/2
	wantOldest := fmt.Sprintf("prompt-%d", oldestPrompt)
	if h[0].Text != wantOldest {
		t.Fatalf("oldest retained prompt=%q want %q", h[0].Text, wantOldest)
	}
}
