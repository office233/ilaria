package main

import (
	"regexp"
	"strconv"
	"strings"
)

// judgeHint turns a raw diagnostic into a concrete repair for the mistakes
// code models make when they write Swyp as if it were Rust, Python or
// JavaScript. Observed live with BitNet 2B: a tail expression without
// `return` ("x * x" before "}"), which the parser only reports as
// `expected ";", got "}"`. A hint is advice for the generator; it never
// changes the verdict.
func judgeHint(source, message string) string {
	if source == "" {
		return ""
	}
	if m := judgeCompound.FindStringSubmatch(source); m != nil {
		return "Swyp has no compound assignment; write `" + m[1] + " = " + m[1] + " " + m[2] + " ...;`"
	}
	if strings.Contains(source, "**") {
		return "Swyp has no ** operator; multiply explicitly, e.g. `x * x`"
	}
	if m := judgeMethod.FindStringSubmatch(source); m != nil {
		return "Swyp values have no methods (`." + m[1] + "(...)`); use operators and if/else"
	}
	if strings.Contains(message, `unknown variable "break"`) || strings.Contains(message, `unknown variable "continue"`) {
		return "Swyp has no break/continue; stop a loop through its while condition, or return"
	}
	if m := judgeUnknownFn.FindStringSubmatch(message); m != nil {
		return "Swyp has no built-in `" + m[1] + "`; compute it inline with operators and if/else, e.g. `if x < 0 { return -x; } return x;`"
	}
	if strings.Contains(message, `expected ";", got "}"`) {
		if expr := judgeTailExpression(source, message); expr != "" {
			return "Swyp has no implicit return; write `return " + expr + ";`"
		}
	}
	return ""
}

var (
	judgeCompound  = regexp.MustCompile(`\b([A-Za-z_]\w*)\s*([-+*/%])=`)
	judgeMethod    = regexp.MustCompile(`[\w)]\.([A-Za-z_]\w*)\s*\(`)
	judgeUnknownFn = regexp.MustCompile(`unknown function or unsupported effect/builtin "([A-Za-z_]\w*)"`)
	judgeLineCol   = regexp.MustCompile(`candidate\.swyp:(\d+):(\d+):`)
	judgeKeyword   = regexp.MustCompile(`^(return|let|if|else|while|fn)\b`)
)

// judgeTailExpression returns the statement text that ends right before the
// diagnostic position, when it is a bare expression.
func judgeTailExpression(source, message string) string {
	m := judgeLineCol.FindStringSubmatch(message)
	if m == nil {
		return ""
	}
	line, _ := strconv.Atoi(m[1])
	col, _ := strconv.Atoi(m[2])
	lines := strings.Split(source, "\n")
	if line < 1 || line > len(lines) || col < 1 || col-1 > len(lines[line-1]) {
		return ""
	}
	before := strings.Join(lines[:line-1], "\n")
	if line > 1 {
		before += "\n"
	}
	before += lines[line-1][:col-1]
	before = strings.TrimSpace(before)
	cut := strings.LastIndexAny(before, "{};")
	expr := strings.TrimSpace(before[cut+1:])
	if expr == "" || judgeKeyword.MatchString(expr) || strings.ContainsAny(expr, "\n") {
		return ""
	}
	return expr
}
