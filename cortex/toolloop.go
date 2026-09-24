package cortex

// toolloop.go — an LLM-driven tool loop for the ternary English cortex
// (BitNet b1.58 2B4T, cortex/bitnet*.go): the model itself decides to call
// a tool by writing a one-line "CALL <tool>: <args>" reply, the Runner
// below executes it and feeds the result back as a "Tool: ..." turn, and
// the model continues from there — as opposed to cortex/tools.go's
// ToolRegistry, which pattern-matches raw user text against deterministic
// tools before the neural pipeline ever runs. cmd/ilaria-chat drives this.
//
// Protocol: the system prompt (BuildSystemPrompt) lists the available
// tools and two few-shot examples, and instructs the model to answer
// directly in plain language OR, to use a tool, reply with EXACTLY one
// line "CALL <tool>: <args>" and nothing else. Generation for that one
// reply stops as soon as the text generated so far both starts with
// "CALL " and contains a newline (or the model's own eos/eot token fires
// first) — see Runner.generateSegment. The parsed call is dispatched to a
// registered ChatTool; its result is fed back as a "Tool: <result>" turn
// (any capitalized role name renders the same way under
// Llama3ChatPrompt's template — see that function's doc comment — which
// is what makes feeding a synthetic "Tool" turn back to the model as
// natural as a normal "User"/"Assistant" turn). A per-turn budget
// (Runner.maxCalls) caps how many tool calls the model gets before it is
// forced to answer: once the budget is spent, the NEXT attempted call is
// refused with a fixed "Tool: (no more tool calls allowed; answer now)"
// message instead of being executed, and everything the model produces
// after that is taken as the final answer even if it still looks like a
// CALL line.
//
// Multi-turn runs WITHOUT re-prefilling the whole transcript on every
// turn: Runner.UserTurn Prefills once, on the very first user turn; every
// later message (a tool result, the next user turn, the "Assistant: "
// generation header) is appended by encoding its rendered text and
// Step-ing the decoder through those tokens one at a time, keeping only
// the logits from the LAST Step call — exactly how a KV-cached decoder is
// meant to be extended. See StepDecoder and Runner.feedRaw.

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"nexus-cortex/cortex/swe"
)

// ─────────────────────────────────────────────────────────────────────
// ChatTool: the protocol-level tool contract
// ─────────────────────────────────────────────────────────────────────

// ChatTool is a capability the model can invoke by name via "CALL <name>:
// <args>". Unlike Tool (tools.go), which is pattern-matched against free
// text, a ChatTool is dispatched explicitly by the name the model wrote,
// and gets a context so a slow tool (go_run, biomed) can be bounded by a
// deadline.
type ChatTool interface {
	// Name is the identifier the model must write after "CALL ".
	Name() string
	// Describe is one line shown in the system prompt's tool list, of the
	// form "name: <what args looks like> — what it does".
	Describe() string
	// Call executes the tool on the raw argument string (everything after
	// the tool name's ':' in the CALL line, trimmed) and returns the text
	// to feed back as "Tool: <result>". A non-nil error is rendered as
	// "Tool: error: <message>" by the Runner — Call implementations
	// should keep error messages short and model-readable.
	Call(ctx context.Context, args string) (string, error)
}

// ─────────────────────────────────────────────────────────────────────
// Built-in ChatTool adapters
// ─────────────────────────────────────────────────────────────────────

// CalcChatTool wraps EvalArithmetic (calc.go): exact +, -, *, /, ^,
// parentheses and sqrt() arithmetic — no identifiers, no code execution.
type CalcChatTool struct{}

func (CalcChatTool) Name() string { return "calc" }
func (CalcChatTool) Describe() string {
	return "calc: <arithmetic expression> — exact arithmetic: + - * / ^, parentheses, sqrt(x)"
}
func (CalcChatTool) Call(_ context.Context, args string) (string, error) {
	return EvalArithmetic(args)
}

// TimeChatTool answers with the current date and time, local and UTC —
// DateTimeTool's semantics (tools.go), but always both instead of picking
// one sub-answer by keyword, since a ChatTool is invoked explicitly by
// name rather than pattern-matched.
type TimeChatTool struct{}

