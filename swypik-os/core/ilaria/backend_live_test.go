package ilaria

import (
	"context"
	"os"
	"strings"
	"testing"
)

// Opt-in integration check; the caller must start the local model service.
func TestLiveIlariaBackend(t *testing.T) {
	endpoint := os.Getenv("SWYPIK_ILARIA_TEST_URL")
	if endpoint == "" {
		t.Skip("set SWYPIK_ILARIA_TEST_URL to verify a running local model")
	}
	answer, err := NewLocalBackend(endpoint).Chat(context.Background(), "What project name did I give you?", []Message{
		{Sender: "user", Text: "My project is named SwypikOS."},
		{Sender: "ilaria", Text: "Your project is named SwypikOS."},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.ToLower(answer), "swypikos") {
		t.Fatalf("history not recalled: %s", answer)
	}
	t.Logf("real model reply: %s", answer)
}
