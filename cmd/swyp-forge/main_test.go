package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	cortex "ilaria/cortex"
)

const absRef = "fn absolute(x: i64) -> i64 {\n    if x < 0 {\n        return -x;\n    }\n    return x;\n}"

func TestMutantsAreSingleSiteAndSkipSignature(t *testing.T) {
	ms := mutants(absRef)
	ops := map[string][]string{}
	for _, m := range ms {
		if !strings.HasPrefix(m.Source, "fn absolute(x: i64) -> i64 {") {
			t.Fatalf("signature changed: %q", m.Source)
		}
		ops[m.Op] = append(ops[m.Op], m.Source)
	}
	want := map[string]string{
		"cmp_invert":     "if x >= 0 {",
		"cmp_boundary":   "if x <= 0 {",
		"const_plus_one": "if x < 1 {",
		"swap_returns":   "return x;\n    }\n    return -x;",
		"drop_base_case": "fn absolute(x: i64) -> i64 {\n    return x;\n}",
	}
	for op, frag := range want {
		if len(ops[op]) != 1 || !strings.Contains(ops[op][0], frag) {
			t.Fatalf("%s: %q", op, ops[op])
		}
	}
	if len(ops["arith_swap"]) != 0 {
		t.Fatalf("unary minus must not be treated as subtraction: %q", ops["arith_swap"])
	}
	if got := mutants("fn f(a: i64, b: i64) -> i64 {\n    return (a + b) / 2;\n}"); len(got) != 4 {
		// + -> -, / -> *, 2 -> 3, 2 -> 1
		t.Fatalf("got %d mutants: %+v", len(got), got)
	}
}

func TestSyntaxMutantsReproduceObservedHabits(t *testing.T) {
	src := "fn sum_to(n: i64) -> i64 {\n    let total: i64 = 0;\n    if n < 0 {\n        return 0;\n    }\n    if n == 0 {\n        return 0;\n    }\n    total = total + n;\n    return total;\n}"
	got := map[string]string{}
	for _, m := range syntaxMutants(src) {
		got[m.Op] = m.Source
	}
	for op, frag := range map[string]string{
		"missing_semicolon": "        return 0\n    }",
		"else_if":           "    } else if n == 0 {",
		"compound_assign":   "    total += n;",
		"let_mut":           "let mut total: i64 = 0;",
		"untyped_let":       "let total = 0;",
	} {
		if !strings.Contains(got[op], frag) {
			t.Fatalf("%s: %q", op, got[op])
		}
	}
}

func TestSyntaxRepairsKeptOnlyForJudgeErrors(t *testing.T) {
	dir := t.TempDir()
	tasks, _ := loadTasks(writeTasks(t, dir))
	refs := map[string]bool{}
	for _, tk := range tasks {
		refs[tk.Reference] = true
	}
	base := fakeJudge(refs)
	judge := func(ctx context.Context, src string, c json.RawMessage) (cortex.SwypVerdict, error) {
		if strings.Contains(src, "return -x\n") {
			return cortex.SwypVerdict{Status: "error", Summary: `ERROR candidate.swyp:4:5: expected ";", got "}"`}, nil
		}
		return base(ctx, src, c)
	}
	out, err := build(context.Background(), tasks, "seed", 2, nil, judge)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, r := range append(out.Train, out.Validation...) {
		if r.Kind == "repair_syntax" {
			n++
			if r.Op != "missing_semicolon" || !strings.Contains(r.Messages[1].Content, `The verifier says: ERROR candidate.swyp:4:5`) {
				t.Fatalf("%+v", r)
			}
		}
	}
	if n != 2 { // absolute and negate end in "return -x;"
		t.Fatalf("want 2 syntax repairs, got %d", n)
	}
}

func TestPickDiverseRoundRobin(t *testing.T) {
	ms := []mutant{{"a", "1"}, {"a", "2"}, {"a", "3"}, {"b", "4"}, {"c", "5"}}
	got := pickDiverse(ms, 4)
	var ids []string
	for _, m := range got {
		ids = append(ids, m.Source)
	}
	if strings.Join(ids, "") != "1452" {
		t.Fatalf("got %v", ids)
	}
}

