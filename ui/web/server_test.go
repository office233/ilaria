package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"swypik-os/core/coder"
	"swypik-os/core/ilaria"
	"swypik-os/core/swarm"
)

func TestWebServerEndpoints(t *testing.T) {
	t.Setenv("SWYPIK_STATE_DIR", t.TempDir())
	iEngine := ilaria.NewEngine()
	sDaemon := swarm.NewDaemon()
	defer sDaemon.Stop()
	cEngine := coder.NewEngine()

	server := NewServer(0, ".", iEngine, sDaemon, cEngine)
	srvURL, err := server.Start()
	if err != nil {
		t.Fatalf("failed to start server: %v", err)
	}
	defer server.Stop()

	client := &http.Client{}

	// 1. Test Static Index
	resp, err := client.Get(srvURL + "/")
	if err != nil {
		t.Fatalf("failed to GET /: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200 OK for /, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// 2. Test Telemetry Endpoint
	resp, err = client.Get(srvURL + "/api/telemetry")
	if err != nil {
		t.Fatalf("failed to GET /api/telemetry: %v", err)
	}
	var telem map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&telem); err != nil {
		t.Fatalf("failed to decode telemetry: %v", err)
	}
	resp.Body.Close()
	if telem["system"] != "SwypikOS 2026 Sovereign" {
		t.Errorf("unexpected system name: %v", telem["system"])
	}

	// 3. Test Omnibar Navigation
	body := strings.NewReader(`{"input":"wikipedia.org"}`)
	resp, err = client.Post(srvURL+"/api/omnibar", "application/json", body)
	if err != nil {
		t.Fatalf("failed to POST /api/omnibar: %v", err)
	}
	var omniResp map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&omniResp); err != nil {
		t.Fatalf("failed to decode omnibar response: %v", err)
	}
	resp.Body.Close()
	if omniResp["type"] != "NAVIGATE" {
		t.Errorf("expected NAVIGATE type, got %v", omniResp["type"])
	}
	if omniResp["url"] != "https://wikipedia.org" {
		t.Errorf("expected https://wikipedia.org, got %v", omniResp["url"])
	}

	// 4. Test Omnibar Command Execution
	body = strings.NewReader(`{"input":"run go version"}`)
	resp, err = client.Post(srvURL+"/api/omnibar", "application/json", body)
	if err != nil {
		t.Fatalf("failed to POST /api/omnibar command: %v", err)
	}
	omniResp = nil
	if err := json.NewDecoder(resp.Body).Decode(&omniResp); err != nil {
		t.Fatalf("failed to decode omnibar command response: %v", err)
	}
	resp.Body.Close()
	if omniResp["type"] != "TERMINAL" {
		t.Errorf("expected TERMINAL type, got %v", omniResp["type"])
	}

	// 5. Test Voice Chime
	resp, err = client.Get(srvURL + "/api/voice_chime")
	if err != nil {
		t.Fatalf("failed to GET /api/voice_chime: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200 OK for chime, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestProxyBaseInjection(t *testing.T) {
	t.Setenv("SWYPIK_STATE_DIR", t.TempDir())
	// Mock target server
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'")
		w.Write([]byte(`<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>`))
	}))
	defer targetServer.Close()

	server := NewServer(0, ".", nil, nil, nil)
	server.allowLocalProxy = true
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/proxy?url="+targetServer.URL, nil)

	server.handleProxy(rec, req)

	// Verify headers stripped
	if rec.Header().Get("X-Frame-Options") != "" {
		t.Errorf("X-Frame-Options was not stripped")
	}
	if rec.Header().Get("Content-Security-Policy") != "sandbox allow-scripts allow-forms allow-popups" {
		t.Errorf("Proxy sandbox policy missing")
	}

	// Verify <base href="..."> injected
	body := rec.Body.String()
	if !strings.Contains(body, "<base href=") {
		t.Errorf("expected <base href=...> to be injected, body: %s", body)
	}
}

func TestProxySSRFProtection(t *testing.T) {
	t.Setenv("SWYPIK_STATE_DIR", t.TempDir())
	server := NewServer(0, ".", nil, nil, nil)
	// allowLocalProxy is false by default in production!
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/proxy?url=http://127.0.0.1:8080/admin", nil)

	server.handleProxy(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("expected 403 Forbidden for SSRF attempt on 127.0.0.1, got %d", rec.Code)
	}
}
