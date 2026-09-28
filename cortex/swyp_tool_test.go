package cortex

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const swypTestContract = `{"version":1,"entry":"square","inputs":[{"name":"x","type":"i64","min":"-100","max":"100"}],"ensures":[{"op":"eq","args":[{"var":"result"},{"op":"mul","args":[{"var":"x"},{"var":"x"}]}]}],"max_steps":100}`

func buildFakeSwyp(t *testing.T) string {
	t.Helper()
	exe := filepath.Join(t.TempDir(), "fakeswyp")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	build := exec.Command("go", "build", "-o", exe, "./testdata/fakeswyp")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fakeswyp: %v\n%s", err, out)
	}
	return exe
}

func swypArgs(source string) string {
	return `{"source":"` + source + `","contract":` + swypTestContract + `}`
}

func TestSwypJudgeChatTool(t *testing.T) {
	tool, err := NewSwypJudgeChatTool(buildFakeSwyp(t))
	if err != nil {
		t.Fatal(err)
	}
	if tool.Name() != "swyp" || !strings.HasPrefix(tool.Describe(), "swyp: ") {
		t.Fatalf("name/describe: %q %q", tool.Name(), tool.Describe())
	}
	ctx := context.Background()

	out, err := tool.Call(ctx, swypArgs("fn square(x: i64) -> i64 { return x * x; }"))
	if err != nil || !strings.HasPrefix(out, "PASS exhaustive") {
		t.Fatalf("pass: %q %v", out, err)
	}
	// A failing verdict exits nonzero but must reach the model as a result.
	out, err = tool.Call(ctx, swypArgs("fn square(x: i64) -> i64 { return x + x; }"))
	if err != nil || !strings.HasPrefix(out, "FAIL counterexample") {
		t.Fatalf("counterexample: %q %v", out, err)
	}
	if _, err := tool.Call(ctx, swypArgs("GARBAGE")); err == nil {
		t.Fatal("accepted a malformed verdict")
	}
	for name, args := range map[string]string{
		"not json":         "fn square(x: i64) -> i64 { return x * x; }",
		"unknown field":    `{"source":"fn f() {}","contract":{},"exe":"cmd.exe"}`,
		"missing source":   `{"contract":` + swypTestContract + `}`,
		"missing contract": `{"source":"fn f() {}"}`,
		"oversize":         swypArgs(strings.Repeat("x", swypJudgeMaxArgs)),
	} {
		if out, err := tool.Call(ctx, args); err == nil {
			t.Fatalf("%s: accepted %q", name, out)
		}
	}
}

func TestSwypJudgeChatToolTimeout(t *testing.T) {
	if testing.Short() {
		t.Skip("waits for the judge timeout")
	}
	tool, err := NewSwypJudgeChatTool(buildFakeSwyp(t))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200e6) // 200ms
	defer cancel()
	if _, err := tool.Call(ctx, swypArgs("SLEEP")); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("want timeout, got %v", err)
	}
}

func TestSwypJudgeChatToolConfiguration(t *testing.T) {
	if _, err := NewSwypJudgeChatTool("swyp.exe"); err == nil {
		t.Fatal("accepted a relative executable")
	}
	var disabled *SwypJudgeChatTool
	if _, err := disabled.Call(context.Background(), swypArgs("x")); err == nil {
		t.Fatal("nil tool ran")
	}
}

// TestSwypJudgeChatToolRealSwyp runs against a real Swyp build when
// SWYP_EXE points to one (e.g. <repo>/swyp/bin/swyp.exe).
func TestSwypJudgeChatToolRealSwyp(t *testing.T) {
	tool := realSwypOrSkip(t)
	for source, want := range map[string]string{
		"fn square(x: i64) -> i64 { return x * x; }": "PASS exhaustive",
		"fn square(x: i64) -> i64 { return x + x; }": "FAIL counterexample: square(x=-100) returned -200",
		"fn square(x: i64) -> i64 { return x * ; }":  "ERROR candidate.swyp:1:",
	} {
		out, err := tool.Call(context.Background(), swypArgs(source))
		if err != nil || !strings.HasPrefix(out, want) {
			t.Fatalf("%s: got %q %v, want prefix %q", source, out, err, want)
		}
	}
}

func realSwypOrSkip(t *testing.T) *SwypJudgeChatTool {
	t.Helper()
	exe := os.Getenv("SWYP_EXE")
	if exe == "" {
		t.Skip("SWYP_EXE not set")
	}
	tool, err := NewSwypJudgeChatTool(exe)
	if err != nil {
		t.Fatal(err)
	}
	return tool
}
