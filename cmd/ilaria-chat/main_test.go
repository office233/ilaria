package main

import (
	"fmt"
	"ilaria/cortex"
	"testing"
)

func TestExecutionScoreRejectsGuessedAnswerAfterToolError(t *testing.T) {
	it := evalItem{ExpectedTool: "calc", ExpectSubstring: "4"}
	r := cortex.TurnResult{Answer: "4", ToolCalls: []cortex.ToolCallLog{{Tool: "calc", Err: fmt.Errorf("bad args")}}}
	if successfulExpectedTool(it, r) {
		t.Fatal("failed call counted as success")
	}
	r.ToolCalls = append(r.ToolCalls, cortex.ToolCallLog{Tool: "calc", Result: "4"})
	if !successfulExpectedTool(it, r) {
		t.Fatal("successful recovery not counted")
	}
}
