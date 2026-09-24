package cortex

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ─────────────────────────────────────────────────────────────────────
// calc evaluator
// ─────────────────────────────────────────────────────────────────────

func TestCalcPrecedence(t *testing.T) {
	cases := map[string]string{
		"1+2*3":       "7",
		"(1+2)*3":     "9",
		"2^10":        "1024",
		"2^3^2":       "512", // right-associative: 2^(3^2)
		"-3^2":        "-9",  // ^ binds tighter than unary minus
		"-2*3":        "-6",  // unary minus binds tighter than * on the left
		"2^-1":        "0.5",
		"10-2-3":      "5",
		"20/2/2":      "5",
		"  3 +   4 ":  "7",
		"sqrt(16)":    "4",
		"sqrt(2)":     "1.4142135624",
		"2*(3+4)/7":   "2",
		"(-2)^2":      "4",
		"1+2*(3-1)^2": "9",
	}
	for expr, want := range cases {
		got, err := EvalArithmetic(expr)
		if err != nil {
			t.Errorf("EvalArithmetic(%q) unexpected error: %v", expr, err)
			continue
		}
		if got != want {
			t.Errorf("EvalArithmetic(%q) = %q, want %q", expr, got, want)
		}
	}
}

func TestCalcBigInts(t *testing.T) {
	cases := map[string]string{
		"48213*9071":                       "437340123",
		"999999999999*2":                   "1999999999998",
		"2^64":                             "18446744073709551616",
		"123456789012345678901234567890+1": "123456789012345678901234567891",
	}
	for expr, want := range cases {
		got, err := EvalArithmetic(expr)
		if err != nil {
			t.Errorf("EvalArithmetic(%q) unexpected error: %v", expr, err)
			continue
		}
		if got != want {
			t.Errorf("EvalArithmetic(%q) = %q, want %q", expr, got, want)
		}
	}
}

func TestCalcDivision(t *testing.T) {
	got, err := EvalArithmetic("10/4")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "2.5" {
		t.Errorf("10/4 = %q, want 2.5", got)
	}

	got, err = EvalArithmetic("1/3")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasPrefix(got, "0.3333333333") {
		t.Errorf("1/3 = %q, want prefix 0.3333333333", got)
	}
}

