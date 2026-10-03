package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
)

// Public synthetic references always exercise the deterministic Swyp judge.
// Auditing a separately generated Forge corpus requires explicit opt-in; the
// default test suite does not read a training corpus or require its artifacts.
const forgeTaskCorpusEnv = "SWYP_FORGE_TASK_CORPUS"

type forgeTask struct {
	ID        string          `json:"id"`
	Tier      string          `json:"tier"`
	Split     string          `json:"split"`
	Cases     int             `json:"cases"`
	Task      string          `json:"task"`
	Contract  json.RawMessage `json:"contract"`
	Reference string          `json:"reference"`
}

func readTaskReferences(reader io.Reader) ([]forgeTask, error) {
	var tasks []forgeTask
	sc := bufio.NewScanner(reader)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	line := 0
	for sc.Scan() {
		line++
		var task forgeTask
		if err := json.Unmarshal(sc.Bytes(), &task); err != nil {
			return nil, fmt.Errorf("task reference line %d: %w", line, err)
		}
		tasks = append(tasks, task)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return tasks, nil
}

func configuredForgeTasks() ([]forgeTask, bool, error) {
	path, enabled := os.LookupEnv(forgeTaskCorpusEnv)
	if !enabled {
		return nil, false, nil
	}
	if strings.TrimSpace(path) == "" {
		return nil, true, fmt.Errorf("%s must name an explicit corpus file", forgeTaskCorpusEnv)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, true, err
	}
	defer f.Close()
	tasks, err := readTaskReferences(f)
	return tasks, true, err
}

func checkTaskReferences(t *testing.T, tasks []forgeTask) {
	t.Helper()
	if len(tasks) != 60 {
		t.Fatalf("want 60 tasks, got %d", len(tasks))
	}
	split := map[string]int{}
	seen := map[string]bool{}
	for _, task := range tasks {
		if task.ID == "" || seen[task.ID] {
			t.Fatalf("task ID must be nonempty and unique: %q", task.ID)
		}
		seen[task.ID] = true
		split[task.Split]++
		task := task
		t.Run(task.ID, func(t *testing.T) {
			if task.Cases < 1 || task.Cases > 256 {
				t.Fatalf("want 1..256 exhaustive cases, got %d", task.Cases)
			}
			resp, err := runJudge(t, judgeRequestJSON(t, task.Reference, string(task.Contract)))
			if err != nil || resp["status"] != "exhaustive" {
				t.Fatalf("reference not exhaustive: err=%v summary=%v", err, resp["summary"])
			}
			summary, _ := resp["summary"].(string)
			if !strings.HasPrefix(summary, "PASS exhaustive") {
				t.Fatalf("summary %q", summary)
			}
			if resp["cases_checked"] != float64(task.Cases) {
				t.Fatalf("checked %v cases, declared %d", resp["cases_checked"], task.Cases)
			}
		})
	}
	if split["train"] != 40 || split["heldout"] != 20 {
		t.Fatalf("split must be 40 train / 20 held-out, got %v", split)
	}
}

func TestForgeTaskReferencesAreExhaustive(t *testing.T) {
	tasks, enabled, err := configuredForgeTasks()
	if !enabled {
		t.Skip("external Forge corpus audit requires explicit " + forgeTaskCorpusEnv)
	}
	if err != nil {
		t.Fatal(err)
	}
	checkTaskReferences(t, tasks)
}
