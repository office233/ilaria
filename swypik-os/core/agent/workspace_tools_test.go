package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func toolByName(t *testing.T, tools []Tool, name string) Tool {
	t.Helper()
	for _, tool := range tools {
		if tool.Spec.Name == name {
			return tool
		}
	}
	t.Fatalf("tool %s not registered", name)
	return Tool{}
}

func call(t *testing.T, tool Tool, args string) (map[string]interface{}, error) {
	t.Helper()
	if err := tool.Validate(json.RawMessage(args)); err != nil {
		return nil, err
	}
	out, err := tool.Execute(context.Background(), json.RawMessage(args))
	if err != nil {
		return nil, err
	}
	if len(out) > 12*1024 {
		t.Fatalf("%s output %d bytes exceeds the observation limit", tool.Spec.Name, len(out))
	}
	var m map[string]interface{}
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	return m, nil
}

func TestWorkspaceReadWriteEdit(t *testing.T) {
	root := t.TempDir()
	tools := WorkspaceTools(root, nil)
	read, write, edit := toolByName(t, tools, "workspace.read"), toolByName(t, tools, "workspace.write"), toolByName(t, tools, "workspace.edit")

	if _, err := call(t, write, `{"path":"src/main.go","content":"package main\n\nfunc main() {}\n"}`); err != nil {
		t.Fatalf("create: %v", err)
	}
	r, err := call(t, read, `{"path":"src/main.go"}`)
	if err != nil || !strings.Contains(r["content"].(string), "3\tfunc main() {}") {
		t.Fatalf("read: %v %v", r, err)
	}
	sha := r["sha256"].(string)

	if _, err := call(t, write, `{"path":"src/main.go","content":"x"}`); err == nil {
		t.Fatal("overwrite without sha must fail")
	}
	if _, err := call(t, edit, `{"path":"src/main.go","old":"func main() {}","new":"func main() { run() }","expected_sha256":"`+sha+`"}`); err != nil {
		t.Fatalf("edit: %v", err)
	}
	if _, err := call(t, edit, `{"path":"src/main.go","old":"run()","new":"go()","expected_sha256":"`+sha+`"}`); err == nil {
		t.Fatal("stale sha must be rejected")
	}
	data, _ := os.ReadFile(filepath.Join(root, "src", "main.go"))
	if !strings.Contains(string(data), "run()") {
		t.Fatalf("content %q", data)
	}
	r, _ = call(t, read, `{"path":"src/main.go"}`)
	if _, err := call(t, edit, `{"path":"src/main.go","old":"main","new":"x","expected_sha256":"`+r["sha256"].(string)+`"}`); err == nil || !strings.Contains(err.Error(), "occurs") {
		t.Fatalf("ambiguous edit: %v", err)
	}
}

func TestEditMatchesCRLFFiles(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("one\r\ntwo\r\n"), 0600)
	tools := WorkspaceTools(root, nil)
	r, _ := call(t, toolByName(t, tools, "workspace.read"), `{"path":"a.txt"}`)
	if _, err := call(t, toolByName(t, tools, "workspace.edit"), `{"path":"a.txt","old":"one\ntwo","new":"1\n2","expected_sha256":"`+r["sha256"].(string)+`"}`); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(root, "a.txt")); string(data) != "1\r\n2\r\n" {
		t.Fatalf("%q", data)
	}
}

func TestWorkspaceToolsRejectUnsafePaths(t *testing.T) {
	root := t.TempDir()
	tools := WorkspaceTools(root, nil)
	for _, name := range []string{"workspace.read", "workspace.write"} {
		for _, p := range []string{"../x", ".env", "a/.git/config", "/etc/passwd", `C:\x`, "a/../../x"} {
			args, _ := json.Marshal(map[string]string{"path": p, "content": "x"})
			if name == "workspace.read" {
				args, _ = json.Marshal(map[string]string{"path": p})
			}
			if _, err := call(t, toolByName(t, tools, name), string(args)); err == nil {
				t.Errorf("%s accepted %q", name, p)
			}
		}
	}
	os.WriteFile(filepath.Join(root, "bin.dat"), []byte{0, 1, 2}, 0600)
	if _, err := call(t, toolByName(t, tools, "workspace.read"), `{"path":"bin.dat"}`); err == nil {
		t.Error("binary file read as text")
	}
}