func TestCalcErrors(t *testing.T) {
	cases := []string{
		"",
		"1/0",
		"1+",
		"(1+2",
		"1+2)",
		"1 2",
		"sqrt(-1)",
		"abc",
		"1..2",
		"2^100000001",
	}
	for _, expr := range cases {
		if _, err := EvalArithmetic(expr); err == nil {
			t.Errorf("EvalArithmetic(%q) expected an error, got none", expr)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────
// CALL-line parsing
// ─────────────────────────────────────────────────────────────────────

func TestCallLineParsing(t *testing.T) {
	name, args, err := ParseCallLine("CALL calc: 2+2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if name != "calc" || args != "2+2" {
		t.Errorf("got name=%q args=%q, want calc/2+2", name, args)
	}

	// Extra whitespace around the tool name and args should be trimmed.
	name, args, err = ParseCallLine("CALL   time :   ")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if name != "time" || args != "" {
		t.Errorf("got name=%q args=%q, want time/\"\"", name, args)
	}

	// Args may themselves contain colons (e.g. a URL or a ratio).
	name, args, err = ParseCallLine("CALL convert: 10:30 to something")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if name != "convert" || args != "10:30 to something" {
		t.Errorf("got name=%q args=%q", name, args)
	}
}

func TestCallLineParsingErrors(t *testing.T) {
	cases := []string{
		"not a call at all",
		"CALLcalc: 2+2", // missing space after CALL
		"CALL calc 2+2", // missing ':'
		"CALL : 2+2",    // empty tool name
		"",
	}
	for _, line := range cases {
		if _, _, err := ParseCallLine(line); err == nil {
			t.Errorf("ParseCallLine(%q) expected an error, got none", line)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────
// read_file path-escape rejection
// ─────────────────────────────────────────────────────────────────────

func TestReadFileToolRejectsPathEscape(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("hello from notes"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}
	secretDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(secretDir, "secret.txt"), []byte("top secret"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}

	tool := NewReadFileChatTool(dir)

	// A legitimate read should succeed.
	out, err := tool.Call(context.Background(), "notes.txt")
	if err != nil {
		t.Fatalf("legitimate read failed: %v", err)
	}
	if out != "hello from notes" {
		t.Errorf("got %q, want %q", out, "hello from notes")
	}

	escapes := []string{
		"../secret.txt",
		"..\\secret.txt",
		"../" + filepath.Base(secretDir) + "/secret.txt",
		filepath.Join(secretDir, "secret.txt"), // absolute path
		"..",
		"subdir/../../secret.txt",
	}
	for _, rel := range escapes {
		if _, err := tool.Call(context.Background(), rel); err == nil {
			t.Errorf("Call(%q) expected a path-escape error, got none", rel)
		}
	}
}

func TestReadFileToolDisabledWithoutWorkdir(t *testing.T) {
	tool := NewReadFileChatTool("")
	if _, err := tool.Call(context.Background(), "notes.txt"); err == nil {
		t.Error("expected an error when no -workdir is configured")
	}
}

// ─────────────────────────────────────────────────────────────────────
// fake decoder + fake tokenizer driving the Runner
// ─────────────────────────────────────────────────────────────────────

// fakeStepDecoder is a scripted StepDecoder: each Prefill/Step call hands
// out the NEXT id in script as the argmax winner (by putting a spike at
// that index in an otherwise-zero logits vector), regardless of what id
// it was actually asked to Step. This lets a test dictate exactly what
// the "model" generates, token by token, without a real BitNet decoder.
type fakeStepDecoder struct {
	script []int
	idx    int
	vocab  int
	length int
}

func (d *fakeStepDecoder) nextLogits() []float32 {
	want := 0
	if d.idx < len(d.script) {
		want = d.script[d.idx]
	}
	d.idx++
	logits := make([]float32, d.vocab)
	logits[want] = 100
	return logits
}

func (d *fakeStepDecoder) Prefill(ids []int) []float32 {
	d.length += len(ids)
	return d.nextLogits()
}
func (d *fakeStepDecoder) Step(id int) []float32 {
	d.length++
	return d.nextLogits()
}
func (d *fakeStepDecoder) Len() int { return d.length }
func (d *fakeStepDecoder) Reset()   { d.idx = 0; d.length = 0 }

// fakeTokenizer maps a fixed set of generated-token ids to literal text
// pieces (Decode) and treats every Encode call as exactly one opaque
// token (so each fed-back message — a tool result, a user turn, the
// "Assistant: " header — costs exactly one scripted Step slot,
// independent of its real length).
type fakeTokenizer struct {
	pieces map[int]string
}

func (f fakeTokenizer) Encode(string) []int { return []int{0} }
func (f fakeTokenizer) Decode(ids []int) string {
	var b strings.Builder
	for _, id := range ids {
		b.WriteString(f.pieces[id])
	}
	return b.String()
}

// TestToolLoopOneCallThenForcedAnswer drives the Runner through exactly
// the scenario cortex/toolloop.go's protocol is built around: the model
// calls "calc" once (consuming the only call the maxCalls=1 budget
// allows), then tries to call again, gets refused with the fixed
// "no more tool calls allowed" message, and its next segment — even
// though it again starts by trying to write a CALL line — is taken as
// the forced final answer.
func TestToolLoopOneCallThenForcedAnswer(t *testing.T) {
	const (
		idCall1 = 1 // "CALL calc: 2+2"
		idNL1   = 2 // "\n"
		idCall2 = 3 // "CALL calc: 5+5"
		idNL2   = 4 // "\n"
		idFinal = 5 // "The result is 4."
		idEOS   = 6 // "" (stop token)
	)
	// Slots 2 and 5 are never argmax'd: feedToolResult (toolloop.go) feeds
	// "Tool: ...<|eot_id|>" and then the "Assistant: " generation header
	// as two separate Step calls, and only the SECOND one's logits are
	// actually used to keep generating — the first is fed-through and
	// discarded, exactly like a real decoder call would be. 0 is never
	// looked up in the fake tokenizer's pieces map, so its value here is
	// irrelevant; it exists only to keep the script's slot count aligned
	// with the real sequence of Prefill/Step calls Runner makes.
	dec := &fakeStepDecoder{
		script: []int{idCall1, idNL1, 0, idCall2, idNL2, 0, idFinal, idEOS},
		vocab:  8,
	}
	tok := fakeTokenizer{pieces: map[int]string{
		idCall1: "CALL calc: 2+2",
		idNL1:   "\n",
		idCall2: "CALL calc: 5+5",
		idNL2:   "\n",
		idFinal: "The result is 4.",
		idEOS:   "",
	}}

	var logBuf strings.Builder
	r := NewRunner(dec, tok, []int{idEOS}, 10000, []ChatTool{CalcChatTool{}}, 1, 10, &logBuf)

	result, err := r.UserTurn(context.Background(), "what is 2+2, then 5+5?")
	if err != nil {
		t.Fatalf("UserTurn returned an error: %v", err)
	}

	if result.Answer != "The result is 4." {
		t.Errorf("Answer = %q, want %q", result.Answer, "The result is 4.")
	}
	if result.Calls != 1 {
		t.Errorf("Calls = %d, want 1 (only the first CALL should have executed)", result.Calls)
	}
	if len(result.ToolCalls) != 2 {
		t.Fatalf("ToolCalls has %d entries, want 2 (one executed, one refused)", len(result.ToolCalls))
	}
	if result.ToolCalls[0].Tool != "calc" || result.ToolCalls[0].Result != "4" {
		t.Errorf("first ToolCall = %+v, want tool=calc result=4", result.ToolCalls[0])
	}
	if result.ToolCalls[0].Err != nil {
		t.Errorf("first ToolCall should have succeeded, got err: %v", result.ToolCalls[0].Err)
	}
	if result.ToolCalls[1].Err == nil {
		t.Errorf("second ToolCall (refused) should carry a non-nil Err")
	}
	if !strings.Contains(logBuf.String(), "[tool] calc(2+2)") {
		t.Errorf("expected a [tool] log line for the executed call, got: %s", logBuf.String())
	}

	transcript := r.Transcript()
	for _, want := range []string{"CALL calc: 2+2", "Tool: 4", "no more tool calls allowed", "The result is 4."} {
		if !strings.Contains(transcript, want) {
			t.Errorf("transcript missing %q; transcript=%s", want, transcript)
		}
	}
}

// TestToolLoopUnknownTool exercises the "unknown tool" branch: a CALL
// line naming a tool that isn't registered should be fed back as an
// error rather than crashing, and should still count toward the answer
// path once the model gives up trying tools.
func TestToolLoopUnknownTool(t *testing.T) {
	const (
		idCall  = 1 // "CALL frobnicate: 1"
		idNL    = 2 // "\n"
		idFinal = 3 // "I can't do that."
		idEOS   = 4
	)
	// Slot 2 (between idNL and idFinal) is the discarded first half of
	// feedToolResult's two Step calls — see the comment in
	// TestToolLoopOneCallThenForcedAnswer.
	dec := &fakeStepDecoder{script: []int{idCall, idNL, 0, idFinal, idEOS}, vocab: 8}
	tok := fakeTokenizer{pieces: map[int]string{
		idCall:  "CALL frobnicate: 1",
		idNL:    "\n",
		idFinal: "I can't do that.",
		idEOS:   "",
	}}
	r := NewRunner(dec, tok, []int{idEOS}, 10000, []ChatTool{CalcChatTool{}}, 3, 10, nil)
	result, err := r.UserTurn(context.Background(), "frobnicate 1")
	if err != nil {
		t.Fatalf("UserTurn returned an error: %v", err)
	}
	if result.Calls != 0 {
		t.Errorf("Calls = %d, want 0 (unknown tool should not count as executed)", result.Calls)
	}
	if len(result.ToolCalls) != 1 || result.ToolCalls[0].Err == nil {
		t.Fatalf("expected one failed ToolCall entry, got %+v", result.ToolCalls)
	}
	if !strings.Contains(result.ToolCalls[0].Result, "unknown tool") {
		t.Errorf("result = %q, want it to mention 'unknown tool'", result.ToolCalls[0].Result)
	}
	if result.Answer != "I can't do that." {
		t.Errorf("Answer = %q", result.Answer)
	}
}

func TestToolLoopDirectAnswerNoCall(t *testing.T) {
	const (
		idFinal = 1 // "Paris."
		idEOS   = 2
	)
	dec := &fakeStepDecoder{script: []int{idFinal, idEOS}, vocab: 8}
	tok := fakeTokenizer{pieces: map[int]string{idFinal: "Paris.", idEOS: ""}}
	r := NewRunner(dec, tok, []int{idEOS}, 10000, []ChatTool{CalcChatTool{}}, 3, 10, nil)
	result, err := r.UserTurn(context.Background(), "What is the capital of France?")
	if err != nil {
		t.Fatalf("UserTurn returned an error: %v", err)
	}
	if result.Calls != 0 || len(result.ToolCalls) != 0 {
		t.Errorf("expected no tool activity, got Calls=%d ToolCalls=%v", result.Calls, result.ToolCalls)
	}
	if result.Answer != "Paris." {
		t.Errorf("Answer = %q, want Paris.", result.Answer)
	}
}

// TestSafeJoinRejectsEscape is a focused test of the safeJoin helper
// go_run/read_file rely on, independent of the ReadFileChatTool wrapper.
func TestSafeJoinRejectsEscape(t *testing.T) {
	dir := t.TempDir()
	other := t.TempDir()
	if _, err := safeJoin(dir, "../outside.txt"); err == nil {
		t.Error("expected an error for a '..'-escaping path")
	}
	absOutside := filepath.Join(other, "passwd")
	if !filepath.IsAbs(absOutside) {
		t.Fatalf("test setup: %q is not absolute", absOutside)
	}
	if _, err := safeJoin(dir, absOutside); err == nil {
		t.Error("expected an error for an absolute path")
	}
	got, err := safeJoin(dir, "sub/file.txt")
	if err != nil {
		t.Fatalf("unexpected error for a legitimate relative path: %v", err)
	}
	want := filepath.Join(dir, "sub", "file.txt")
	gotAbs, _ := filepath.Abs(got)
	wantAbs, _ := filepath.Abs(want)
	if gotAbs != wantAbs {
		t.Errorf("safeJoin = %q, want %q", got, want)
	}
}
