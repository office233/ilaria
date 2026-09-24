package main

// ilaria-chat — hands and feet for the ternary English cortex: an
// LLM-driven tool loop (cortex/toolloop.go) over BitNet b1.58 2B4T. The
// model itself decides to call a tool by writing "CALL <tool>: <args>";
// this binary just wires up the decoder/tokenizer/tools and drives
// cortex.Runner, the same way cmd/bitnet-run wires up a plain chat loop
// and cmd/ilaria-see wires up the vision pipeline.
//
//	go run ./cmd/ilaria-chat -cuda \
//	    -model data/forge/bitnet-2b4t/bitnet.nxtf \
//	    -tokenizer data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json \
//	    -prompt "What is 48213 * 9071?"
//
// With -prompt empty, stdin becomes an interactive multi-turn REPL (one
// cortex.Runner, one Prefill, no re-prefill between turns — see
// toolloop.go's file doc comment). -eval <jsonl> runs the measured tool-
// selection evaluation described in cmd/ilaria-chat/testdata/tools_eval.jsonl
// instead of either mode (see runEval below).
//
// Tool activity ("[tool] name(args) -> result") is always logged to
// stderr, so stdout stays just the assistant's final answer(s) — the same
// stdout/stderr split cmd/bitnet-run and cmd/ilaria-see use for their own
// "[prefix] ..." progress lines.

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	cortex "nexus-cortex/cortex"
)

func main() {
	modelPath := flag.String("model", "", "Path to a BitNet NXTF v3 checkpoint (required)")
	tokenizerPath := flag.String("tokenizer", "", "Path to an HF tokenizer.json (required)")
	cudaFlag := flag.Bool("cuda", false, "Run prefill+decode on the GPU via the NVRTC-compiled decoder (needs a -tags gpu build; see cortex/bitnet_cuda.go and cmd/bitnet-run's -cuda)")
	prompt := flag.String("prompt", "", "One-shot prompt; when empty, stdin becomes an interactive multi-turn REPL")
	maxTokens := flag.Int("max-tokens", 256, "Per-segment generation budget: one CALL-line attempt, or the final answer")
	maxCalls := flag.Int("max-calls", 3, "Max tool calls allowed per user turn before a final answer is forced")
	workdir := flag.String("workdir", "", "Root directory for the read_file tool (unset disables read_file entirely)")
	biomedCache := flag.String("biomed-cache", "", "Cache/knowledge-graph directory for the biomed tool (unset disables it entirely — needs network)")
	showTranscript := flag.Bool("show-transcript", false, "Print the full rendered transcript (system+turns) to stderr after each turn")
	evalPath := flag.String("eval", "", "Run the tool-selection evaluation from this JSONL file instead of one-shot/REPL mode (see cmd/ilaria-chat/testdata/tools_eval.jsonl)")
	flag.Parse()

	fail := func(stage string, err error) {
		fmt.Fprintf(os.Stderr, "error: %s: %v\n", stage, err)
		os.Exit(1)
	}
	if *modelPath == "" || *tokenizerPath == "" {
		fail("flags", fmt.Errorf("-model and -tokenizer are required"))
	}

	loadStart := time.Now()
	model, err := cortex.LoadBitNetModel(*modelPath)
	if err != nil {
		fail("model", err)
	}
	fmt.Fprintf(os.Stderr, "[ilaria-chat] loaded %s in %.2fs (vocab=%d layers=%d embed=%d)\n",
		*modelPath, time.Since(loadStart).Seconds(), model.Cfg.VocabSize, model.Cfg.NumLayers, model.Cfg.EmbedDim)

	tok, err := cortex.LoadHFTokenizerJSON(*tokenizerPath)
	if err != nil {
		fail("tokenizer", err)
	}

	stopIDs := []int{model.Cfg.EOSTokenID}
	if eot := tok.EotID(); eot >= 0 && eot != model.Cfg.EOSTokenID {
		stopIDs = append(stopIDs, eot)
	}

	var dec cortex.StepDecoder
	if *cudaFlag {
		cudaStart := time.Now()
		cd, err := cortex.NewBitNetCUDADecoder(model)
		if err != nil {
			fail("cuda", err)
		}
		defer cd.Close()
		fmt.Fprintf(os.Stderr, "[ilaria-chat] CUDA decoder ready in %.2fs\n", time.Since(cudaStart).Seconds())
		dec = cd
	} else {
		dec = cortex.NewBitNetDecoder(model)
	}

	tools := buildTools(*workdir, *biomedCache)
	fmt.Fprintf(os.Stderr, "[ilaria-chat] tools: %s\n", strings.Join(toolNames(tools), ", "))

	if *evalPath != "" {
		if err := runEval(*evalPath, dec, tok, stopIDs, model.Cfg.MaxSeqLen, tools, *maxCalls, *maxTokens, *showTranscript); err != nil {
			fail("eval", err)
		}
		return
	}

	if *prompt != "" {
		runner := cortex.NewRunner(dec, tok, stopIDs, model.Cfg.MaxSeqLen, tools, *maxCalls, *maxTokens, os.Stderr)
		res, err := runner.UserTurn(context.Background(), *prompt)
		if err != nil {
			fail("generate", err)
		}
		if *showTranscript {
			fmt.Fprintf(os.Stderr, "[ilaria-chat] transcript:\n%s\n", runner.Transcript())
		}
		fmt.Println(res.Answer)
		return
	}

	runREPL(dec, tok, stopIDs, model.Cfg.MaxSeqLen, tools, *maxCalls, *maxTokens, *showTranscript)
}

