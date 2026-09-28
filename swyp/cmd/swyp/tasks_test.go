package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// examples/swyp/tasks/tasks.jsonl is the Swyp Forge task corpus
// (built by forge/swypforge/build_tasks.py in the Nexus repository). Every
// reference solution must satisfy its own contract with an exhaustive verdict,
// which proves each contract is satisfiable and small enough to enumerate.

type forgeTask struct {
	ID        string          `json:"id"`
	Tier      string          `json:"tier"`
	Split     string          `json:"split"`
	Cases     int             `json:"cases"`
	Task      string          `json:"task"`
	Contract  json.RawMessage `json:"contract"`
	Reference string          `json:"reference"`
}

func loadForgeTasks(t *testing.T) []forgeTask {
	t.Helper()
	f, err := os.Open(filepath.Join("..", "..", "examples", "swyp", "tasks", "tasks.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var tasks []forgeTask
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		var task forgeTask
		if err := json.Unmarshal(sc.Bytes(), &task); err != nil {
			t.Fatal(err)
		}
		tasks = append(tasks, task)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return tasks
}

func TestForgeTaskReferencesAreExhaustive(t *testing.T) {
	tasks := loadForgeTasks(t)
	if len(tasks) != 60 {
		t.Fatalf("want 60 tasks, got %d", len(tasks))
	}
	split := map[string]int{}
	for _, task := range tasks {
		split[task.Split]++
		task := task
		t.Run(task.ID, func(t *testing.T) {
			if task.Cases > 256 {
				t.Fatalf("%d cases would be sampled, not enumerated", task.Cases)
			}
			resp, err := runJudge(t, judgeRequestJSON(t, task.Reference, string(task.Contract)))
			if err != nil || resp["status"] != "exhaustive" {
				t.Fatalf("reference not exhaustive: err=%v summary=%v", err, resp["summary"])
			}
			if want := "PASS exhaustive"; !strings.HasPrefix(resp["summary"].(string), want) {
				t.Fatalf("summary %q", resp["summary"])
			}
		})
	}
	if split["train"] != 40 || split["heldout"] != 20 {
		t.Fatalf("split must be 40 train / 20 held-out, got %v", split)
	}
}
