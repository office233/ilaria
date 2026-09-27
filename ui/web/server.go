package web

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"swypik-os/config"
	"time"

	"swypik-os/core/audio"
	"swypik-os/core/coder"
	"swypik-os/core/hal"
	"swypik-os/core/ilaria"
	"swypik-os/core/swarm"
)

//go:embed index.html desktop.css desktop.js native.js
var desktopAssets embed.FS

// Server coordinates the high-performance local web engine and sovereign proxy.
type Server struct {
	port            int
	httpServer      *http.Server
	staticDir       string
	cfg             *config.Config
	ilariaEngine    *ilaria.Engine
	swarmDaemon     *swarm.Daemon
	coderEngine     *coder.Engine
	cudaDriver      *hal.CUDADriver
	audioStream     *audio.DirectAudioStreamer
	allowLocalProxy bool
}

// NewServer initializes the sovereign desktop web engine.
func NewServer(
	port int,
	staticDir string,
	iEngine *ilaria.Engine,
	sDaemon *swarm.Daemon,
	cEngine *coder.Engine,
) *Server {
	cfg := config.Get()
	if staticDir == "" {
		staticDir = cfg.StaticDir
	}

	cuda := hal.NewCUDADriver()
	_ = cuda.Init()

	audioStr := audio.NewDirectAudioStreamer(16000, 1)

	return &Server{
		port:         port,
		cfg:          cfg,
		staticDir:    staticDir,
		ilariaEngine: iEngine,
		swarmDaemon:  sDaemon,
		coderEngine:  cEngine,
		cudaDriver:   cuda,
		audioStream:  audioStr,
	}
}

// Start launches the background HTTP server on localhost.
func (s *Server) Start() (string, error) {
	if s.staticDir != "" {
		if info, err := os.Stat(filepath.Join(s.staticDir, "index.html")); err != nil || info.IsDir() {
			return "", fmt.Errorf("static directory must contain index.html: %s", s.staticDir)
		}
	}
	mux := http.NewServeMux()

	// 1. Static file serving (HTML/CSS/JS)
	mux.HandleFunc("/", s.handleStatic)

	// 2. Sovereign REST APIs
	mux.HandleFunc("/api/telemetry", s.handleTelemetry)
	mux.HandleFunc("/api/omnibar", s.handleOmnibar)
	mux.HandleFunc("/api/files", s.handleFiles)
	mux.HandleFunc("/api/workspaces", s.handleWorkspaces)
	mux.HandleFunc("/api/file-preview", s.handleFilePreview)
	mux.HandleFunc("/api/apps", s.handleApps)
	mux.HandleFunc("/api/apps/launch", s.handleAppLaunch)
	mux.HandleFunc("/api/proxy", s.handleProxy)
	mux.HandleFunc("/api/voice_chime", s.handleVoiceChime)

	addr := net.JoinHostPort(s.cfg.BindHost, fmt.Sprint(s.port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return "", fmt.Errorf("failed to bind %s: %w", addr, err)
	}
	s.port = ln.Addr().(*net.TCPAddr).Port

	s.httpServer = &http.Server{
		Handler:           s.protect(mux),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      150 * time.Second,
	}

	go func() {
		_ = s.httpServer.Serve(ln)
	}()

	host := s.cfg.BindHost
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	serverURL := "http://" + net.JoinHostPort(host, fmt.Sprint(s.port))
	return serverURL, nil
}

// Stop shuts down the web server.
func (s *Server) Stop() {
	if s.httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := s.httpServer.Shutdown(ctx); err != nil {
			// Shutdown only drains; force-close remaining connections so their
			// request contexts cancel when the graceful deadline expires.
			_ = s.httpServer.Close()
		}
	}
}

// LaunchDesktopWindow opens the UI in frameless native hardware-accelerated app mode using Edge or Chrome.
func (s *Server) LaunchDesktopWindow(url string) (*exec.Cmd, error) {
	var browserPath string

	if runtime.GOOS == "windows" {
		edgePath := s.cfg.EdgePath
		chromePath := s.cfg.ChromePath

		if _, err := os.Stat(edgePath); err == nil {
			browserPath = edgePath
		} else if _, err := os.Stat(chromePath); err == nil {
			browserPath = chromePath
		}
	}

	if browserPath == "" {
		// Fallback: system default browser
		return nil, fmt.Errorf("no native Edge or Chrome found on system")
	}

	appArg := fmt.Sprintf("--app=%s", url)
	cmd := exec.Command(browserPath, appArg, "--start-maximized", "--disable-features=Translate", "--no-first-run")
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to launch desktop window: %w", err)
	}

	return cmd, nil
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	switch name {
	case "index.html", "desktop.css", "desktop.js", "native.js":
	default:
		http.NotFound(w, r)
		return
	}
	var assets fs.FS = desktopAssets
	if s.staticDir != "" {
		assets = os.DirFS(s.staticDir)
	}
	if _, err := fs.Stat(assets, name); err != nil {
		http.NotFound(w, r)
		return
	}
	http.FileServer(http.FS(assets)).ServeHTTP(w, r)
}

func (s *Server) setCORS(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		w.Header().Set("Access-Control-Allow-Origin", fmt.Sprintf("http://127.0.0.1:%d", s.port))
		return true
	}
	allowed1 := fmt.Sprintf("http://127.0.0.1:%d", s.port)
	allowed2 := fmt.Sprintf("http://localhost:%d", s.port)
	allowed := origin == allowed1 || origin == allowed2 || origin == "http://"+net.JoinHostPort(s.cfg.BindHost, fmt.Sprint(s.port))
	for _, configured := range s.cfg.AllowedOrigins {
		if configured != "" && configured != "*" && origin == configured {
			allowed = true
		}
	}
	if allowed {
		w.Header().Add("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		return true
	}
	http.Error(w, "Forbidden origin", http.StatusForbidden)
	return false
}

