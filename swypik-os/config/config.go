package config

import (
	"bufio"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

var (
	globalConfig *Config
	configOnce   sync.Once
)

// Config encapsulates runtime operational settings loaded from .env and environment variables.
type Config struct {
	// Server
	ServerPort     int
	BindHost       string
	StaticDir      string
	WorkspaceDir   string
	DefaultURL     string
	AllowedOrigins []string

	// Hardware & HAL
	EdgePath   string
	ChromePath string

	// Swarm
	SwarmEnabled bool
	NodeID       string
}

// EnvFileVar is the environment variable naming an explicit .env file path.
const EnvFileVar = "SWYPIK_ENV_FILE"

// Load reads .env (if present) and overlays process environment variables.
func Load(envPaths ...string) *Config {
	configOnce.Do(func() {
		// Try explicit locations for .env:
		// - caller-provided paths
		// - path specified by the SWYPIK_ENV_FILE environment variable
		// - directory of the running executable (os.Executable)
		// CWD is never checked implicitly.
		candidates := append([]string{}, envPaths...)
		if envFile := os.Getenv(EnvFileVar); strings.TrimSpace(envFile) != "" {
			candidates = append(candidates, strings.TrimSpace(envFile))
		}
		if exe, err := os.Executable(); err == nil && exe != "" {
			candidates = append(candidates, filepath.Join(filepath.Dir(exe), ".env"))
		}

		for _, p := range candidates {
			if _, err := os.Stat(p); err == nil {
				loadEnvFile(p)
				break
			}
		}

		cwd, err := os.Getwd()
		if err != nil {
			cwd = "."
		}
		hostname, _ := os.Hostname()
		if hostname == "" {
			hostname = "swypik-node"
		}

		origins := GetString("SWYPIK_ALLOWED_ORIGINS", "")
		allowedList := strings.Split(origins, ",")
		for i := range allowedList {
			allowedList[i] = strings.TrimSpace(allowedList[i])
		}

		globalConfig = &Config{
			ServerPort:     GetInt("SWYPIK_PORT", 9876),
			BindHost:       GetString("SWYPIK_BIND_HOST", "127.0.0.1"),
			StaticDir:      GetString("SWYPIK_STATIC_DIR", ""),
			WorkspaceDir:   GetString("SWYPIK_WORKSPACE_DIR", cwd),
			DefaultURL:     GetString("SWYPIK_DEFAULT_URL", "https://swypik.com"),
			AllowedOrigins: allowedList,

			EdgePath:   browserPath("SWYPIK_EDGE_PATH", []string{"msedge", "microsoft-edge"}, "ProgramFiles(x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
			ChromePath: browserPath("SWYPIK_CHROME_PATH", []string{"chrome", "google-chrome", "chromium"}, "ProgramFiles", "Google", "Chrome", "Application", "chrome.exe"),

			SwarmEnabled: GetBool("SWYPIK_SWARM_ENABLED", false),
			NodeID:       GetString("SWYPIK_SWARM_NODE_ID", hostname),
		}
	})

	return globalConfig
}

// Explicit configuration wins. Otherwise discover installed executables rather
// than inventing a C: drive or returning a nonexistent browser path.
func browserPath(key string, commands []string, directoryEnv string, components ...string) string {
	if explicit := os.Getenv(key); explicit != "" {
		return explicit
	}
	for _, command := range commands {
		if path, err := exec.LookPath(command); err == nil {
			return path
		}
	}
	if directory := os.Getenv(directoryEnv); directory != "" && filepath.IsAbs(directory) {
		path := filepath.Join(append([]string{directory}, components...)...)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return path
		}
	}
	return ""
}

// Get returns the loaded singleton configuration.
func Get() *Config {
	return Load()
}

func loadEnvFile(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 {
			k := strings.TrimSpace(parts[0])
			v := strings.TrimSpace(parts[1])
			v = strings.Trim(v, `"'`)
			// Only set if not already set in environment
			if _, exists := os.LookupEnv(k); !exists {
				_ = os.Setenv(k, v)
			}
		}
	}
}

// GetString reads an environment variable or returns default.
func GetString(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

// GetInt reads an integer environment variable or returns default.
func GetInt(key string, defaultVal int) int {
	if val := os.Getenv(key); val != "" {
		if i, err := strconv.Atoi(val); err == nil {
			return i
		}
	}
	return defaultVal
}

// GetBool reads a boolean environment variable or returns default.
func GetBool(key string, defaultVal bool) bool {
	if val := os.Getenv(key); val != "" {
		lower := strings.ToLower(val)
		if lower == "true" || lower == "1" || lower == "yes" {
			return true
		}
		if lower == "false" || lower == "0" || lower == "no" {
			return false
		}
	}
	return defaultVal
}

// GetFloat reads a float64 environment variable or returns default.
func GetFloat(key string, defaultVal float64) float64 {
	if val := os.Getenv(key); val != "" {
		if f, err := strconv.ParseFloat(val, 64); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
			return f
		}
	}
	return defaultVal
}
