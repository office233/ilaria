package ilaria

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLoopbackIgnoresConfiguredCloudToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "" {
			t.Fatalf("loopback request leaked authorization header: %q", auth)
		}
		fmt.Fprint(w, `{"reply":"ok"}`)
	}))
	defer server.Close()

	reply, err := NewCloudBackend(server.URL, strings.Repeat("x", 32)).Chat(context.Background(), "hello", nil)
	if err != nil || reply != "ok" {
		t.Fatalf("reply=%q err=%v", reply, err)
	}
}
