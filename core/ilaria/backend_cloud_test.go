package ilaria

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCloudBackendTLSAndToken(t *testing.T) {
	token := strings.Repeat("a", 32)
	calls := 0
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("missing authentication")
		}
		fmt.Fprint(w, `{"reply":"connected"}`)
	}))
	defer s.Close()
	b := NewCloudBackend(s.URL, token)
	b.client.Transport = s.Client().Transport
	if reply, err := b.Chat(context.Background(), "hello", nil); err != nil || reply != "connected" {
		t.Fatalf("%q %v", reply, err)
	}
	for _, endpoint := range []string{strings.Replace(s.URL, "https:", "http:", 1), s.URL + "?x=1", s.URL + "/other"} {
		if _, err := NewCloudBackend(endpoint, token).Chat(context.Background(), "hello", nil); err == nil {
			t.Fatalf("accepted %s", endpoint)
		}
	}
	if calls != 1 {
		t.Fatal("unexpected network requests")
	}
}

func TestCloudBackendDoesNotForwardTokenOnRedirect(t *testing.T) {
	targetCalls := 0
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetCalls++ }))
	defer target.Close()
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer s.Close()
	b := NewCloudBackend(s.URL, strings.Repeat("a", 32))
	b.client.Transport = s.Client().Transport
	if _, err := b.Chat(context.Background(), "hello", nil); err == nil {
		t.Fatal("accepted redirect")
	}
	if targetCalls != 0 {
		t.Fatal("followed redirect")
	}
}
