package config

import (
	"fmt"
	"os"
	"path/filepath"
)

// DaemonConfig uses per-user OS directories and explicit workspace authority.
// Flags in swypikd may override every value; no user name or system directory
// is baked into the binary.
type DaemonConfig struct {
	Socket    string
	Workspace string
	Index     string
	StateDir  string
	IlariaURL string
}

func DefaultDaemonConfig() (DaemonConfig, error) {
	dataRoot := os.Getenv("SWYPIK_DAEMON_DATA_DIR")
	if dataRoot == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return DaemonConfig{}, fmt.Errorf("resolve user configuration directory: %w", err)
		}
		dataRoot = filepath.Join(base, "swypik", "daemon")
	}
	runtimeRoot := os.Getenv("SWYPIK_DAEMON_RUNTIME_DIR")
	if runtimeRoot == "" {
		if base := os.Getenv("XDG_RUNTIME_DIR"); base != "" {
			runtimeRoot = filepath.Join(base, "swypik")
		} else {
			base, err := os.UserCacheDir()
			if err != nil {
				return DaemonConfig{}, fmt.Errorf("resolve user runtime directory: %w", err)
			}
			runtimeRoot = filepath.Join(base, "swypik", "run")
		}
	}
	if !filepath.IsAbs(dataRoot) || !filepath.IsAbs(runtimeRoot) {
		return DaemonConfig{}, fmt.Errorf("daemon data and runtime directories must be absolute")
	}
	return DaemonConfig{
		Socket:    filepath.Join(runtimeRoot, "control.sock"),
		Workspace: os.Getenv("SWYPIK_WORKSPACE_DIR"),
		Index:     filepath.Join(dataRoot, "index.jsonl"),
		StateDir:  filepath.Join(dataRoot, "agent"),
		IlariaURL: GetString("SWYPIK_ILARIA_URL", DefaultIlariaURL),
	}, nil
}

func (c DaemonConfig) Validate() error {
	for name, path := range map[string]string{
		"socket": c.Socket, "workspace": c.Workspace, "index": c.Index, "state-dir": c.StateDir,
	} {
		if path == "" || !filepath.IsAbs(path) {
			return fmt.Errorf("--%s must be an explicit absolute path", name)
		}
	}
	_, err := ValidateIlariaURL(c.IlariaURL)
	return err
}