// buildTools registers the always-on tools plus the ones that need extra
// configuration to be usable at all: read_file only under -workdir,
// biomed only with -biomed-cache (it calls out to live public APIs).
func buildTools(workdir, biomedCache string) []cortex.ChatTool {
	tools := []cortex.ChatTool{
		cortex.CalcChatTool{},
		cortex.TimeChatTool{},
		cortex.ConvertChatTool{},
		cortex.GoRunChatTool{},
	}
	if workdir != "" {
		tools = append(tools, cortex.NewReadFileChatTool(workdir))
	}
	if biomedCache != "" {
		tools = append(tools, cortex.NewBiomedChatTool(biomedCache))
	}
	return tools
}

func toolNames(tools []cortex.ChatTool) []string {
	names := make([]string, len(tools))
	for i, t := range tools {
		names[i] = t.Name()
	}
	return names
}

// runREPL reads one user turn per line from stdin until EOF, printing
// each answer to stdout. One cortex.Runner (and its KV cache) spans the
// whole session — see toolloop.go's file doc comment on why no turn
// after the first ever re-Prefills.
func runREPL(dec cortex.StepDecoder, tok cortex.Tokenizer, stopIDs []int, maxSeqLen int, tools []cortex.ChatTool, maxCalls, maxTokens int, showTranscript bool) {
	runner := cortex.NewRunner(dec, tok, stopIDs, maxSeqLen, tools, maxCalls, maxTokens, os.Stderr)
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	fmt.Fprintln(os.Stderr, "[ilaria-chat] interactive mode — one line per turn, Ctrl-D to quit")
	for {
		fmt.Fprint(os.Stderr, "> ")
		if !sc.Scan() {
			break
		}
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		res, err := runner.UserTurn(context.Background(), line)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: generate: %v\n", err)
			continue
		}
		if showTranscript {
			fmt.Fprintf(os.Stderr, "[ilaria-chat] transcript:\n%s\n", runner.Transcript())
		}
		fmt.Println(res.Answer)
	}
}

// ─────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────

// evalItem is one line of a tools_eval.jsonl file. ExpectedTool is ""
// for a prompt that should NOT trigger any tool call; ExpectSubstring,
// when set, is checked (case-insensitively) against the final answer.
type evalItem struct {
	Prompt          string `json:"prompt"`
	ExpectedTool    string `json:"expected_tool"`
	ExpectSubstring string `json:"expect_substring,omitempty"`
}

