package main

import (
	"strings"
	"testing"

	"swyp-lang/internal/swyplang"
)

const clampContract = `{"version":1,"entry":"clamp","inputs":[{"name":"x","type":"i64","min":"-100","max":"100"}],"ensures":[{"op":"ge","args":[{"var":"result"},{"const":{"type":"i64","value":"0"}}]},{"op":"le","args":[{"var":"result"},{"const":{"type":"i64","value":"50"}}]},{"op":"or","args":[{"op":"or","args":[{"op":"lt","args":[{"var":"x"},{"const":{"type":"i64","value":"0"}}]},{"op":"gt","args":[{"var":"x"},{"const":{"type":"i64","value":"50"}}]}]},{"op":"eq","args":[{"var":"result"},{"var":"x"}]}]}],"max_steps":100}`

// The two habits behind most rejected model replies in the 2026-09-28 Swyp
// Forge baseline: "else if" chains and returns without ';' before '}'.
func TestJudgeAcceptsElseIfAndReturnWithoutSemicolon(t *testing.T) {
	for name, src := range map[string]string{
		"else if with returns missing ;": "fn clamp(x: i64) -> i64 {\n    if x < 0 {\n        return 0\n    } else if x > 50 {\n        return 50\n    } else {\n        return x\n    }\n}",
		"else if with tail expressions":  "fn clamp(x: i64) -> i64 {\n    if x < 0 {\n        0\n    } else if x > 50 {\n        50\n    } else {\n        x\n    }\n}",
		"else if without final else":     "fn clamp(x: i64) -> i64 {\n    if x < 0 {\n        return 0;\n    } else if x > 50 {\n        return 50;\n    }\n    return x;\n}",
	} {
		resp, err := runJudge(t, judgeRequestJSON(t, src, clampContract))
		if err != nil || resp["status"] != "exhaustive" {
			t.Fatalf("%s: %v %v", name, err, resp["summary"])
		}
	}
	// Still wrong logic is still caught.
	wrong := "fn clamp(x: i64) -> i64 {\n    if x < 0 {\n        return 0\n    } else if x > 50 {\n        return x\n    }\n    return x\n}"
	resp, _ := runJudge(t, judgeRequestJSON(t, wrong, clampContract))
	if resp["status"] != "counterexample" || !strings.Contains(resp["summary"].(string), "clamp(x=51) returned 51") {
		t.Fatalf("wrong clamp: %v", resp["summary"])
	}
	// A missing ';' anywhere other than right before '}' is still a syntax error.
	resp, _ = runJudge(t, judgeRequestJSON(t, "fn clamp(x: i64) -> i64 {\n    let y: i64 = x\n    return y;\n}", clampContract))
	if resp["status"] != "error" {
		t.Fatalf("missing ; mid-block accepted: %v", resp["summary"])
	}
}

func TestLegacyParserUnchanged(t *testing.T) {
	for _, src := range []string{
		"fn main() {\n    if 1 < 2 {\n        print(1);\n    } else if 2 < 3 {\n        print(2);\n    }\n}",
		"fn f(x: number) -> number {\n    return x\n}\nfn main() {}",
	} {
		if _, err := swyplang.Parse("legacy.swyp", src); err == nil {
			t.Fatalf("legacy parser accepted core-only syntax:\n%s", src)
		}
	}
}
