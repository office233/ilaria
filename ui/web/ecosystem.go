package web

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

//go:embed apps.json
var catalogAssets embed.FS

type desktopApp struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Route   string   `json:"route,omitempty"`
	Group   string   `json:"group"`
	Icon    string   `json:"icon"`
	Feature string   `json:"feature,omitempty"`
	Roles   []string `json:"roles,omitempty"`
	URL     string   `json:"url"`
	Local   bool     `json:"local,omitempty"`
}
type linkedWorkspace struct {
	Name string `json:"name"`
	Path string `json:"path"`
}
type desktopIntegration struct {
	PlatformURL string            `json:"platform_url"`
	StudioURL   string            `json:"studio_url"`
	NexusURL    string            `json:"nexus_url"`
	Workspaces  []linkedWorkspace `json:"workspaces"`
}

// Configuration is local, explicit and independent of the platform's secrets.
func (s *Server) desktopIntegration() (desktopIntegration, error) {
	cfg := desktopIntegration{PlatformURL: "https://swypik.com"}
	name := os.Getenv("SWYPIK_DESKTOP_CONFIG")
	if name == "" {
		name = "desktop-integrations.json"
		if _, err := os.Stat(name); os.IsNotExist(err) {
			if exe, err := os.Executable(); err == nil {
				name = filepath.Join(filepath.Dir(exe), name)
			}
		}
	}
	data, err := os.ReadFile(name)
	if err == nil {
		if err := json.Unmarshal(data, &cfg); err != nil {
			return cfg, fmt.Errorf("invalid desktop integration configuration")
		}
	} else if !os.IsNotExist(err) || os.Getenv("SWYPIK_DESKTOP_CONFIG") != "" {
		return cfg, fmt.Errorf("cannot read desktop integration configuration")
	}
	if value := os.Getenv("SWYPIK_PLATFORM_URL"); value != "" {
		cfg.PlatformURL = value
	}
	if _, err := integrationURL(cfg.PlatformURL, ""); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func integrationURL(base, route string) (string, error) {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("invalid application URL")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")) {
		return "", fmt.Errorf("applications require HTTPS or a local development service")
	}
	if route != "" {
		u.Path = strings.TrimRight(u.Path, "/") + route
	}
	return u.String(), nil
}

func (s *Server) applications() ([]desktopApp, desktopIntegration, error) {
	cfg, err := s.desktopIntegration()
	if err != nil {
		return nil, cfg, err
	}
	data, err := catalogAssets.ReadFile("apps.json")
	if err != nil {
		return nil, cfg, err
	}
	var apps []desktopApp
	if err := json.Unmarshal(data, &apps); err != nil {
		return nil, cfg, err
	}
	for i := range apps {
		apps[i].URL, err = integrationURL(cfg.PlatformURL, apps[i].Route)
		if err != nil {
			return nil, cfg, err
		}
	}
	for _, local := range []desktopApp{
		{ID: "studio", Name: "Swypik Studio", Group: "local", Icon: "Clapperboard", URL: cfg.StudioURL, Local: true},
		{ID: "nexus", Name: "Nexus · Ilaria", Group: "local", Icon: "Sparkles", URL: cfg.NexusURL, Local: true},
	} {
		if local.URL == "" {
			continue
		}
		local.URL, err = integrationURL(local.URL, "")
		if err != nil {
			return nil, cfg, err
		}
		apps = append(apps, local)
	}
	return apps, cfg, nil
}

func (s *Server) handleApps(w http.ResponseWriter, r *http.Request) {
	apps, cfg, err := s.applications()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"apps": apps, "platform_url": cfg.PlatformURL})
}

// Old clients must use the native IPC bridge. Never silently launch external windows.
func (s *Server) handleAppLaunch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", 405)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "Invalid application request", 400)
		return
	}
	apps, _, err := s.applications()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	for _, app := range apps {
		if app.ID != req.ID {
			continue
		}
		http.Error(w, "Open this application inside the SwypikOS desktop host", http.StatusConflict)
		return
	}
	http.Error(w, "Unknown application", 404)
}

func (s *Server) workspacePlaces() []linkedWorkspace {
	root, _ := filepath.Abs(s.cfg.WorkspaceDir)
	places := []linkedWorkspace{{Name: "SwypikOS", Path: root}}
	if cfg, err := s.desktopIntegration(); err == nil {
		for _, place := range cfg.Workspaces {
			if !filepath.IsAbs(place.Path) || place.Name == "" {
				continue
			}
			if info, err := os.Stat(place.Path); err == nil && info.IsDir() {
				places = append(places, place)
			}
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		places = append(places, linkedWorkspace{Name: "Home", Path: home})
	}
	return places
}

func (s *Server) allowedFilePath(path string) bool {
	for _, place := range s.workspacePlaces() {
		if withinRoot(path, place.Path) {
			return true
		}
	}
	return false
}

func (s *Server) handleWorkspaces(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.workspacePlaces())
}

// Text previews stay inert JSON and are bounded; HTML is never executed and
// symlinks use exactly the same containment rules as directory navigation.
func (s *Server) handleFilePreview(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("path")
	if target == "" {
		http.Error(w, "File path is required", 400)
		return
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(s.cfg.WorkspaceDir, target)
	}
	path, err := filepath.EvalSymlinks(target)
	if err != nil {
		http.Error(w, "File not found", 404)
		return
	}
	if !s.allowedFilePath(path) {
		http.Error(w, "File is outside linked workspaces", 403)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "Cannot open file", 404)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "Not a regular file", 400)
		return
	}
	const limit = 256 * 1024
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		http.Error(w, "Cannot read file", 500)
		return
	}
	if len(data) > limit {
		http.Error(w, "Preview limited to text files under 256 KB", 413)
		return
	}
	if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
		http.Error(w, "Binary file: text preview unavailable", 415)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"name": info.Name(), "path": path, "text": string(data), "size": info.Size()})
}