func (TimeChatTool) Name() string { return "time" }
func (TimeChatTool) Describe() string {
	return "time: (no args) — the current date and time, local and UTC, including day of week"
}
func (TimeChatTool) Call(_ context.Context, _ string) (string, error) {
	now := time.Now()
	return fmt.Sprintf("local: %s | utc: %s",
		now.Format("Monday, 2 January 2006 15:04:05 MST"),
		now.UTC().Format("Monday, 2 January 2006 15:04:05 UTC")), nil
}

// ConvertChatTool wraps UnitConvertTool (tools.go) — km/mi, kg/lb, C/F,
// m/ft unit conversion.
type ConvertChatTool struct{ inner UnitConvertTool }

func (ConvertChatTool) Name() string { return "convert" }
func (ConvertChatTool) Describe() string {
	return `convert: <N> <from-unit> to <to-unit> — unit conversion (km/mi, kg/lb, C/F, m/ft)`
}
func (c ConvertChatTool) Call(_ context.Context, args string) (string, error) {
	out, ok := c.inner.Execute(args)
	if !ok {
		return "", fmt.Errorf("could not parse a conversion from %q (expected e.g. \"72 miles to kilometers\")", args)
	}
	return out, nil
}

// BiomedChatTool wraps BiomedTool (biomed_tool.go), which answers only
// from live public biomedical sources (RxNorm/openFDA/etc.) and needs
// network access. Registered by cmd/ilaria-chat only when -biomed-cache
// is given.
type BiomedChatTool struct{ inner *BiomedTool }

// NewBiomedChatTool wires a BiomedChatTool to a cache/knowledge-graph
// directory, exactly like NewBiomedTool.
func NewBiomedChatTool(cacheDir string) *BiomedChatTool {
	return &BiomedChatTool{inner: NewBiomedTool(cacheDir)}
}

func (*BiomedChatTool) Name() string { return "biomed" }
func (*BiomedChatTool) Describe() string {
	return "biomed: <drug name and question> — live biomedical lookups (RxNorm/openFDA/etc.), needs network"
}
func (t *BiomedChatTool) Call(_ context.Context, args string) (string, error) {
	out, ok := t.inner.Execute(args)
	if !ok {
		return "", fmt.Errorf("no biomedical answer for %q", args)
	}
	return out, nil
}

// GoRunChatTool compiles and runs a Go program through swe.RunGo
// (cortex/swe/sandbox_executor.go), a real go vet/test sandbox with a
// deadline. swe.RunGo deliberately never does a bare `go run` — it only
// vets and tests — so GoRunChatTool recovers real printed output by
// pairing the model's package-main source with a tiny generated test file
// that calls main() from inside a Test function: any fmt.Print* the
// program does writes straight to the test binary's real os.Stdout, which
// swe.RunGo captures verbatim regardless of pass/fail, so "what does it
// print" comes back honestly through the same toolchain that reports
// vet/build/test diagnostics.
type GoRunChatTool struct{}

func (GoRunChatTool) Name() string { return "go_run" }
func (GoRunChatTool) Describe() string {
	return "go_run: <a complete package main Go source file, func main() included> — compiles and runs it in a sandbox, returns what it prints"
}

const goRunTestWrapper = "package main\n\nimport \"testing\"\n\nfunc TestGoRunMain(t *testing.T) {\n\tmain()\n}\n"

const goRunTimeout = 20 * time.Second

func (GoRunChatTool) Call(ctx context.Context, args string) (string, error) {
	src := strings.TrimSpace(args)
	if src == "" {
		return "", fmt.Errorf("empty Go source")
	}
	cctx, cancel := context.WithTimeout(ctx, goRunTimeout)
	defer cancel()
	res, err := swe.RunGo(cctx, map[string]string{
		"main.go":      src,
		"main_test.go": goRunTestWrapper,
	})
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "success=%t exit=%d timed_out=%t", res.Success, res.ExitCode, res.TimedOut)
	if len(res.Diagnostics) > 0 {
		b.WriteString("\ndiagnostics:")
		for _, d := range res.Diagnostics {
			fmt.Fprintf(&b, "\n  %s:%d: %s", d.FilePath, d.Line, d.Message)
		}
	}
	if out := strings.TrimSpace(res.Stdout); out != "" {
		b.WriteString("\nstdout:\n")
		b.WriteString(truncateForTool(out, 1500))
	}
	if errOut := strings.TrimSpace(res.Stderr); errOut != "" {
		b.WriteString("\nstderr:\n")
		b.WriteString(truncateForTool(errOut, 1500))
	}
	return b.String(), nil
}

