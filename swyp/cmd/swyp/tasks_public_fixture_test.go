package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// These fixtures are authored entirely here, without a model, corpus or Forge.
// The 40/20 labels exercise the legacy task format, not a training evaluation.
func publicTaskFixtures(t *testing.T) []forgeTask {
	t.Helper()
	variable := func(name string) any { return map[string]any{"var": name} }
	constant := func(value int) any {
		return map[string]any{"const": map[string]string{"type": "i64", "value": strconv.Itoa(value)}}
	}
	op := func(name string, args ...any) any { return map[string]any{"op": name, "args": args} }
	input := func(name string, min, max int) any {
		return map[string]string{"name": name, "type": "i64", "min": strconv.Itoa(min), "max": strconv.Itoa(max)}
	}
	var tasks []forgeTask
	for _, family := range []string{"affine", "square", "absolute", "maximum", "clamp", "sum"} {
		for variant := 0; variant < 10; variant++ {
			bias := variant - 5
			x, y, n, result := variable("x"), variable("y"), variable("n"), variable("result")
			inputs := []any{input("x", -4, 4)}
			cases := 9
			var body string
			var ensures []any
			signature := "x: i64"
			switch family {
			case "affine":
				body = fmt.Sprintf("return x + %d;", bias)
				ensures = []any{op("eq", result, op("add", x, constant(bias)))}
			case "square":
				body = fmt.Sprintf("return x * x + %d;", bias)
				ensures = []any{op("eq", result, op("add", op("mul", x, x), constant(bias)))}
			case "absolute":
				body = fmt.Sprintf("if x < 0 { return -x + %d; } return x + %d;", bias, bias)
				ensures = []any{op("or",
					op("and", op("lt", x, constant(0)), op("eq", result, op("add", op("neg", x), constant(bias)))),
					op("and", op("ge", x, constant(0)), op("eq", result, op("add", x, constant(bias)))))}
			case "maximum":
				inputs = []any{input("x", -2, 2), input("y", -2, 2)}
				cases, signature = 25, "x: i64, y: i64"
				body = fmt.Sprintf("if x > y { return x + %d; } return y + %d;", bias, bias)
				a, b := op("add", x, constant(bias)), op("add", y, constant(bias))
				ensures = []any{op("ge", result, a), op("ge", result, b), op("or", op("eq", result, a), op("eq", result, b))}
			case "clamp":
				body = fmt.Sprintf("if x < 0 { return %d; } if x > 2 { return %d; } return x + %d;", bias, 2+bias, bias)
				ensures = []any{op("or",
					op("and", op("lt", x, constant(0)), op("eq", result, constant(bias))),
					op("or",
						op("and", op("gt", x, constant(2)), op("eq", result, constant(2+bias))),
						op("and", op("and", op("ge", x, constant(0)), op("le", x, constant(2))), op("eq", result, op("add", x, constant(bias))))))}
			case "sum":
				inputs, signature = []any{input("n", 0, 8)}, "n: i64"
				body = fmt.Sprintf("let total: i64 = 0; let i: i64 = 0; while i <= n { total = total + i; i = i + 1; } return total + %d;", bias)
				ensures = []any{op("eq", op("mul", result, constant(2)), op("add", op("mul", n, op("add", n, constant(1))), constant(2*bias)))}
			}
			contract, err := json.Marshal(map[string]any{"version": 1, "entry": "solve", "inputs": inputs, "ensures": ensures, "max_steps": 4096})
			if err != nil {
				t.Fatal(err)
			}
			split := "train"
			if len(tasks) >= 40 {
				split = "heldout"
			}
			tasks = append(tasks, forgeTask{
				ID: fmt.Sprintf("public-%s-%02d", family, variant), Tier: "synthetic-public", Split: split, Cases: cases,
				Task: "Public synthetic " + family + " reference; not a corpus/model benchmark.", Contract: contract,
				Reference: fmt.Sprintf("fn solve(%s) -> i64 { %s }", signature, body),
			})
		}
	}
	return tasks
}

func publicTaskFixtureJSONL(t *testing.T) []byte {
	t.Helper()
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	for _, task := range publicTaskFixtures(t) {
		if err := encoder.Encode(task); err != nil {
			t.Fatal(err)
		}
	}
	return encoded.Bytes()
}

func TestPublicTaskReferencesAreExhaustive(t *testing.T) {
	fixture := publicTaskFixtureJSONL(t)
	if !bytes.Equal(fixture, publicTaskFixtureJSONL(t)) {
		t.Fatal("public fixtures must be deterministic")
	}
	tasks, err := readTaskReferences(bytes.NewReader(fixture))
	if err != nil {
		t.Fatal(err)
	}
	checkTaskReferences(t, tasks)
}

func TestPublicTaskFixturesRejectIncorrectReferences(t *testing.T) {
	tasks := publicTaskFixtures(t)
	for i := 0; i < len(tasks); i += 10 {
		task := tasks[i]
		t.Run(task.ID, func(t *testing.T) {
			end := strings.Index(task.Reference, "{")
			wrong := task.Reference[:end] + "{ return 999; }"
			response, err := runJudge(t, judgeRequestJSON(t, wrong, string(task.Contract)))
			if err == nil || response["status"] != "counterexample" {
				t.Fatalf("incorrect reference was not rejected: err=%v response=%v", err, response)
			}
		})
	}
}

func TestExternalForgeCorpusConfiguration(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing.jsonl")
	t.Run("configured missing file fails without fallback", func(t *testing.T) {
		t.Setenv(forgeTaskCorpusEnv, missing)
		tasks, enabled, err := configuredForgeTasks()
		if !enabled || tasks != nil || !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("tasks=%v enabled=%v err=%v", tasks, enabled, err)
		}
	})
	t.Run("configured empty path fails", func(t *testing.T) {
		t.Setenv(forgeTaskCorpusEnv, " ")
		tasks, enabled, err := configuredForgeTasks()
		if !enabled || tasks != nil || err == nil {
			t.Fatalf("tasks=%v enabled=%v err=%v", tasks, enabled, err)
		}
	})
	t.Run("explicit public synthetic file loads", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "public-synthetic.jsonl")
		if err := os.WriteFile(path, publicTaskFixtureJSONL(t), 0600); err != nil {
			t.Fatal(err)
		}
		t.Setenv(forgeTaskCorpusEnv, path)
		tasks, enabled, err := configuredForgeTasks()
		if !enabled || err != nil || len(tasks) != 60 || tasks[0].Tier != "synthetic-public" {
			t.Fatalf("count=%d enabled=%v err=%v", len(tasks), enabled, err)
		}
	})
}
