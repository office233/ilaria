package nexusbridge

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRealWorkerBridge(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "swyp-worker.exe")
	build := exec.Command("go", "build", "-o", exe, "./cmd/swyp")
	build.Dir = filepath.Join("..", "..")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	tool, err := NewTool(exe)
	if err != nil {
		t.Fatal(err)
	}
	out, ok := tool.Execute(`swyp: {"examples":[{"x":0,"y":0},{"x":1,"y":1}],"validation":[{"x":2,"y":4}]}`)
	if !ok {
		t.Fatal("worker bridge failed")
	}
	var response map[string]any
	if err := json.Unmarshal([]byte(out), &response); err != nil {
		t.Fatal(err)
	}
	if response["status"] != "candidate" || response["graph"] == nil {
		t.Fatalf("%s", out)
	}
	if _, ok := tool.Execute(`swyp: {"examples":[{"x":0}],"command":"execute"}`); ok {
		t.Fatal("accepted invalid request")
	}
	if _, ok := tool.Execute("swyp: " + strings.Repeat("x", 65537)); ok {
		t.Fatal("accepted oversized request")
	}
}

func TestBridgeConfiguration(t *testing.T) {
	if _, err := NewTool("swyp.exe"); err == nil {
		t.Fatal("accepted PATH executable")
	}
	var out boundedBuffer
	out.limit = 2
	if _, err := out.Write([]byte("abc")); err == nil {
		t.Fatal("ignored output cap")
	}
}