// runEval runs every prompt in path through a fresh Runner (the decoder
// is Reset between prompts so each one starts from the same clean KV
// cache — no cross-prompt leakage), and prints a per-prompt table
// followed by three honest, measured totals: tool-selection accuracy
// (over prompts that DO need a tool), false-call rate (over prompts that
// do NOT), and answer accuracy (over prompts carrying an
// expect_substring). Nothing here is tuned to make numbers look better —
// see docs/benchmarks/tools_eval.md for the actual run and what it found.
func runEval(path string, dec cortex.StepDecoder, tok cortex.Tokenizer, stopIDs []int, maxSeqLen int, tools []cortex.ChatTool, maxCalls, maxTokens int, showTranscript bool) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	var items []evalItem
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "//") {
			continue
		}
		var it evalItem
		if err := json.Unmarshal([]byte(line), &it); err != nil {
			return fmt.Errorf("bad JSONL line %q: %w", line, err)
		}
		items = append(items, it)
	}
	if err := sc.Err(); err != nil {
		return err
	}

	w := tabwriter.NewWriter(os.Stdout, 2, 2, 2, ' ', 0)
	fmt.Fprintln(w, "prompt\ttool called\texpected\ttool-ok\tanswer-ok\tcalls\ttokens\tseconds")

	var toolTotal, toolCorrect int
	var noToolTotal, falseCalls int
	var substrTotal, substrOK int

	for _, it := range items {
		dec.Reset()
		runner := cortex.NewRunner(dec, tok, stopIDs, maxSeqLen, tools, maxCalls, maxTokens, os.Stderr)

		start := time.Now()
		res, err := runner.UserTurn(context.Background(), it.Prompt)
		elapsed := time.Since(start)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[eval] error on %q: %v\n", it.Prompt, err)
			fmt.Fprintf(w, "%s\tERROR\t%s\t-\t-\t-\t-\t%.1f\n", truncateEval(it.Prompt, 40), orDash(it.ExpectedTool), elapsed.Seconds())
			continue
		}

		firstTried := ""
		if len(res.ToolCalls) > 0 {
			firstTried = res.ToolCalls[0].Tool
			if firstTried == "" {
				firstTried = "(unparsed)"
			}
		}

		var toolOK bool
		if it.ExpectedTool == "" {
			noToolTotal++
			toolOK = len(res.ToolCalls) == 0
			if len(res.ToolCalls) > 0 {
				falseCalls++
			}
		} else {
			toolTotal++
			toolOK = firstTried == it.ExpectedTool
			if toolOK {
				toolCorrect++
			}
		}

		answerOK := true
		if it.ExpectSubstring != "" {
			substrTotal++
			answerOK = strings.Contains(strings.ToLower(res.Answer), strings.ToLower(it.ExpectSubstring))
			if answerOK {
				substrOK++
			}
		}

		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%d\t%d\t%.1f\n",
			truncateEval(it.Prompt, 40), orDash(firstTried), orDash(it.ExpectedTool),
			ynMark(toolOK), ynMark(answerOK), res.Calls, res.Tokens, elapsed.Seconds())

		if showTranscript {
			fmt.Fprintf(os.Stderr, "[transcript] %q\n%s\n---\n", it.Prompt, runner.Transcript())
		}
	}
	w.Flush()

	fmt.Println()
	fmt.Printf("tool-selection accuracy (prompts needing a tool): %d/%d\n", toolCorrect, toolTotal)
	fmt.Printf("false-call rate (prompts needing no tool):        %d/%d\n", falseCalls, noToolTotal)
	fmt.Printf("answer accuracy (substring check):                %d/%d\n", substrOK, substrTotal)
	return nil
}

func truncateEval(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func ynMark(ok bool) string {
	if ok {
		return "y"
	}
	return "n"
}