func TestReadOutputFitsWorstCaseEscaping(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "q.txt"), []byte(strings.Repeat(`"\"<>&`+"\n", 3000)), 0600)
	if _, err := call(t, toolByName(t, WorkspaceTools(root, nil), "workspace.read"), `{"path":"q.txt","max_lines":400}`); err != nil {
		t.Fatal(err)
	}
}

func TestProcessRun(t *testing.T) {
	root := t.TempDir()
	var gotDir string
	run := func(_ context.Context, command, dir string) (string, error) {
		gotDir = dir
		if command == "fail" {
			return "boom", errors.New("exit status 1")
		}
		return strings.Repeat("ă", 20000) + "END", nil
	}
	tool := toolByName(t, WorkspaceTools(root, run), "process.run")
	r, err := call(t, tool, `{"command":"go test ./..."}`)
	if err != nil || gotDir != root || !strings.HasSuffix(r["output"].(string), "END") || r["status"] != "succeeded" {
		t.Fatalf("%v %v", r["status"], err)
	}
	if r, _ = call(t, tool, `{"command":"fail"}`); !strings.HasPrefix(r["status"].(string), "failed") {
		t.Fatalf("status %v", r["status"])
	}
	if _, err := call(t, tool, `{"command":"a\nb"}`); err == nil {
		t.Fatal("multi-line command accepted")
	}
	if len(WorkspaceTools(root, nil)) == len(WorkspaceTools(root, run)) {
		t.Fatal("process.run must only exist when a runner is provided")
	}
}

func TestShortNameAliasesRejection(t *testing.T) {
	for _, p := range []string{"ENV~1", "GIT~1/config", "a/GIT~1/hooks/x"} {
		if err := validRelativePath(p); err == nil {
			t.Errorf("validRelativePath accepted short-name path %q", p)
		}
	}
	for _, p := range []string{"file~backup.txt", "normal.txt", "src/main.go", "a/backup~file.go"} {
		if err := validRelativePath(p); err != nil {
			t.Errorf("validRelativePath rejected valid path %q: %v", p, err)
		}
	}

	root := t.TempDir()
	tools := WorkspaceTools(root, nil)
	readTool := toolByName(t, tools, "workspace.read")
	writeTool := toolByName(t, tools, "workspace.write")
	listTool := toolByName(t, tools, "workspace.list")

	for _, p := range []string{"ENV~1", "GIT~1/config", "a/GIT~1/hooks/x"} {
		if _, err := call(t, readTool, `{"path":"`+p+`"}`); err == nil {
			t.Errorf("workspace.read accepted short name %q", p)
		}
		if _, err := call(t, writeTool, `{"path":"`+p+`","content":"test"}`); err == nil {
			t.Errorf("workspace.write accepted short name %q", p)
		}
	}
	if _, err := call(t, listTool, `{"path":"GIT~1"}`); err == nil {
		t.Error("workspace.list accepted short name GIT~1")
	}

	if _, err := call(t, writeTool, `{"path":"file~backup.txt","content":"backup text"}`); err != nil {
		t.Fatalf("failed to write file~backup.txt: %v", err)
	}
	res, err := call(t, readTool, `{"path":"file~backup.txt"}`)
	if err != nil {
		t.Fatalf("failed to read file~backup.txt: %v", err)
	}
	if !strings.Contains(res["content"].(string), "backup text") {
		t.Fatalf("unexpected content for file~backup.txt: %+v", res)
	}
}
