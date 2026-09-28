package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Settings is the desktop configuration file (settings.json in the data
// directory). Nothing in it is a secret: the Ilaria token lives in a separate
// private file or in the ILARIA_API_TOKEN environment variable.
type Settings struct {
	// IlariaURL is the Ilaria service origin: an authenticated HTTPS deployment
	// (for example the Azure endpoint) or a loopback development service.
	IlariaURL string `json:"ilaria_url"`
	// IlariaTokenFile overrides <data dir>/ilaria.token.
	IlariaTokenFile string `json:"ilaria_token_file,omitempty"`
	// Workspace is the directory the agent may read and change.
	Workspace string          `json:"workspace,omitempty"`
	Compute   ComputeSettings `json:"compute"`
}

// ComputeSettings records the user's decision about contributing this
// device's GPU to Ilaria training. Contribution is off unless the user turns
// it on; see docs/ILARIA_COMPUTE.md for the protocol it requires.
type ComputeSettings struct {
	Contribute     bool   `json:"contribute"`
	CoordinatorURL string `json:"coordinator_url,omitempty"`
}

// DefaultIlariaURL is the local development service (Nexus ilaria-serve).
const DefaultIlariaURL = "http://127.0.0.1:8091"

// LoadSettings reads path strictly. A missing file yields defaults.
func LoadSettings(path string) (Settings, error) {
	s := Settings{IlariaURL: DefaultIlariaURL}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if len(raw) > 64*1024 {
		return s, fmt.Errorf("settings file too large")
	}
	d := json.NewDecoder(bytes.NewReader(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))))
	d.DisallowUnknownFields()
	if err := d.Decode(&s); err != nil {
		return s, fmt.Errorf("%s: %w", path, err)
	}
	if s.IlariaURL == "" {
		s.IlariaURL = DefaultIlariaURL
	}
	if s.IlariaURL, err = ValidateIlariaURL(s.IlariaURL); err != nil {
		return s, fmt.Errorf("%s: %w", path, err)
	}
	if s.Compute.CoordinatorURL != "" {
		if u, err := url.Parse(s.Compute.CoordinatorURL); err != nil || u.Scheme != "https" || u.Host == "" {
			return s, fmt.Errorf("%s: compute.coordinator_url must be an https URL", path)
		}
	}
	return s, nil
}

// SaveSettings writes path atomically with private permissions.
func SaveSettings(path string, s Settings) error {
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".settings-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.Write(append(raw, '\n'))
	if err == nil {
		err = tmp.Sync()
	}
	if err = errors.Join(err, tmp.Close()); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// ValidateIlariaURL accepts an origin (no credentials, path, query or
// fragment) over HTTPS, or plain HTTP only on the loopback address.
func ValidateIlariaURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.User != nil || u.Hostname() == "" || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("invalid Ilaria endpoint: expected an origin such as https://ilaria.example.com")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && u.Hostname() == "127.0.0.1") {
		return "", fmt.Errorf("Ilaria requires HTTPS, or HTTP on 127.0.0.1 for local development")
	}
	return strings.TrimRight(u.Scheme+"://"+u.Host, "/"), nil
}

// ResolveToken returns the Ilaria bearer token: ILARIA_API_TOKEN if set,
// otherwise the first line of tokenFile. A missing file is not an error.
func ResolveToken(tokenFile string) (string, error) {
	if t := strings.TrimSpace(os.Getenv("ILARIA_API_TOKEN")); t != "" {
		return t, nil
	}
	if tokenFile == "" {
		return "", nil
	}
	info, err := os.Stat(tokenFile)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() > 4096 {
		return "", fmt.Errorf("token file must be a small regular file")
	}
	raw, err := os.ReadFile(tokenFile)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(strings.SplitN(string(raw), "\n", 2)[0]), nil
}
