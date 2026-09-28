package desktop

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"swypik-os/config"
	"swypik-os/core/agent"
	"swypik-os/core/compute"
	"swypik-os/core/ilaria"
	"swypik-os/core/search"
)

type scriptedBackend struct {
	mu      sync.Mutex
	replies []string
	err     error
}

func (b *scriptedBackend) Chat(_ context.Context, prompt string, _ []ilaria.Message) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.err != nil {
		return "", b.err
	}
	if len(b.replies) == 0 {
		return "ok", nil
	}
	r := b.replies[0]
	b.replies = b.replies[1:]
	return r, nil
}

type fixture struct {
	c        *Controller
	backend  *scriptedBackend
	root     string
	settings string
	applied  string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{backend: &scriptedBackend{}, root: t.TempDir()}
	f.settings = filepath.Join(t.TempDir(), "settings.json")
	chat := ilaria.NewEngine()
	chat.SetBackend(f.backend)
	idx := search.NewEngine()
	mgr, err := agent.New(agent.JSONPlanner{Complete: chat.Complete}, agent.WorkspaceTools(f.root, nil), agent.Limits{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mgr.Close)
	s, _ := config.LoadSettings(f.settings)
	f.c = New(Deps{
		Chat: chat, Agent: mgr, Search: idx, Workspace: f.root, SettingsPath: f.settings, Settings: s,
		Health:      func(context.Context) error { return errors.New("unreachable") },
		ApplyIlaria: func(u string) error { f.applied = u; return nil },
		Compute: func(ctx context.Context, on bool, coord string) compute.Status {
			return compute.Status{Contribute: on, Coordinator: coord, Reason: "test"}
		},
	})
	return f
}

func waitFor(t *testing.T, what string, ok func(View) bool, c *Controller) View {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if v := c.View(); ok(v) {
			return v
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s: %+v", what, c.View())
	return View{}
}

func hasBlock(v View, kind Kind, substr string) bool {
	for _, b := range v.Blocks {
		if b.Kind == kind && strings.Contains(b.Title+"\n"+b.Body, substr) {
			return true
		}
	}
	return false
}

func TestChatShowsReplyAndErrors(t *testing.T) {
	f := newFixture(t)
	f.backend.replies = []string{"Salut! Sunt Ilaria."}
	f.c.Submit("Salut")
	v := waitFor(t, "reply", func(v View) bool { return !v.Busy && hasBlock(v, KindAssistant, "Sunt Ilaria") }, f.c)
	if !hasBlock(v, KindUser, "Salut") {
		t.Fatal("user message missing")
	}
	f.backend.err = errors.New("HTTP 503")
	f.c.Submit("din nou")
	waitFor(t, "error", func(v View) bool { return !v.Busy && hasBlock(v, KindError, "HTTP 503") }, f.c)
}

func TestAgentWriteNeedsApproval(t *testing.T) {
	f := newFixture(t)
	f.backend.replies = []string{
		`{"action":"tool","tool":"workspace.write","arguments":{"path":"notes/todo.md","content":"# Plan\n- test"}}`,
		`{"action":"finish","summary":"Am creat notes/todo.md."}`,
	}
	f.c.SetTab(TabAgent)
	f.c.Submit("creează un plan")
	v := waitFor(t, "approval", func(v View) bool { return v.Prompt != nil }, f.c)
	if !v.Prompt.Approval || v.Prompt.Title != "Creează notes/todo.md" || !strings.Contains(v.Prompt.Body, "# Plan") {
		t.Fatalf("prompt %+v", v.Prompt)
	}
	if _, err := os.Stat(filepath.Join(f.root, "notes", "todo.md")); err == nil {
		t.Fatal("file written before approval")
	}
	f.c.Confirm()
	v = waitFor(t, "summary", func(v View) bool { return hasBlock(v, KindAssistant, "Am creat") }, f.c)
	if !hasBlock(v, KindTool, "Creează notes/todo.md") {
		t.Fatal("tool evidence missing from transcript")
	}
	if data, err := os.ReadFile(filepath.Join(f.root, "notes", "todo.md")); err != nil || !strings.Contains(string(data), "- test") {
		t.Fatalf("%q %v", data, err)
	}
}

func TestAgentDenialStopsRun(t *testing.T) {
	f := newFixture(t)
	f.backend.replies = []string{`{"action":"tool","tool":"workspace.write","arguments":{"path":"x.txt","content":"x"}}`}
	f.c.SetTab(TabAgent)
	f.c.Submit("scrie")
	waitFor(t, "approval", func(v View) bool { return v.Prompt != nil }, f.c)
	f.c.Reject()
	waitFor(t, "cancelled", func(v View) bool { return v.Prompt == nil && hasBlock(v, KindInfo, "Rulare oprită") }, f.c)
	if _, err := os.Stat(filepath.Join(f.root, "x.txt")); err == nil {
		t.Fatal("denied write executed")
	}
}

func TestSearchIndexAndCrawlConfirmation(t *testing.T) {
	f := newFixture(t)
	os.WriteFile(filepath.Join(f.root, "readme.md"), []byte("Ilaria controlează agenții locali"), 0600)
	f.c.SetTab(TabSearch)
	f.c.Submit("/index")
	waitFor(t, "index", func(v View) bool { return !v.Busy && hasBlock(v, KindInfo, "Indexare locală terminată") }, f.c)
	f.c.Submit("agentii")
	v := f.c.View()
	found := false
	for _, b := range v.Blocks {
		if b.Kind == KindResult && strings.HasPrefix(b.Action, "open:file:") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no local result: %+v", v.Blocks)
	}
	f.c.Submit("/crawl example.org 3")
	v = f.c.View()
	if v.Prompt == nil || v.Prompt.Approval || !strings.Contains(v.Prompt.Body, "https://example.org") {
		t.Fatalf("crawl must ask first: %+v", v.Prompt)
	}
	f.c.Submit("altceva")
	if !hasBlock(f.c.View(), KindError, "confirmarea") {
		t.Fatal("input while a confirmation is pending must be refused")
	}
	f.c.Reject()
	if v = f.c.View(); v.Prompt != nil || v.Busy {
		t.Fatal("rejected crawl must not start")
	}
}

func TestFilesStayInsideWorkspace(t *testing.T) {
	f := newFixture(t)
	os.MkdirAll(filepath.Join(f.root, "src"), 0700)
	os.WriteFile(filepath.Join(f.root, "src", "main.go"), []byte("package main"), 0600)
	f.c.SetTab(TabFiles)
	if f.c.Activate("files:src") != "" || !hasBlock(f.c.View(), KindResult, "main.go") {
		t.Fatal("navigation failed")
	}
	f.c.Activate("files:src/main.go")
	if !hasBlock(f.c.View(), KindCode, "package main") {
		t.Fatal("preview failed")
	}
	f.c.Activate("files:../..")
	if !hasBlock(f.c.View(), KindError, "") {
		t.Fatal("traversal must be refused")
	}
}

func TestSettingsAndCompute(t *testing.T) {
	f := newFixture(t)
	f.c.SetTab(TabSettings)
	f.c.Submit("/ilaria http://evil.example")
	if f.applied != "" || !hasBlock(f.c.View(), KindError, "HTTPS") {
		t.Fatal("insecure endpoint accepted")
	}
	f.c.Submit("/ilaria https://ilaria.example.net/")
	if f.applied != "https://ilaria.example.net" {
		t.Fatalf("applied %q", f.applied)
	}
	if s, _ := config.LoadSettings(f.settings); s.IlariaURL != "https://ilaria.example.net" {
		t.Fatal("setting not saved")
	}
	f.c.SetTab(TabCompute)
	waitFor(t, "compute", func(v View) bool { return !v.Busy && hasBlock(v, KindTool, "OPRITĂ") }, f.c)
	f.c.Submit("/on")
	waitFor(t, "compute on", func(v View) bool { return !v.Busy && hasBlock(v, KindTool, "PERMISĂ") }, f.c)
	if s, _ := config.LoadSettings(f.settings); !s.Compute.Contribute {
		t.Fatal("consent not saved")
	}
}

func TestDescribeEditShowsDiff(t *testing.T) {
	title, body := DescribeApproval("workspace.edit", []byte(`{"path":"a.go","old":"x := 1","new":"x := 2","expected_sha256":"`+strings.Repeat("a", 64)+`"}`))
	if title != "Editează a.go" || body != "- x := 1\n+ x := 2" {
		t.Fatalf("%q %q", title, body)
	}
}

func TestHomeNavigatesAndStartsChat(t *testing.T) {
	f := newFixture(t)
	v := f.c.View()
	if v.Tab != TabHome || len(v.Tiles) < 6 {
		t.Fatalf("home must open first with tiles: %+v", v.Tab)
	}
	f.c.Submit("deschide căutare")
	if f.c.Tab() != TabSearch {
		t.Fatalf("navigation by name failed: %v", f.c.Tab())
	}
	f.c.SetTab(TabHome)
	if ext := f.c.Activate("tab:4"); ext != "" || f.c.Tab() != TabFiles {
		t.Fatal("tile navigation failed")
	}
	if f.c.Activate("fill:/crawl https://") != "fill:/crawl https://" {
		t.Fatal("fill actions are performed by the window")
	}
	f.c.SetTab(TabHome)
	f.backend.replies = []string{"Bună!"}
	f.c.Submit("Bună, Ilaria")
	waitFor(t, "chat from home", func(v View) bool { return v.Tab == TabChat && hasBlock(v, KindAssistant, "Bună!") }, f.c)
}
