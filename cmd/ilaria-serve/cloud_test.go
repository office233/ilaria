package main

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCloudAuthenticationBoundary(t *testing.T) {
	token := strings.Repeat("a", 32)
	calls := 0
	inner := newHandler(func(_ context.Context, r chatRequest) (chatResponse, error) {
		calls++
		return chatResponse{Reply: r.Prompt}, nil
	})
	for _, bad := range []string{"", "short", token + " "} {
		if _, err := cloudHandler(inner, bad); err == nil {
			t.Fatal("accepted invalid configured token")
		}
	}
	h, err := cloudHandler(inner, token)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		scheme, auth, origin string
		want                 int
	}{
		{"https", "Bearer " + token, "", 200},
		{"http", "Bearer " + token, "", 401},
		{"https", "", "", 401},
		{"https", "Bearer " + strings.Repeat("b", 32), "", 401},
		{"https", "Bearer " + token, "https://evil.test", 403},
	} {
		r := httptest.NewRequest("POST", tc.scheme+"://ilaria.example/v1/chat", strings.NewReader(`{"prompt":"hello"}`))
		r.Header.Set("Authorization", tc.auth)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("%s: got %d, want %d", tc.scheme, w.Code, tc.want)
		}
		if r.Host != "ilaria.example" {
			t.Fatal("mutated original request")
		}
	}
	if calls != 1 {
		t.Fatalf("unauthorized inference: %d calls", calls)
	}
}
