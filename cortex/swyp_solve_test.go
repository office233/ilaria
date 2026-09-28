package cortex

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestSwypSignature(t *testing.T) {
	entry, sig, err := SwypSignature(json.RawMessage(`{"entry":"add","inputs":[{"name":"a","type":"i64"},{"name":"b","type":"i64"}]}`))
	if err != nil || entry != "add" || sig != "fn add(a: i64, b: i64) -> i64" {
		t.Fatalf("%q %q %v", entry, sig, err)
	}
	for _, bad := range []string{`{}`, `{"entry":"f"}`, `{"entry":"f() {} fn g","inputs":[{"name":"x","type":"i64"}]}`, `{"entry":"f","inputs":[{"name":"x","type":"string"}]}`, `not json`} {
		if _, _, err := SwypSignature(json.RawMessage(bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
}

func TestExtractSwypFunction(t *testing.T) {
	cases := []struct{ reply, want string }{
		{"Here:\n```swyp\nfn square(x: i64) -> i64 { return x * x; }\n```\nDone.", "fn square(x: i64) -> i64 { return x * x; }"},
		{"```\n{\"entry\":\"square\"}\n```\n```swyp\nfn square(x: i64) -> i64 {\n    if x < 0 { return x * x; }\n    return x * x;\n}\n```", "fn square(x: i64) -> i64 {\n    if x < 0 { return x * x; }\n    return x * x;\n}"},
		{"The answer is fn square(x: i64) -> i64 { return x * x; } as requested.", "fn square(x: i64) -> i64 { return x * x; }"},
	}
	for _, c := range cases {
		got, ok := ExtractSwypFunction(c.reply, "square")
		if !ok || got != c.want {
			t.Fatalf("reply %q: got %q %v", c.reply, got, ok)
		}
	}
	for _, reply := range []string{"no code here", "fn cube(x: i64) -> i64 { return x; }", "fn square(x: i64) -> i64 { return x * x;", "fn squared(x: i64) -> i64 { return 1; }"} {
		if got, ok := ExtractSwypFunction(reply, "square"); ok {
			t.Fatalf("extracted %q from %q", got, reply)
		}
	}
}

const swypSolveContract = `{"version":1,"entry":"square","inputs":[{"name":"x","type":"i64","min":"-100","max":"100"}],"ensures":[],"max_steps":100}`

func scriptedGenerator(replies []string, prompts *[]string) SwypGenerator {
	i := 0
	return func(_ context.Context, userText string) (string, error) {
		*prompts = append(*prompts, userText)
		if i >= len(replies) {
			return "", errors.New("script exhausted")
		}
		i++
		return replies[i-1], nil
	}
}

func fakeSquareVerifier(_ context.Context, source string, _ json.RawMessage) (SwypVerdict, error) {
	if strings.Contains(source, "x * x") {
		return SwypVerdict{Status: "exhaustive", Summary: "PASS exhaustive: square"}, nil
	}
	return SwypVerdict{Status: "counterexample", Summary: "FAIL counterexample: square(x=-100) returned -200, violating ensures[0]"}, nil
}

func TestSolveWithSwypRepairsFromCounterexample(t *testing.T) {
	var prompts []string
	gen := scriptedGenerator([]string{
		"I will describe it instead of writing it.",
		"```swyp\nfn square(x: i64) -> i64 { return x + x; }\n```",
		"```swyp\nfn square(x: i64) -> i64 { return x * x; }\n```",
	}, &prompts)
	report, err := SolveWithSwyp(context.Background(), "Square the input.", json.RawMessage(swypSolveContract), 4, gen, fakeSquareVerifier)
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "verified" || report.Source != "fn square(x: i64) -> i64 { return x * x; }" || len(report.Attempts) != 3 {
		t.Fatalf("%+v", report)
	}
	if !strings.Contains(prompts[0], "fn square(x: i64) -> i64") || !strings.Contains(prompts[0], "Square the input.") {
		t.Fatalf("first prompt %q", prompts[0])
	}
	if !strings.Contains(prompts[1], "Square the input.") || !strings.Contains(prompts[1], "named square") {
		t.Fatalf("missing-function prompt %q", prompts[1])
	}
	if !strings.Contains(prompts[2], "square(x=-100) returned -200") {
		t.Fatalf("repair prompt must carry the counterexample: %q", prompts[2])
	}
}

func TestSolveWithSwypStopsAtRoundBudget(t *testing.T) {
	var prompts []string
	wrong := "```swyp\nfn square(x: i64) -> i64 { return x + x; }\n```"
	report, err := SolveWithSwyp(context.Background(), "Square.", json.RawMessage(swypSolveContract), 2, scriptedGenerator([]string{wrong, wrong, wrong}, &prompts), fakeSquareVerifier)
	if err != nil || report.Status != "unverified" || len(report.Attempts) != 2 || report.Source != "" {
		t.Fatalf("%+v %v", report, err)
	}
}

func TestSolveWithSwypInfrastructureErrors(t *testing.T) {
	var prompts []string
	ok := "```swyp\nfn square(x: i64) -> i64 { return x * x; }\n```"
	brokenVerifier := func(context.Context, string, json.RawMessage) (SwypVerdict, error) {
		return SwypVerdict{}, errors.New("judge missing")
	}
	if _, err := SolveWithSwyp(context.Background(), "Square.", json.RawMessage(swypSolveContract), 2, scriptedGenerator([]string{ok}, &prompts), brokenVerifier); err == nil {
		t.Fatal("verifier failure reported as a normal result")
	}
	if _, err := SolveWithSwyp(context.Background(), "Square.", json.RawMessage(swypSolveContract), 2, scriptedGenerator(nil, &prompts), fakeSquareVerifier); err == nil {
		t.Fatal("generator failure reported as a normal result")
	}
	if _, err := SolveWithSwyp(context.Background(), "Square.", json.RawMessage(swypSolveContract), 0, scriptedGenerator(nil, &prompts), fakeSquareVerifier); err == nil {
		t.Fatal("accepted zero rounds")
	}
}

// TestSolveWithSwypRealJudge exercises the loop against a real Swyp build
// (SWYP_EXE) with a scripted model, so the counterexample text is Swyp's own.
func TestSolveWithSwypRealJudge(t *testing.T) {
	tool := realSwypOrSkip(t)
	var prompts []string
	gen := scriptedGenerator([]string{
		"```swyp\nfn square(x: i64) -> i64 { return x + x; }\n```",
		"```swyp\nfn square(x: i64) -> i64 { return x * x; }\n```",
	}, &prompts)
	report, err := SolveWithSwyp(context.Background(), "Square.", json.RawMessage(swypTestContract), 3, gen, tool.Verify)
	if err != nil || report.Status != "verified" || report.Verdict.Status != "exhaustive" || len(report.Attempts) != 2 {
		t.Fatalf("%+v %v", report, err)
	}
	if !strings.Contains(prompts[1], "FAIL counterexample: square(x=-100) returned -200") {
		t.Fatalf("repair prompt %q", prompts[1])
	}
	var evidence map[string]any
	if err := json.Unmarshal(report.Verdict.Report, &evidence); err != nil || evidence["source_sha256"] == "" {
		t.Fatalf("missing evidence: %s", report.Verdict.Report)
	}
}

func TestRenameSoleSwypFunction(t *testing.T) {
	src, from, ok := RenameSoleSwypFunction("```swyp\nfn greater_than(x: i64) -> i64 {\n    x + 1\n}\n```", "above")
	if !ok || from != "greater_than" || src != "fn above(x: i64) -> i64 {\n    x + 1\n}" {
		t.Fatalf("%q %q %v", src, from, ok)
	}
	src, _, ok = RenameSoleSwypFunction("fn total(n: i64) -> i64 { if n == 0 { 0 } else { total(n - 1) + n } }\nfn main() {}", "sum_to")
	if !ok || src != "fn sum_to(n: i64) -> i64 { if n == 0 { 0 } else { sum_to(n - 1) + n } }" {
		t.Fatalf("recursive rename: %q %v", src, ok)
	}
	for _, reply := range []string{"no code", "fn a(x: i64) -> i64 { x }\nfn b(x: i64) -> i64 { x }"} {
		if src, _, ok := RenameSoleSwypFunction(reply, "above"); ok {
			t.Fatalf("renamed %q from %q", src, reply)
		}
	}
}