// ReadFileChatTool reads a small text file rooted at workdir — never
// outside it, regardless of ".." components or absolute paths in args.
type ReadFileChatTool struct{ workdir string }

// NewReadFileChatTool roots the tool at workdir. An empty workdir
// produces a tool that always refuses (see Call) — cmd/ilaria-chat only
// registers this tool at all when -workdir is set, but the guard is kept
// here too so the type is safe to construct directly (e.g. from tests).
func NewReadFileChatTool(workdir string) *ReadFileChatTool {
	return &ReadFileChatTool{workdir: workdir}
}

const readFileMaxBytes = 8 * 1024

func (*ReadFileChatTool) Name() string { return "read_file" }
func (*ReadFileChatTool) Describe() string {
	return "read_file: <relative path> — read a small text file under the working directory (max 8 KB)"
}
func (t *ReadFileChatTool) Call(_ context.Context, args string) (string, error) {
	if t.workdir == "" {
		return "", fmt.Errorf("read_file is disabled (no -workdir configured)")
	}
	rel := strings.TrimSpace(args)
	if rel == "" {
		return "", fmt.Errorf("empty path")
	}
	full, err := safeJoin(t.workdir, rel)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return "", err
	}
	truncated := len(data) > readFileMaxBytes
	if truncated {
		data = data[:readFileMaxBytes]
	}
	out := string(data)
	if truncated {
		out += fmt.Sprintf("\n...(truncated at %d bytes)", readFileMaxBytes)
	}
	return out, nil
}

// safeJoin resolves rel against root and rejects anything that would
// escape root: absolute paths, and any ".." that survives Clean+Join once
// both sides are made absolute and compared with filepath.Rel. This is
// the check swe.RunGo (sandbox_executor.go) applies to sandbox file
// paths, adapted for reading rather than writing.
func safeJoin(root, rel string) (string, error) {
	clean := filepath.Clean(rel)
	if filepath.IsAbs(clean) {
		return "", fmt.Errorf("path %q must be relative", rel)
	}
	joined := filepath.Join(root, clean)
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	absJoined, err := filepath.Abs(joined)
	if err != nil {
		return "", err
	}
	relCheck, err := filepath.Rel(absRoot, absJoined)
	if err != nil || relCheck == ".." || strings.HasPrefix(relCheck, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path %q escapes the working directory", rel)
	}
	return absJoined, nil
}

func truncateForTool(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…(truncated)"
}

// ─────────────────────────────────────────────────────────────────────
// Protocol: system prompt and CALL-line parsing
// ─────────────────────────────────────────────────────────────────────

const toolLoopSystemTemplate = `You are Ilaria, a helpful assistant with access to a small set of tools.

If you need a tool, reply with EXACTLY one line in this form and nothing else — no words before it, no words after it, no explanation:
CALL <tool>: <args>

You will then be given a line starting with "Tool:" carrying the result. Read it, then answer the user's question in plain language — do not just repeat the raw result verbatim if a full sentence reads better. If you do NOT need a tool, skip the CALL line entirely and answer directly in plain language.

Available tools:
%s

Examples:

User: What is 12 times 7?
Assistant: CALL calc: 12*7
Tool: 84
Assistant: 12 times 7 is 84.

User: What is the capital of France?
Assistant: The capital of France is Paris.`

// BuildSystemPrompt renders the fixed protocol preamble and few-shot
// examples above a bulleted list of the given tools' Describe() lines.
func BuildSystemPrompt(tools []ChatTool) string {
	var b strings.Builder
	for _, t := range tools {
		fmt.Fprintf(&b, "- %s\n", t.Describe())
	}
	return fmt.Sprintf(toolLoopSystemTemplate, strings.TrimRight(b.String(), "\n"))
}

// ParseCallLine parses a line of the exact form "CALL <tool>: <args>" —
// the one-line protocol BuildSystemPrompt teaches the model — and returns
// the tool name and the (whitespace-trimmed, possibly empty) argument
// string. An error means the line doesn't have that shape at all (missing
// "CALL " prefix, missing ':', or an empty tool name); it does not mean
// the named tool is unknown — that is checked separately by the Runner so
// it can report "unknown tool X; available: ..." rather than a generic
// parse error.
func ParseCallLine(line string) (name, args string, err error) {
	line = strings.TrimSpace(line)
	const prefix = "CALL "
	if !strings.HasPrefix(line, prefix) {
		return "", "", fmt.Errorf("not a CALL line: %q", line)
	}
	rest := line[len(prefix):]
	idx := strings.Index(rest, ":")
	if idx < 0 {
		return "", "", fmt.Errorf("missing ':' after tool name in %q", line)
	}
	name = strings.TrimSpace(rest[:idx])
	args = strings.TrimSpace(rest[idx+1:])
	if name == "" {
		return "", "", fmt.Errorf("empty tool name in %q", line)
	}
	return name, args, nil
}

