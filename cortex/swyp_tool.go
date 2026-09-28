package cortex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// SwypJudgeChatTool lets the model check a Swyp function against a contract
// by running `swyp judge` (D:/swyp lang, cmd/swyp/judge.go) as a child
// process. The executable path is fixed at construction and the only argument
// is the literal "judge": model input reaches the process solely as bounded
// JSON on stdin, never as a command line, path or shell text. The verifier
// executes the candidate only inside Swyp's fuel-bounded core interpreter, so
// no model-written code runs natively on the host.
//
// The result fed back is Swyp's one-line summary — "PASS exhaustive: ...",
// "FAIL counterexample: square(x=-100) returned -200, ..." or "ERROR
// candidate.swyp:2:16: ..." — which the model can use to repair its next
// attempt.
type SwypJudgeChatTool struct{ executable string }

// NewSwypJudgeChatTool requires an absolute path so the binary cannot be
// resolved through PATH or the working directory.
func NewSwypJudgeChatTool(executable string) (*SwypJudgeChatTool, error) {
	if !filepath.IsAbs(executable) {
		return nil, fmt.Errorf("swyp executable must be an absolute path, got %q", executable)
	}
	return &SwypJudgeChatTool{executable: filepath.Clean(executable)}, nil
}

const (
	swypJudgeTimeout   = 10 * time.Second
	swypJudgeMaxArgs   = 32 * 1024
	swypJudgeMaxOutput = 64 * 1024
)

func (*SwypJudgeChatTool) Name() string { return "swyp" }
func (*SwypJudgeChatTool) Describe() string {
	return `swyp: {"source":"<one Swyp function>","contract":<contract JSON from the task>} — verifies the function against the contract; returns PASS, or a counterexample/error to fix`
}

type swypJudgeArgs struct {
	Source   string          `json:"source"`
	Contract json.RawMessage `json:"contract"`
}

type swypCappedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *swypCappedBuffer) Write(p []byte) (int, error) {
	if len(p) > b.limit-b.Len() {
		return 0, io.ErrShortBuffer
	}
	return b.Buffer.Write(p)
}

func (t *SwypJudgeChatTool) Call(ctx context.Context, args string) (string, error) {
	if t == nil || t.executable == "" {
		return "", fmt.Errorf("swyp is disabled (no -swyp executable configured)")
	}
	args = strings.TrimSpace(args)
	if len(args) > swypJudgeMaxArgs {
		return "", fmt.Errorf("swyp request exceeds %d bytes", swypJudgeMaxArgs)
	}
	var in swypJudgeArgs
	dec := json.NewDecoder(strings.NewReader(args))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		return "", fmt.Errorf(`expected {"source":"...","contract":{...}}: %v`, err)
	}
	if strings.TrimSpace(in.Source) == "" || len(in.Contract) == 0 {
		return "", fmt.Errorf(`both "source" and "contract" are required`)
	}
	request, err := json.Marshal(struct {
		Version  int             `json:"version"`
		Source   string          `json:"source"`
		Contract json.RawMessage `json:"contract"`
	}{1, in.Source, in.Contract})
	if err != nil {
		return "", err
	}
	cctx, cancel := context.WithTimeout(ctx, swypJudgeTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, t.executable, "judge")
	cmd.Stdin = bytes.NewReader(request)
	stdout := &swypCappedBuffer{limit: swypJudgeMaxOutput}
	stderr := &swypCappedBuffer{limit: 4096}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = time.Second
	runErr := cmd.Run()
	if cctx.Err() != nil {
		return "", fmt.Errorf("swyp judge timed out after %s", swypJudgeTimeout)
	}
	// A FAIL or ERROR verdict exits nonzero but is still a well-formed answer
	// for the model; only a missing or malformed verdict is a tool error.
	var verdict struct {
		Status  string `json:"status"`
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &verdict); err != nil || verdict.Summary == "" {
		var exitErr *exec.ExitError
		if runErr != nil && !errors.As(runErr, &exitErr) {
			return "", fmt.Errorf("swyp judge could not run: %v", runErr)
		}
		return "", fmt.Errorf("swyp judge returned no verdict: %s", truncateForTool(strings.TrimSpace(stderr.String()), 300))
	}
	return verdict.Summary, nil
}