func (s *Server) handleTelemetry(w http.ResponseWriter, r *http.Request) {
	if !s.setCORS(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	var cudaTelem *hal.CUDATelemetry
	if s.cudaDriver != nil {
		cudaTelem, _ = s.cudaDriver.GetTelemetry()
	}

	var swarmStatus swarm.Status
	if s.swarmDaemon != nil {
		swarmStatus = s.swarmDaemon.GetStatus()
	}

	resp := map[string]interface{}{
		"system":      "SwypikOS 2026 Sovereign",
		"time":        time.Now().Format("15:04:05"),
		"date":        time.Now().Format("Mon, Jan 02"),
		"cuda":        cudaTelem,
		"swarm":       swarmStatus,
		"default_url": s.cfg.DefaultURL,
		"audio":       map[string]interface{}{"status": "browser_audio", "latency_ms": nil},
	}

	_ = json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleOmnibar(w http.ResponseWriter, r *http.Request) {
	if !s.setCORS(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Input string `json:"input"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
	if err := decoder.Decode(&req); err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	if err := decoder.Decode(new(interface{})); err != io.EOF {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}

	input := strings.TrimSpace(req.Input)
	if input == "" {
		http.Error(w, "Input is required", http.StatusBadRequest)
		return
	}
	lower := strings.ToLower(input)

	// Check if input is a URL or web navigation request
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") ||
		strings.HasPrefix(lower, "www.") || strings.HasSuffix(lower, ".com") ||
		strings.HasSuffix(lower, ".org") || strings.HasSuffix(lower, ".io") ||
		strings.HasSuffix(lower, ".net") || strings.HasSuffix(lower, ".co") {

		targetURL := input
		if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
			targetURL = "https://" + input
		}

		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"type":     "NAVIGATE",
			"url":      targetURL,
			"feedback": fmt.Sprintf("Navigating to %s", targetURL),
		})
		return
	}

	// Terminal commands (run ...)
	if strings.HasPrefix(lower, "run ") || (lower == "dir" || strings.HasPrefix(lower, "dir ")) || strings.HasPrefix(lower, "go ") {
		cmdStr := input
		if strings.HasPrefix(lower, "run ") {
			cmdStr = strings.TrimSpace(input[4:])
		}
		if s.coderEngine == nil {
			http.Error(w, "Command engine unavailable", http.StatusServiceUnavailable)
			return
		}
		lowerCmd := strings.ToLower(cmdStr)
		if strings.Contains(lowerCmd, "-encodedcommand") || strings.Contains(lowerCmd, "certutil") || strings.Contains(lowerCmd, "vssadmin") || strings.Contains(lowerCmd, "format ") {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"type":     "TERMINAL",
				"output":   "Command execution blocked by Sovereign Security Guard.",
				"success":  false,
				"feedback": "Prohibited command pattern detected.",
			})
			return
		}
		res := s.coderEngine.ExecuteCommandContext(r.Context(), cmdStr)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"type":     "TERMINAL",
			"output":   res.Output,
			"success":  res.Success,
			"feedback": fmt.Sprintf("Executed '%s' (Latency: %dms)", res.Command, res.LatencyMs),
		})
		return
	}

	// Ilaria AI Natural Response
	if s.ilariaEngine == nil {
		http.Error(w, "AI engine unavailable", http.StatusServiceUnavailable)
		return
	}
	// Include queue time in the request budget and leave time to send an error
	// before the HTTP write deadline. The local Ilaria client allows 130 seconds.
	ctx, cancel := context.WithTimeout(r.Context(), 135*time.Second)
	defer cancel()
	reply, intent, err := s.ilariaEngine.ProcessPromptContext(ctx, input)
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"type": "AI_ERROR", "success": false, "feedback": err.Error(), "error": err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"type":     "AI_RESPONSE",
		"intent":   intent,
		"reply":    reply,
		"feedback": reply,
	})
}

func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	if !s.setCORS(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	targetPath := r.URL.Query().Get("path")
	if targetPath == "" {
		targetPath = s.cfg.WorkspaceDir
	}
	if !filepath.IsAbs(targetPath) {
		targetPath = filepath.Join(s.cfg.WorkspaceDir, targetPath)
	}
	cleanPath, err := filepath.EvalSymlinks(targetPath)
	if err != nil {
		http.Error(w, "Directory not found", http.StatusNotFound)
		return
	}
	if !s.allowedFilePath(cleanPath) {
		http.Error(w, "Directory traversal restricted", http.StatusForbidden)
		return
	}
	if s.coderEngine == nil {
		http.Error(w, "File engine unavailable", http.StatusServiceUnavailable)
		return
	}

	items, err := s.coderEngine.ListDirectory(cleanPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"path":  cleanPath,
		"items": items,
	})
}

// handleVoiceChime returns synthesized PCM as a WAV file for browser playback.
func (s *Server) handleVoiceChime(w http.ResponseWriter, r *http.Request) {
	if s.audioStream == nil {
		http.Error(w, "Audio unavailable", http.StatusServiceUnavailable)
		return
	}
	writeChime(w, s.audioStream.SynthesizeIlariaChime(880, 120), 16000)
}