// ─────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────

// StepDecoder is the Prefill/Step/Len/Reset surface Runner needs from a
// decoder. *BitNetDecoder (CPU) and *BitNetCUDADecoder (-tags gpu) both
// satisfy it — the same decoder-agnostic pattern cmd/bitnet-run's
// stepDecoder and cmd/ilaria-see's multimodalDecoder use. A decoder that
// additionally implements `Argmax() int` (only *BitNetCUDADecoder does)
// gets its device-side argmax used instead of scanning the returned
// logits on the CPU — detected via a type assertion in NewRunner, exactly
// how cmd/ilaria-see picks between the two.
type StepDecoder interface {
	Prefill(ids []int) []float32
	Step(id int) []float32
	Len() int
	Reset()
}

// Tokenizer is the Encode/Decode surface Runner needs from a tokenizer.
// *BPETokenizer (tokenizer.go) satisfies it; kept as its own interface so
// tests can drive the Runner with a tiny fake instead of a real BPE
// vocabulary (see toolloop_test.go).
type Tokenizer interface {
	Encode(text string) []int
	Decode(ids []int) string
}

// ToolCallLog records one attempted "CALL" line and what happened to it —
// executed, refused (tool-call budget spent), or unparseable.
type ToolCallLog struct {
	Tool   string // "" when the line itself didn't parse
	Args   string
	Result string // exactly what was fed back as "Tool: <Result>"
	Err    error  // non-nil for a tool error, a refusal, or a parse failure
}

// TurnResult is what one Runner.UserTurn call produced.
type TurnResult struct {
	Answer    string // the model's final, non-CALL reply
	Calls     int    // tool calls actually EXECUTED (excludes refused/unparsed attempts)
	Tokens    int    // tokens generated across every segment of this turn
	ToolCalls []ToolCallLog
}

// Runner drives one BitNet decoder through the CALL/Tool protocol across
// possibly many user turns, without re-prefilling the transcript on every
// turn (see the file doc comment). It is not safe for concurrent use —
// exactly like the StepDecoder it wraps, which holds one mutable KV cache.
type Runner struct {
	dec          StepDecoder
	cudaArgmax   func() int
	tok          Tokenizer
	tools        map[string]ChatTool
	toolList     []ChatTool
	systemPrompt string
	stopSet      map[int]bool
	maxSeqLen    int
	maxCalls     int
	maxTokens    int // per-segment generation budget (one CALL-line attempt, or the final answer)
	seq          []int
	transcript   strings.Builder
	started      bool
	log          io.Writer
}

// NewRunner constructs a Runner. stopIDs are the token ids that end a
// generation segment the same way cmd/bitnet-run treats them (the model's
// eos plus tok.EotID()); maxSeqLen bounds the KV cache the same way
// (model.Cfg.MaxSeqLen); maxCalls is the per-user-turn tool-call budget;
// maxTokens is the per-segment generation cap. log receives "[tool] ..."
// lines for every call attempt; pass io.Discard to silence it.
func NewRunner(dec StepDecoder, tok Tokenizer, stopIDs []int, maxSeqLen int, tools []ChatTool, maxCalls, maxTokens int, log io.Writer) *Runner {
	m := make(map[string]ChatTool, len(tools))
	for _, t := range tools {
		m[t.Name()] = t
	}
	stop := make(map[int]bool, len(stopIDs))
	for _, id := range stopIDs {
		stop[id] = true
	}
	if log == nil {
		log = io.Discard
	}
	r := &Runner{
		dec:          dec,
		tok:          tok,
		tools:        m,
		toolList:     tools,
		systemPrompt: BuildSystemPrompt(tools),
		stopSet:      stop,
		maxSeqLen:    maxSeqLen,
		maxCalls:     maxCalls,
		maxTokens:    maxTokens,
		log:          log,
	}
	if a, ok := dec.(interface{ Argmax() int }); ok {
		r.cudaArgmax = a.Argmax
	}
	return r
}

