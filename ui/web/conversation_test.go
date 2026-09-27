package web

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"swypik-os/core/ilaria"
)

type conversationBackend func(context.Context, string, []ilaria.Message) (string, error)

func (f conversationBackend) Chat(ctx context.Context, prompt string, history []ilaria.Message) (string, error) {
	return f(ctx, prompt, history)
}

func TestConversationFailureRemainsFailure(t *testing.T) {
	e := ilaria.NewEngine()
	e.SetBackend(conversationBackend(func(ctx context.Context, _ string, _ []ilaria.Message) (string, error) {
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) < 130*time.Second || time.Until(deadline) > 135*time.Second {
			t.Error("conversation budget must cover local inference and bound queue wait")
		}
		return "", errors.New("local Ilaria unavailable")
	}))
	s := NewServer(0, ".", e, nil, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/omnibar", strings.NewReader(`{"input":"Salut Ilaria"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.handleOmnibar(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got HTTP %d", w.Code)
	}
	var result struct {
		Type    string `json:"type"`
		Success bool   `json:"success"`
		Error   string `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Type != "AI_ERROR" || result.Success || result.Error == "" || len(e.GetHistory()) != 0 {
		t.Fatalf("failure presented as success: %s", w.Body.String())
	}
}

func TestHTTPDisconnectCancelsInference(t *testing.T) {
	e := ilaria.NewEngine()
	entered, canceled := make(chan struct{}), make(chan struct{})
	e.SetBackend(conversationBackend(func(ctx context.Context, _ string, _ []ilaria.Message) (string, error) {
		close(entered)
		<-ctx.Done()
		close(canceled)
		return "", ctx.Err()
	}))
	s := NewServer(0, ".", e, nil, nil)
	endpoint, err := s.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	if s.httpServer.WriteTimeout <= 135*time.Second {
		t.Fatal("HTTP deadline cuts off inference")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"/api/omnibar", strings.NewReader(`{"input":"Salut Ilaria"}`))
	req.Header.Set("Content-Type", "application/json")
	done := make(chan struct{})
	go func() {
		defer close(done)
		resp, _ := http.DefaultClient.Do(req)
		if resp != nil {
			resp.Body.Close()
		}
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("inference never started")
	}
	cancel()
	select {
	case <-canceled:
	case <-time.After(3 * time.Second):
		t.Fatal("disconnect did not cancel backend")
	}
	<-done
	if len(e.GetHistory()) != 0 {
		t.Fatal("canceled request modified history")
	}
}
