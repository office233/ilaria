package ilaria

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type testBackend struct{}

func (testBackend) Chat(_ context.Context, p string, _ []Message) (string, error) {
	return "model: " + p, nil
}

func TestLocalInferenceAndFailure(t *testing.T) {
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var req struct {
			Prompt  string              `json:"prompt"`
			History []map[string]string `json:"history"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		if calls == 2 && (len(req.History) != 2 || req.History[1]["role"] != "assistant") {
			t.Error("missing conversation history")
		}
		if calls == 3 {
			w.WriteHeader(422)
			fmt.Fprint(w, `{"error":"context capacity exceeded"}`)
			return
		}
		fmt.Fprint(w, `{"reply":"A real backend response"}`)
	}))
	defer s.Close()
	e := NewEngine()
	e.SetBackend(NewLocalBackend(s.URL))
	for i := 0; i < 2; i++ {
		reply, _, err := e.ProcessPromptContext(context.Background(), "hello")
		if err != nil || reply != "A real backend response" {
			t.Fatalf("%s %v", reply, err)
		}
	}
	if _, _, err := e.ProcessPromptContext(context.Background(), "again"); err == nil {
		t.Fatal("error hidden")
	}
	if len(e.GetHistory()) != 4 {
		t.Fatal("failed reply stored as success")
	}
	if _, err := NewLocalBackend("https://remote.example").Chat(context.Background(), "secret", nil); err == nil {
		t.Fatal("accepted remote endpoint")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := NewLocalBackend(s.URL).Chat(ctx, "hello", nil)
	if err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatalf("cancellation: %v", err)
	}
}