// Transcript returns the full rendered conversation fed to the decoder so
// far (system + every user/assistant/tool turn), for -show-transcript.
func (r *Runner) Transcript() string { return r.transcript.String() }

// toolLoopMaxIterations bounds how many CALL attempts (parsed or not) one
// UserTurn will process before giving up and returning whatever text it
// has, purely as a termination guard against a model that never stops
// emitting malformed CALL lines — maxCalls itself already caps real tool
// executions well before this.
func toolLoopMaxIterations(maxCalls int) int {
	return maxCalls*3 + 6
}

// UserTurn renders userText as the next turn, generates the model's
// reply, and executes as many CALL lines as the maxCalls budget allows,
// feeding each result back and continuing generation, until the model
// produces a plain non-CALL answer (or the turn is force-ended — see the
// file doc comment).
func (r *Runner) UserTurn(ctx context.Context, userText string) (TurnResult, error) {
	var logits []float32
	if !r.started {
		prompt := Llama3ChatPrompt(r.systemPrompt, userText)
		r.transcript.WriteString(prompt)
		ids := r.tok.Encode(prompt)
		if len(ids) == 0 {
			return TurnResult{}, fmt.Errorf("toolloop: empty prompt encoding")
		}
		logits = r.dec.Prefill(ids)
		r.seq = append(r.seq, ids...)
		r.started = true
	} else {
		r.feedMessage("user", userText)
		logits = r.feedGenerationHeader()
	}

	var result TurnResult
	forced := false
	maxIter := toolLoopMaxIterations(r.maxCalls)
	for iter := 0; ; iter++ {
		if iter >= maxIter {
			forced = true
		}
		segText, toks, isCall := r.generateSegment(logits)
		result.Tokens += toks
		r.transcript.WriteString(segText)
		r.transcript.WriteString("\n") // cosmetic only — see feedToolResult's doc comment

		if forced || !isCall {
			result.Answer = segText
			return result, nil
		}

		name, args, perr := ParseCallLine(segText)
		if perr != nil {
			msg := "error: " + perr.Error()
			r.logTool("(unparsed)", segText, msg)
			result.ToolCalls = append(result.ToolCalls, ToolCallLog{Args: segText, Result: msg, Err: perr})
			logits = r.feedToolResult(msg)
			continue
		}

		if result.Calls >= r.maxCalls {
			forced = true
			const refusal = "(no more tool calls allowed; answer now)"
			r.logTool(name, args, "refused: "+refusal)
			result.ToolCalls = append(result.ToolCalls, ToolCallLog{
				Tool: name, Args: args, Result: refusal, Err: fmt.Errorf("tool-call budget spent"),
			})
			logits = r.feedToolResult(refusal)
			continue
		}

		tool, ok := r.tools[name]
		var toolResult string
		var callErr error
		if !ok {
			toolResult = fmt.Sprintf("error: unknown tool %s; available: %s", name, strings.Join(r.toolNames(), ", "))
			callErr = fmt.Errorf("unknown tool %s", name)
		} else {
			result.Calls++
			out, err := tool.Call(ctx, args)
			if err != nil {
				toolResult = "error: " + err.Error()
				callErr = err
			} else {
				toolResult = out
			}
		}
		r.logTool(name, args, toolResult)
		result.ToolCalls = append(result.ToolCalls, ToolCallLog{Tool: name, Args: args, Result: toolResult, Err: callErr})
		logits = r.feedToolResult(toolResult)
	}
}

