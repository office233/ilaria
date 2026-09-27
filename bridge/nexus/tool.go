// Package nexusbridge adapts Swyp's bounded worker to Nexus cortex.Tool's
// structural interface. It never uses a shell or installs an active program.
package nexusbridge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Tool struct{ executable string }

func NewTool(executable string) (*Tool, error) {
	if !filepath.IsAbs(executable) {
		return nil, fmt.Errorf("Swyp executable requires an absolute path")
	}
	return &Tool{executable: filepath.Clean(executable)}, nil
}
func (t *Tool) Name() string { return "swyp_synthesis" }
func (t *Tool) Match(input string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(input)), "swyp:")
}

type boundedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if len(p) > b.limit-b.Len() {
		return 0, io.ErrShortBuffer
	}
	return b.Buffer.Write(p)
}

// Execute accepts only an explicit swyp: JSON request. Input cannot select the
// executable or its arguments. The response contains a candidate, not promotion.
func (t *Tool) Execute(input string) (string, bool) {
	input = strings.TrimSpace(input)
	if t == nil || !t.Match(input) {
		return "", false
	}
	payload := strings.TrimSpace(input[len("swyp:"):])
	if len(payload) > 64*1024 || !json.Valid([]byte(payload)) {
		return "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, t.executable, "worker")
	cmd.Stdin = strings.NewReader(payload)
	out := &boundedBuffer{limit: 64 * 1024}
	diagnostic := &boundedBuffer{limit: 4096}
	cmd.Stdout = out
	cmd.Stderr = diagnostic
	if err := cmd.Run(); err != nil {
		return "", false
	}
	var response struct {
		Version      int    `json:"version"`
		Status       string `json:"status"`
		SourceSHA256 string `json:"source_sha256"`
		Result       struct {
			Source string `json:"source"`
		} `json:"result"`
	}
	if json.Unmarshal(out.Bytes(), &response) != nil || response.Version != 1 || response.Status != "candidate" || response.Result.Source == "" {
		return "", false
	}
	hash := sha256.Sum256([]byte(response.Result.Source))
	if response.SourceSHA256 != hex.EncodeToString(hash[:]) {
		return "", false
	}
	return strings.TrimSpace(out.String()), true
}

// Matches the inspected D:/nexus/cortex/tools.go Tool contract without a Nexus
// dependency, allowing Nexus to register this adapter explicitly at startup.
var _ interface {
	Name() string
	Match(string) bool
	Execute(string) (string, bool)
} = (*Tool)(nil)