func writeTasks(t *testing.T, dir string) string {
	t.Helper()
	contract := func(entry string) json.RawMessage {
		return json.RawMessage(`{"version":1,"entry":"` + entry + `","inputs":[{"name":"x","type":"i64","min":"-5","max":"5"}],"ensures":[],"max_steps":100}`)
	}
	var lines []string
	for _, tk := range []task{
		{ID: "absolute", Tier: "branches", Split: "train", Task: "Return the absolute value of x.", Contract: contract("absolute"), Reference: absRef},
		{ID: "negate", Tier: "arithmetic", Split: "train", Task: "Return x with its sign flipped.", Contract: contract("negate"), Reference: "fn negate(x: i64) -> i64 {\n    return -x;\n}"},
		{ID: "double", Tier: "arithmetic", Split: "train", Task: "Return twice x.", Contract: contract("double"), Reference: "fn double(x: i64) -> i64 {\n    return x * 2;\n}"},
		{ID: "secret", Tier: "arithmetic", Split: "heldout", Task: "Return the secret held-out value.", Contract: contract("secret"), Reference: "fn secret(x: i64) -> i64 {\n    return x;\n}"},
	} {
		data, _ := json.Marshal(tk)
		lines = append(lines, string(data))
	}
	path := filepath.Join(dir, "tasks.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// fakeJudge accepts exactly the references and rejects everything else with a
// counterexample, except mutants containing "x <= 0" which it calls unknown.
func fakeJudge(refs map[string]bool) verifier {
	return func(_ context.Context, src string, _ json.RawMessage) (cortex.SwypVerdict, error) {
		switch {
		case refs[strings.TrimSpace(src)]:
			return cortex.SwypVerdict{Status: "exhaustive", Summary: "PASS exhaustive"}, nil
		case strings.Contains(src, "x <= 0"):
			return cortex.SwypVerdict{Status: "unknown", Summary: "UNKNOWN fuel"}, nil
		}
		return cortex.SwypVerdict{Status: "counterexample", Summary: "FAIL counterexample: f(x=-1) returned 7, but the contract requires result >= 0 (ensures[0])"}, nil
	}
}

func TestBuildRowsUseLoopPromptsAndExcludeHeldout(t *testing.T) {
	dir := t.TempDir()
	tasks, err := loadTasks(writeTasks(t, dir))
	if err != nil {
		t.Fatal(err)
	}
	refs := map[string]bool{}
	for _, tk := range tasks {
		refs[tk.Reference] = true
	}
	out, err := build(context.Background(), tasks, "seed", 3, nil, fakeJudge(refs))
	if err != nil {
		t.Fatal(err)
	}
	all := append(append([]row{}, out.Train...), out.Validation...)
	system := cortex.BuildSystemPrompt(nil)
	kinds := map[string]int{}
	for _, r := range all {
		if r.TaskID == "secret" || strings.Contains(r.Messages[1].Content, "secret") {
			t.Fatal("held-out task in training data")
		}
		if r.Messages[0].Content != system || len(r.Messages) != 3 || r.Messages[2].Role != "assistant" {
			t.Fatalf("row shape %+v", r.Messages)
		}
		if !refs[strings.TrimSuffix(strings.TrimPrefix(r.Messages[2].Content, "```swyp\n"), "\n```")] {
			t.Fatalf("assistant answer is not a verified reference: %q", r.Messages[2].Content)
		}
		kinds[r.Kind]++
		if r.Kind == "repair" && !strings.Contains(r.Messages[1].Content, "The verifier says: FAIL counterexample: ") {
			t.Fatalf("repair prompt without a counterexample: %q", r.Messages[1].Content)
		}
		if strings.Contains(r.Messages[1].Content, "x <= 0") {
			t.Fatal("a mutant without a counterexample verdict was kept")
		}
	}
	if kinds["direct"] != 3 || kinds["repair"] < 3 {
		t.Fatalf("kinds %v", kinds)
	}
	first := all[0]
	for _, r := range all {
		if r.Kind == "direct" && r.TaskID == "absolute" {
			first = r
		}
	}
	_, sig, _ := cortex.SwypSignature(tasks[0].Contract)
	if first.Messages[1].Content != cortex.SwypFirstPrompt(tasks[0].Task, sig) {
		t.Fatal("direct prompt differs from the loop's first prompt")
	}
	if len(out.Validation) == 0 || len(out.Train) == 0 {
		t.Fatal("expected both splits")
	}
	vt := map[string]bool{}
	for _, r := range out.Validation {
		vt[r.TaskID] = true
	}
	for _, r := range out.Train {
		if vt[r.TaskID] {
			t.Fatalf("task %s in both splits", r.TaskID)
		}
	}
}

func TestModelReportWithHeldoutTaskIsRefused(t *testing.T) {
	dir := t.TempDir()
	tasks, _ := loadTasks(writeTasks(t, dir))
	report := filepath.Join(dir, "report.jsonl")
	os.WriteFile(report, []byte(`{"id":"secret","split":"heldout","status":"verified","report":{"source":"fn secret(x: i64) -> i64 {\n    return x;\n}"}}`+"\n"), 0o644)
	refs := map[string]bool{}
	for _, tk := range tasks {
		refs[tk.Reference] = true
	}
	if _, err := build(context.Background(), tasks, "seed", 2, []string{report}, fakeJudge(refs)); err == nil {
		t.Fatal("held-out model result accepted")
	}
}
