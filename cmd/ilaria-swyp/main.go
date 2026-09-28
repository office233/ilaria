package main

// ilaria-swyp — Ilaria writes, Swyp proves. BitNet b1.58 2B4T writes a Swyp
// function for a task, `swyp judge` verifies it against a contract, and any
// counterexample or compile error goes back to the model as the next turn
// until the verifier accepts or -rounds runs out (cortex/swyp_solve.go).
// The runtime makes the verification call itself, so the base model does
// not need to have learned "CALL <tool>:" syntax.
//
//	go run -tags gpu ./cmd/ilaria-swyp -cuda \
//	    -model data/forge/bitnet-2b4t/bitnet.nxtf \
//	    -tokenizer data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json \
//	    -swyp "D:\nexus\swyp\bin\swyp.exe" \
//	    -contract swyp/examples/swyp/contracts/square.i64.json \
//	    -task "Return the square of x."
//
// stdout is one JSON report (every attempt, the accepted source and the
// verifier's evidence); progress goes to stderr. Exit status is 0 only for a
// verified result.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	cortex "ilaria/cortex"
)

func main() {
	modelPath := flag.String("model", "", "Path to a BitNet NXTF v3 checkpoint (required)")
	adapter := flag.String("adapter", "", "LoRA export prefix (.json/.safetensors)")
	tokenizerPath := flag.String("tokenizer", "", "Path to an HF tokenizer.json (required)")
	cudaFlag := flag.Bool("cuda", false, "Run on the GPU via the NVRTC-compiled decoder (needs a -tags gpu build)")
	swypExe := flag.String("swyp", "", "Absolute path to the Swyp CLI used as verifier (required)")
	contractPath := flag.String("contract", "", "Swyp contract JSON the function must satisfy (required)")
	task := flag.String("task", "", "What the function should do, in plain language (required)")
	rounds := flag.Int("rounds", 4, "Maximum model replies (1..16)")
	maxTokens := flag.Int("max-tokens", 200, "Generation budget per reply")
	timeout := flag.Duration("timeout", 10*time.Minute, "Overall deadline")
	tasksPath := flag.String("tasks", "", "Batch mode: Swyp Forge tasks JSONL (replaces -contract/-task)")
	split := flag.String("split", "heldout", "Batch mode: heldout, train or all")
	reportPath := flag.String("report", "", "Batch mode: new JSONL file for per-task results and the summary")
	printSystem := flag.Bool("print-system-prompt", false, "Print the exact system prompt the loop uses and exit")
	temperature := flag.Float64("temperature", 0, "Sampling temperature for repair prompts (0 = greedy)")
	topK := flag.Int("top-k", 40, "Candidates kept when sampling")
	seed := flag.Int64("seed", 1, "Sampling seed (runs are reproducible)")
	sampleAll := flag.Bool("sample-all", false, "Also sample the first prompt (changes pass@1)")
	flag.Parse()

	fail := func(stage string, err error) {
		fmt.Fprintf(os.Stderr, "error: %s: %v\n", stage, err)
		os.Exit(2)
	}
	if *printSystem {
		fmt.Print(cortex.BuildSystemPrompt(nil))
		return
	}
	batch := *tasksPath != ""
	if *modelPath == "" || *tokenizerPath == "" || *swypExe == "" {
		fail("flags", fmt.Errorf("-model, -tokenizer and -swyp are required"))
	}
	if batch && (*reportPath == "" || *contractPath != "" || *task != "") {
		fail("flags", fmt.Errorf("-tasks needs -report and excludes -contract/-task"))
	}
	if !batch && (*contractPath == "" || *task == "") {
		fail("flags", fmt.Errorf("-contract and -task are required (or use -tasks)"))
	}
	if *maxTokens < 1 || *maxTokens > 4096 {
		fail("flags", fmt.Errorf("-max-tokens must be 1..4096"))
	}
	var contract []byte
	var tasks []forgeTask
	var err error
	if batch {
		f, err := os.Open(*tasksPath)
		if err != nil {
			fail("tasks", err)
		}
		tasks, err = readForgeTasks(f, *split)
		f.Close()
		if err != nil {
			fail("tasks", err)
		}
	} else {
		contract, err = os.ReadFile(*contractPath)
		if err != nil {
			fail("contract", err)
		}
		if len(contract) > 64*1024 || !json.Valid(contract) {
			fail("contract", fmt.Errorf("contract must be valid JSON of at most 64 KiB"))
		}
	}
	judge, err := cortex.NewSwypJudgeChatTool(*swypExe)
	if err != nil {
		fail("swyp", err)
	}

	loadStart := time.Now()
	model, err := cortex.LoadBitNetModel(*modelPath)
	if err != nil {
		fail("model", err)
	}
	if *adapter != "" {
		if err := cortex.LoadBitNetLoRA(model, *adapter); err != nil {
			fail("adapter", err)
		}
	}
	tok, err := cortex.LoadHFTokenizerJSON(*tokenizerPath)
	if err != nil {
		fail("tokenizer", err)
	}
	fmt.Fprintf(os.Stderr, "[ilaria-swyp] model loaded in %.1fs\n", time.Since(loadStart).Seconds())
	stopIDs := []int{model.Cfg.EOSTokenID}
	if eot := tok.EotID(); eot >= 0 && eot != model.Cfg.EOSTokenID {
		stopIDs = append(stopIDs, eot)
	}
	var dec cortex.StepDecoder
	if *cudaFlag {
		cd, err := cortex.NewBitNetCUDADecoder(model)
		if err != nil {
			fail("cuda", err)
		}
		defer cd.Close()
		dec = cd
	} else {
		dec = cortex.NewBitNetDecoder(model)
	}

	// No ChatTools: verification is driven by the loop, not by CALL lines.
	runner := cortex.NewRunner(dec, tok, stopIDs, model.Cfg.MaxSeqLen, nil, 0, *maxTokens, os.Stderr)
	if err := runner.SetSampling(0, 0, *seed); err != nil {
		fail("sampling", err)
	}
	generate := func(ctx context.Context, userText string) (string, error) {
		start := time.Now()
		// Fresh context per prompt (the system prompt KV stays cached): greedy
		// decoding otherwise tends to copy its previous rejected reply.
		runner.ResetToSystem()
		// -temperature applies to repair prompts only (or every prompt with
		// -sample-all), so pass@1 stays the greedy measurement.
		t := 0.0
		if *temperature > 0 && (*sampleAll || strings.HasPrefix(userText, "This Swyp function is wrong:")) {
			t = *temperature
		}
		if err := runner.SetSamplingKeepSeed(t, *topK); err != nil {
			return "", err
		}
		res, err := runner.UserTurn(ctx, userText)
		if err == nil {
			fmt.Fprintf(os.Stderr, "[ilaria-swyp] reply: %d tokens in %.1fs\n", res.Tokens, time.Since(start).Seconds())
		}
		return res.Answer, err
	}
	verify := func(ctx context.Context, source string, c json.RawMessage) (cortex.SwypVerdict, error) {
		v, err := judge.Verify(ctx, source, c)
		if err == nil {
			fmt.Fprintf(os.Stderr, "[ilaria-swyp] %s\n    %s\n", source, v.Summary)
		}
		return v, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	if batch {
		summary, err := runBatch(ctx, tasks, *rounds, *reportPath, generate, verify)
		fmt.Print(summary.String())
		if err != nil {
			fail("batch", err)
		}
		return
	}
	report, err := cortex.SolveWithSwyp(ctx, *task, contract, *rounds, generate, verify)
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if encErr := enc.Encode(report); encErr != nil {
		fail("output", encErr)
	}
	if err != nil {
		fail("solve", err)
	}
	fmt.Fprintf(os.Stderr, "[ilaria-swyp] %s after %d attempt(s)\n", report.Status, len(report.Attempts))
	if report.Status != "verified" {
		os.Exit(1)
	}
}
