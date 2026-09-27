package web

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"swypik-os/core/coder"
	"swypik-os/core/ilaria"
)

func TestFilePreviewPathsAndFormats(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "integrations.json")
	if err := os.WriteFile(configPath, []byte(`{"workspaces":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SWYPIK_DESKTOP_CONFIG", configPath)
	for name, body := range map[string][]byte{"notes.txt": []byte("hello"), "empty.txt": {}, "binary.bin": {0, 255}, "big.txt": []byte(strings.Repeat("x", 256*1024+1))} {
		if err := os.WriteFile(filepath.Join(root, name), body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	s := NewServer(0, "", nil, nil, coder.NewEngine())
	cfg := *s.cfg
	cfg.WorkspaceDir = root
	s.cfg = &cfg
	for _, tc := range []struct {
		name, path string
		status     int
	}{
		{"relative", "notes.txt", 200},
		{"absolute", filepath.Join(root, "notes.txt"), 200},
		{"empty", filepath.Join(root, "empty.txt"), 200},
		{"binary", filepath.Join(root, "binary.bin"), 415},
		{"oversized", filepath.Join(root, "big.txt"), 413},
		{"directory", root, 400},
		{"missing", filepath.Join(root, "missing.txt"), 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			s.handleFilePreview(w, httptest.NewRequest("GET", "/api/file-preview?path="+url.QueryEscape(tc.path), nil))
			if w.Code != tc.status {
				t.Fatalf("status=%d want=%d: %s", w.Code, tc.status, w.Body.String())
			}
			if w.Code == 200 {
				var payload map[string]interface{}
				if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
					t.Fatal(err)
				}
				if w.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("preview is cacheable")
				}
			}
		})
	}
}

func TestOmnibarRejectsTrailingJSON(t *testing.T) {
	s := NewServer(0, "", nil, nil, coder.NewEngine())
	for _, body := range []string{`{"input":"example.com"} {"input":"another"}`, `{"input":"example.com"} trailing`} {
		w := httptest.NewRecorder()
		s.handleOmnibar(w, httptest.NewRequest("POST", "/api/omnibar", strings.NewReader(body)))
		if w.Code != 400 {
			t.Errorf("malformed request accepted: status %d", w.Code)
		}
	}
}

func TestShutdownCancelsActiveInference(t *testing.T) {
	e := ilaria.NewEngine()
	entered, finished := make(chan struct{}), make(chan struct{})
	e.SetBackend(conversationBackend(func(ctx context.Context, _ string, _ []ilaria.Message) (string, error) {
		close(entered)
		<-ctx.Done()
		close(finished)
		return "", ctx.Err()
	}))
	s := NewServer(0, ".", e, nil, nil)
	endpoint, err := s.Start()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", endpoint+"/api/omnibar", strings.NewReader(`{"input":"hello"}`))
	done := make(chan struct{})
	go func() {
		defer close(done)
		res, _ := http.DefaultClient.Do(req)
		if res != nil {
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
		}
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not start")
	}
	s.Stop()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Error("shutdown returned with inference still active")
	}
	cancel()
	<-done
}
