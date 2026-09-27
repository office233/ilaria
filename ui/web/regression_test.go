package web

import (
	"encoding/binary"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPublicIP(t *testing.T) {
	for _, address := range []string{"127.1.2.3", "10.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1", "100.64.0.1", "0.0.0.0"} {
		if publicIP(net.ParseIP(address)) {
			t.Errorf("accepted private address %s", address)
		}
	}
	if !publicIP(net.ParseIP("8.8.8.8")) {
		t.Fatal("rejected public address")
	}
}

func TestRootBoundary(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "workspace")
	sibling := root + "-private"
	for _, path := range []string{root, sibling, filepath.Join(root, "child")} {
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if withinRoot(sibling, root) || withinRoot(base, root) {
		t.Fatal("accepted path outside root")
	}
	if !withinRoot(filepath.Join(root, "child"), root) {
		t.Fatal("rejected child")
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(sibling, link); err == nil {
		resolved, err := filepath.EvalSymlinks(link)
		if err != nil {
			t.Fatal(err)
		}
		if withinRoot(resolved, root) {
			t.Fatal("symlink escaped root")
		}
	}
}

func TestEmbeddedAssetsAndAPIGuard(t *testing.T) {
	s := NewServer(0, "", nil, nil, nil)
	endpoint, err := s.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	for _, tc := range []struct {
		path   string
		status int
	}{{"/", 200}, {"/desktop.js", 200}, {"/server.go", 404}, {"/swarm_state.json", 404}, {"/.env", 404}} {
		resp, err := http.Get(endpoint + tc.path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != tc.status {
			t.Errorf("%s: %d", tc.path, resp.StatusCode)
		}
	}
	for _, origin := range []string{"null", "https://evil.example"} {
		r := httptest.NewRequest("POST", endpoint+"/api/omnibar", strings.NewReader(`{"input":"run go version"}`))
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		s.protect(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("untrusted request reached handler") })).ServeHTTP(w, r)
		if w.Code != 403 {
			t.Errorf("origin %s: %d", origin, w.Code)
		}
	}
	r := httptest.NewRequest("OPTIONS", endpoint+"/api/omnibar", nil)
	r.Header.Set("Origin", endpoint)
	w := httptest.NewRecorder()
	s.protect(http.NotFoundHandler()).ServeHTTP(w, r)
	if w.Code != 204 {
		t.Fatalf("preflight: %d", w.Code)
	}
	r = httptest.NewRequest("GET", "http://attacker.example/api/telemetry", nil)
	w = httptest.NewRecorder()
	s.protect(http.NotFoundHandler()).ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("DNS rebinding host: %d", w.Code)
	}
}

func TestProxyRedirectStatusAndBase(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			http.Redirect(w, r, "/dir/page", 302)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(404)
		_, _ = w.Write([]byte("<HTML><HEAD><title>Missing</title></HEAD></HTML>"))
	}))
	defer upstream.Close()
	s := NewServer(0, "", nil, nil, nil)
	s.allowLocalProxy = true
	w := httptest.NewRecorder()
	s.handleProxy(w, httptest.NewRequest("GET", "/api/proxy?url="+url.QueryEscape(upstream.URL+"/start"), nil))
	if w.Code != 404 || !strings.Contains(w.Body.String(), `<base href="`+upstream.URL+`/dir/page">`) {
		t.Fatalf("incorrect response: %d %s", w.Code, w.Body.String())
	}
}

func TestChimeIsPlayableWAV(t *testing.T) {
	s := NewServer(0, "", nil, nil, nil)
	w := httptest.NewRecorder()
	s.handleVoiceChime(w, httptest.NewRequest("GET", "/api/voice_chime", nil))
	body := w.Body.Bytes()
	if len(body) < 44 || string(body[:4]) != "RIFF" || string(body[8:12]) != "WAVE" {
		t.Fatal("invalid WAV")
	}
	if int(binary.LittleEndian.Uint32(body[40:44])) != len(body)-44 {
		t.Fatal("incorrect PCM size")
	}
}
