package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"swypik-os/config"
	"testing"
)

func TestIntegrationURL(t *testing.T) {
	for _, base := range []string{"javascript:alert(1)", "https://user:pass@swypik.com", "http://example.com", "https://swypik.com?token=private", "https://swypik.com#fragment"} {
		if _, err := integrationURL(base, "/go"); err == nil {
			t.Errorf("accepted %s", base)
		}
	}
	for _, base := range []string{"https://swypik.com", "http://127.0.0.1:3000", "https://staging.example/ro"} {
		got, err := integrationURL(base, "/movies")
		if err != nil || got != base+"/movies" {
			t.Errorf("%s: %s %v", base, got, err)
		}
	}
}

func integrationServer(t *testing.T) (*Server, string, string) {
	t.Helper()
	root := t.TempDir()
	linked := t.TempDir()
	cfg := desktopIntegration{PlatformURL: "https://example.com", Workspaces: []linkedWorkspace{{Name: "Linked project", Path: linked}}}
	data, _ := json.Marshal(cfg)
	cfgPath := filepath.Join(root, "desktop.json")
	if err := os.WriteFile(cfgPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SWYPIK_DESKTOP_CONFIG", cfgPath)
	t.Setenv("SWYPIK_PLATFORM_URL", "")
	return &Server{cfg: &config.Config{WorkspaceDir: root, BindHost: "127.0.0.1"}}, root, linked
}

func TestCatalogSharedOriginAndLaunchGuard(t *testing.T) {
	s, _, _ := integrationServer(t)
	apps, _, err := s.applications()
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, app := range apps {
		if found[app.ID] {
			t.Fatal("duplicate application")
		}
		found[app.ID] = true
		if !strings.HasPrefix(app.URL, "https://example.com/") {
			t.Fatalf("different origin: %s", app.URL)
		}
	}
	for _, id := range []string{"go", "movies", "food", "music", "stays", "fly", "gaming", "messages", "seller", "creator", "fleet", "courier", "account"} {
		if !found[id] {
			t.Errorf("missing %s", id)
		}
	}
	for _, tc := range []struct {
		method, origin, body string
		want                 int
	}{{"GET", "", `{"id":"go"}`, 405}, {"POST", "https://evil.example", `{"id":"go"}`, 403}, {"POST", "", `{"id":"../../cmd.exe"}`, 404}} {
		r := httptest.NewRequest(tc.method, "http://127.0.0.1:9876/api/apps/launch", strings.NewReader(tc.body))
		if tc.origin != "" {
			r.Header.Set("Origin", tc.origin)
		}
		w := httptest.NewRecorder()
		s.protect(http.HandlerFunc(s.handleAppLaunch)).ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("%+v: %d", tc, w.Code)
		}
	}
}

func TestLinkedFilePreviewIsBoundedAndInert(t *testing.T) {
	s, root, linked := integrationServer(t)
	html := filepath.Join(linked, "example.html")
	if err := os.WriteFile(html, []byte("<script>alert('x')</script>"), 0600); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(root, "binary.bin")
	_ = os.WriteFile(binary, []byte{0, 1, 2}, 0600)
	large := filepath.Join(root, "large.txt")
	_ = os.WriteFile(large, []byte(strings.Repeat("a", 256*1024+1)), 0600)
	outside := filepath.Join(t.TempDir(), "outside.txt")
	_ = os.WriteFile(outside, []byte("private"), 0600)
	// Temp files can be inside the user's home, which is an intentionally allowed
	// root. Independently verify sibling boundary exclusion for linked roots.
	if withinRoot(linked+"-other", linked) {
		t.Fatal("sibling path admitted")
	}
	for _, tc := range []struct {
		path string
		want int
	}{{html, 200}, {binary, 415}, {large, 413}, {filepath.Join(root, "missing"), 404}} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "http://127.0.0.1/api/file-preview?path="+url.QueryEscape(tc.path), nil)
		s.handleFilePreview(w, r)
		if w.Code != tc.want {
			t.Errorf("%s: %d", tc.path, w.Code)
		}
		if tc.want == 200 {
			if w.Header().Get("Content-Type") != "application/json" {
				t.Fatal("active HTML response")
			}
			var data map[string]interface{}
			if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
				t.Fatal(err)
			}
			if data["text"] != "<script>alert('x')</script>" {
				t.Fatal("preview changed")
			}
		}
	}
	link := filepath.Join(linked, "escape")
	if err := os.Symlink(outside, link); err == nil {
		resolved, _ := filepath.EvalSymlinks(link)
		if withinRoot(resolved, linked) {
			t.Fatal("symlink escape")
		}
	}
}