// generateSegment greedily decodes one reply segment starting from
// logits (already computed — the caller just Prefilled or fed a
// generation header), stopping when: the model's stop token fires, the
// text generated so far starts with "CALL " and contains a newline, or
// the maxTokens/maxSeqLen budget is hit. It returns the trimmed segment
// text, how many tokens were generated, and whether the text looks like
// a CALL line.
//
// Note on the CALL-line cutoff: once a newline is detected, everything
// from that newline onward is dropped from the returned text (the model
// was asked for exactly one line), but the token that carried the
// newline has already been Stepped into the KV cache along with
// everything before it — so the cache can, in the rare case where a
// single BPE piece merges the newline with following characters, hold a
// few stray characters of context beyond what generateSegment reports.
// This is a deliberate, documented simplification: those characters are
// never surfaced to the model as text (Tool: ... is fed right after) and
// in practice a byte-level BPE tokenizes "\n" as -or as part of- its own
// piece almost every time.
func (r *Runner) generateSegment(logits []float32) (text string, tokens int, isCall bool) {
	var ids []int
	for i := 0; i < r.maxTokens; i++ {
		next := r.argmax(logits)
		ids = append(ids, next)
		r.seq = append(r.seq, next)
		tokens++
		raw := r.tok.Decode(ids)

		stop := r.stopSet[next]
		// Contains("\n") must run on the UNTRIMMED text: when the newline
		// is the very last character generated so far (the common case —
		// the model just finished its one-line CALL and nothing follows
		// yet), TrimSpace would strip it before this check ever saw it.
		callLine := strings.HasPrefix(strings.TrimSpace(raw), "CALL ") && strings.Contains(raw, "\n")
		atLimit := i == r.maxTokens-1 || r.dec.Len() >= r.maxSeqLen

		if stop || callLine || atLimit {
			trimmed := strings.TrimSpace(raw)
			if callLine {
				trimmed = strings.TrimSpace(strings.SplitN(trimmed, "\n", 2)[0])
			}
			text = trimmed
			isCall = strings.HasPrefix(text, "CALL ")
			return
		}
		logits = r.dec.Step(next)
	}
	text = strings.TrimSpace(r.tok.Decode(ids))
	isCall = strings.HasPrefix(text, "CALL ")
	return
}

func (r *Runner) argmax(logits []float32) int {
	if r.cudaArgmax != nil {
		return r.cudaArgmax()
	}
	best := 0
	bestVal := logits[0]
	for v := 1; v < len(logits); v++ {
		if logits[v] > bestVal {
			bestVal = logits[v]
			best = v
		}
	}
	return best
}

// feedMessage renders "{Role}: {content}<|eot_id|>" (any role name works
// under Llama3ChatPrompt's template — see the file doc comment) and feeds
// its tokens through the decoder one Step at a time.
func (r *Runner) feedMessage(role, content string) []float32 {
	rendered := fmt.Sprintf("%s: %s<|eot_id|>", capitalizeRole(role), strings.TrimSpace(content))
	return r.feedRaw(rendered)
}

// feedGenerationHeader appends "Assistant: " (no trailing <|eot_id|> —
// generation continues from here), matching Llama3ChatPrompt's own
// add_generation_prompt suffix.
func (r *Runner) feedGenerationHeader() []float32 {
	return r.feedRaw("Assistant: ")
}

// feedToolResult renders "Tool: <content><|eot_id|>" and immediately
// follows it with the "Assistant: " generation header, exactly like the
// prompt template's own add_generation_prompt does after every turn (see
// Llama3ChatPrompt). Without this second feed the model would have to
// generate the literal "Assistant: " header itself before its real reply
// — it never learned to do that, so the very first version of this loop
// fed only the "Tool: ..." turn and the model, left staring at a
// missing header, just emitted its stop token immediately. Every
// resumption of generation after a fed-back message goes through this
// (or the equivalent user-turn path in UserTurn), never feedMessage alone.
func (r *Runner) feedToolResult(content string) []float32 {
	r.feedMessage("tool", content)
	return r.feedGenerationHeader()
}

// feedRaw appends text to the transcript and Steps the decoder through
// its encoded tokens one at a time, discarding every returned logits
// slice except the last — the KV-cache-preserving way to extend a
// conversation without a full re-Prefill.
func (r *Runner) feedRaw(text string) []float32 {
	r.transcript.WriteString(text)
	ids := r.tok.Encode(text)
	var logits []float32
	for _, id := range ids {
		logits = r.dec.Step(id)
		r.seq = append(r.seq, id)
	}
	return logits
}

func capitalizeRole(role string) string {
	if role == "" {
		return role
	}
	rs := []rune(role)
	return strings.ToUpper(string(rs[0])) + string(rs[1:])
}

func (r *Runner) toolNames() []string {
	names := make([]string, len(r.toolList))
	for i, t := range r.toolList {
		names[i] = t.Name()
	}
	return names
}

func (r *Runner) logTool(name, args, result string) {
	if r.log == nil {
		return
	}
	fmt.Fprintf(r.log, "[tool] %s(%s) -> %s\n", name, truncateForTool(args, 200), truncateForTool(result, 300))
}
