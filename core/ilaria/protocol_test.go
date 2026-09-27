package ilaria

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestFitsNexusLimitByDroppingOldestCompleteTurns(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if len(body) > 64*1024 {
			t.Errorf("request too large: %d", len(body))
		}
		var request struct {
			Prompt  string
			History []struct{ Role, Content string }
		}
		if err := json.Unmarshal(body, &request); err != nil {
			t.Error(err)
		}
		if request.Prompt != "current" || len(request.History) != 2 || request.History[0].Content != "recent" || request.History[1].Role != "assistant" {
			t.Errorf("wrong retained history: %d turns", len(request.History))
		}
		fmt.Fprint(w, `{"reply":"ok"}`)
	}))
	defer server.Close()
	_, err := NewLocalBackend(server.URL).Chat(context.Background(), "current", []Message{
		{Sender: "user", Text: strings.Repeat("<", 12000)}, // JSON escaping expands each character to six bytes.
		{Sender: "ilaria", Text: "old answer"},
		{Sender: "user", Text: "recent"},
		{Sender: "ilaria", Text: "recent answer"},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestInvalidRequestNeverReachesNexus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("invalid request reached server") }))
	defer server.Close()
	backend := NewLocalBackend(server.URL)
	for _, history := range [][]Message{
		{{Sender: "user", Text: "unpaired"}},
		{{Sender: "ilaria", Text: "wrong"}, {Sender: "user", Text: "order"}},
	} {
		if _, err := backend.Chat(context.Background(), "hello", history); err == nil {
			t.Fatal("invalid history accepted")
		}
	}
	if _, err := backend.Chat(context.Background(), strings.Repeat("<", 12000), nil); err == nil {
		t.Fatal("oversized prompt accepted")
	}
}

func TestMalformedAndOversizedResponsesAreRejected(t *testing.T) {
	for _, body := range []string{`{"reply":"ok"}{"reply":"another"}`, `{"reply":"ok"}` + strings.Repeat(" ", 128*1024)} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
		_, err := NewLocalBackend(server.URL).Chat(context.Background(), "hello", nil)
		server.Close()
		if err == nil {
			t.Fatal("malformed/oversized response accepted")
		}
	}
}
