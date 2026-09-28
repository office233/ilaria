package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"swyp-lang/internal/coreir"
)

const judgeSquareContract = `{"version":1,"entry":"square","inputs":[{"name":"x","type":"i64","min":"-100","max":"100"}],"ensures":[{"op":"eq","args":[{"var":"result"},{"op":"mul","args":[{"var":"x"},{"var":"x"}]}]}],"max_steps":100}`

func judgeRequestJSON(t *testing.T, source, contract string) string {
	t.Helper()
	data, err := json.Marshal(map[string]any{"version": 1, "source": source, "contract": json.RawMessage(contract)})
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func runJudge(t *testing.T, request string) (map[string]any, error) {
	t.Helper()
	var out bytes.Buffer
	err := judge(context.Background(), strings.NewReader(request), &out)
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("want exactly one JSON line, got %q", out.String())
	}
	var response map[string]any
	if jerr := json.Unmarshal([]byte(lines[0]), &response); jerr != nil {
		t.Fatalf("%v: %s", jerr, out.String())
	}
	return response, err
}

func TestJudgeVerdicts(t *testing.T) {
	cases := []struct {
		name, source, status, summary string
		ok                            bool
	}{
		{"exhaustive pass without main", "fn square(x: i64) -> i64 {\n    return x * x;\n}", "exhaustive", "PASS exhaustive: square satisfies the contract on all 201 inputs", true},
		{"explicit main kept", "fn square(x: i64) -> i64 { return x * x; }\nfn main() {}\n", "exhaustive", "PASS exhaustive", true},
		{"rust-style tail expression", "fn square(x: i64) -> i64 {\n    x * x\n}", "exhaustive", "PASS exhaustive", true},
		{"one-line tail expression", "fn square(x: i64) -> i64 { x * x }", "exhaustive", "PASS exhaustive", true},
		{"counterexample", "fn square(x: i64) -> i64 {\n    return x + x;\n}", "counterexample", "FAIL counterexample: square(x=-100) returned -200, but the contract requires result == x * x (ensures[0])", false},
		{"parse error with position", "fn square(x: i64) -> i64 {\n    return x * ;\n}", "error", "ERROR candidate.swyp:2:", false},
		{"missing entry", "fn cube(x: i64) -> i64 { return x * x * x; }", "error", "ERROR", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			response, err := runJudge(t, judgeRequestJSON(t, c.source, judgeSquareContract))
			if (err == nil) != c.ok {
				t.Fatalf("err = %v, want ok=%v; response %v", err, c.ok, response)
			}
			if response["status"] != c.status {
				t.Fatalf("status %v, want %s: %v", response["status"], c.status, response)
			}
			summary, _ := response["summary"].(string)
			if !strings.HasPrefix(summary, c.summary) {
				t.Fatalf("summary %q, want prefix %q", summary, c.summary)
			}
			if c.ok && (response["source_sha256"] == "" || response["contract_sha256"] == "") {
				t.Fatalf("missing evidence hashes: %v", response)
			}
		})
	}
}

func TestJudgeRejectsMalformedRequests(t *testing.T) {
	valid := judgeRequestJSON(t, "fn square(x: i64) -> i64 { return x * x; }", judgeSquareContract)
	for name, request := range map[string]string{
		"unknown field":  `{"version":1,"extra":true,"source":"fn square(x: i64) -> i64 { return x * x; }","contract":` + judgeSquareContract + `}`,
		"wrong version":  `{"version":2,"source":"fn square(x: i64) -> i64 { return x * x; }","contract":` + judgeSquareContract + `}`,
		"empty source":   judgeRequestJSON(t, "   ", judgeSquareContract),
		"huge source":    judgeRequestJSON(t, "fn square(x: i64) -> i64 { return x * x; }"+strings.Repeat(" ", judgeMaxSource), judgeSquareContract),
		"huge request":   valid + strings.Repeat(" ", judgeMaxRequest),
		"bad contract":   judgeRequestJSON(t, "fn square(x: i64) -> i64 { return x * x; }", `{"version":1,"entry":"square","ensures":[],"max_steps":100,"surprise":1}`),
		"trailing value": valid + ` {}`,
	} {
		t.Run(name, func(t *testing.T) {
			response, err := runJudge(t, request)
			if err == nil || response["status"] != "error" {
				t.Fatalf("accepted malformed request: %v %v", err, response)
			}
			if s, _ := response["summary"].(string); !strings.HasPrefix(s, "ERROR ") {
				t.Fatalf("summary %q", s)
			}
		})
	}
}

func TestJudgeHintsForCommonModelMistakes(t *testing.T) {
	cases := map[string]string{
		"fn square(x: i64) -> i64 { if x < 0 { x * x } return x * x; }":    "only allowed at the end of a function or of both branches of its final if/else",
		"fn square(x: i64) -> i64 { let y: i64 = x; y *= x; return y; }":   "hint: Swyp has no compound assignment; write `y = y * ...;`",
		"fn square(x: i64) -> i64 { return x ** 2; }":                      "hint: Swyp has no ** operator",
		"fn square(x: i64) -> i64 { return x.pow(2); }":                    "hint: Swyp values have no methods (`.pow(...)`)",
		"fn square(x: i64) -> i64 { while true { break; } return x * x; }": "hint: Swyp has no break/continue",
		"fn square(x: i64) -> i64 { return abs(x) * abs(x); }":             "hint: Swyp has no built-in `abs`",
	}
	for source, want := range cases {
		response, err := runJudge(t, judgeRequestJSON(t, source, judgeSquareContract))
		summary, _ := response["summary"].(string)
		if err == nil || response["status"] != "error" || !strings.Contains(summary, want) {
			t.Fatalf("%q: summary %q, want %q", source, summary, want)
		}
	}
	// A correct program and an ordinary counterexample carry no hint.
	for _, source := range []string{"fn square(x: i64) -> i64 { return x * x; }", "fn square(x: i64) -> i64 { return x + x; }"} {
		response, _ := runJudge(t, judgeRequestJSON(t, source, judgeSquareContract))
		if s, _ := response["summary"].(string); strings.Contains(s, "hint:") {
			t.Fatalf("unexpected hint: %q", s)
		}
	}
}

func TestJudgePredicateRendering(t *testing.T) {
	cases := map[string]string{
		`{"op":"ge","args":[{"var":"result"},{"const":{"type":"i64","value":"0"}}]}`:                                                           "result >= 0",
		`{"op":"eq","args":[{"var":"r"},{"op":"mul","args":[{"op":"add","args":[{"var":"a"},{"var":"b"}]},{"var":"c"}]}]}`:                     "r == (a + b) * c",
		`{"op":"eq","args":[{"var":"r"},{"op":"sub","args":[{"var":"x"},{"op":"sub","args":[{"var":"y"},{"var":"z"}]}]}]}`:                     "r == x - (y - z)",
		`{"op":"or","args":[{"op":"eq","args":[{"var":"r"},{"var":"x"}]},{"op":"eq","args":[{"var":"r"},{"op":"neg","args":[{"var":"x"}]}]}]}`: "r == x || r == -x",
	}
	for raw, want := range cases {
		var p coreir.Predicate
		if err := json.Unmarshal([]byte(raw), &p); err != nil {
			t.Fatal(err)
		}
		if got := judgePredicate(p, 0); got != want {
			t.Fatalf("%s: got %q, want %q", raw, got, want)
		}
	}
}
