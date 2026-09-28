// broca-eval — correctness-grading harness for Broca 2.0 transformer.
//
// Sister tool to broca-probe (which measures stylistic health) and to
// cortex-eval (which evaluates the full organism with memory). This
// one targets the bare transformer + tokenizer and grades whether the
// generated answers are factually CORRECT against a curated suite.
//
// Suite covers four capability axes: factual / math / instruct /
// reasoning. Scoring modes per task: contains, contains_any, numeric
// (with tolerance), regex.
//
// Usage:
//
//	# Evaluate the canonical checkpoint
//	broca-eval --data-dir ./data/cortex-auto
//
//	# Evaluate the best checkpoint
//	broca-eval --model best
//
//	# Evaluate a specific .nxtf file
//	broca-eval --model data/cortex-auto/transformer.nxtf.pre-D-...bak
//
//	# Compare two checkpoints (e.g. C-best vs D-best)
//	broca-eval --compare \
//	    data/cortex-auto/transformer.nxtf.pre-D-20260525-150000.bak \
//	    data/cortex-auto/transformer.best.nxtf
//
//	# Enable Self-Consistency during eval (slower but higher accuracy)
//	broca-eval --cot --cot-samples 3
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ilaria/cortex"
	"ilaria/cortex/compute"
	"ilaria/cortex/evalsuite"
)

// gpuEnabled is set from --gpu in main(); when false, runSingle skips
// cuBLAS init so the GPU remains free for an in-flight training run.
var gpuEnabled bool

// runReport is the top-level JSON document one eval run emits.
type runReport struct {
	Timestamp     string                    `json:"timestamp"`
	ModelPath     string                    `json:"model_path"`
	Params        int                       `json:"params"`
	VocabSize     int                       `json:"vocab_size"`
	Temperature   float64                   `json:"temperature"`
	TopK          int                       `json:"top_k"`
	MaxTokens     int                       `json:"max_tokens"`
	MinTokens     int                       `json:"min_tokens,omitempty"`
	Seed          int64                     `json:"seed"`
	CoTEnabled    bool                      `json:"cot_enabled"`
	CoTSamples    int                       `json:"cot_samples,omitempty"`
	SuiteSize     int                       `json:"suite_size"`
	Results       []evalsuite.ScoreResult   `json:"results"`
	PerCategory   []evalsuite.CategoryStats `json:"per_category"`
	Overall       evalsuite.CategoryStats   `json:"overall"`
	TotalWallSecs float64                   `json:"total_wall_secs"`
}

func main() {
	dataDir := flag.String("data-dir", "./data/cortex-auto", "Organism data directory (tokenizer + default model)")
	modelPath := flag.String("model", "", "Transformer .nxtf path; empty=canonical, 'best'=transformer.best.nxtf")
	maxTokens := flag.Int("max-tokens", 40, "Tokens to generate per task")
	minTokens := flag.Int("min-tokens", 0, "Suppress EOS for the first N emitted tokens (0 = default, no suppression). Useful when the model emits EOS too early after short prompts.")
	temperature := flag.Float64("temp", 0.6, "Sampling temperature (lower = more deterministic, better for facts)")
	topK := flag.Int("top-k", 40, "Top-k sampling cutoff")
	seed := flag.Int64("seed", 1, "RNG seed (deterministic sampling order)")
	cot := flag.Bool("cot", false, "Enable Chain-of-Thought + Self-Consistency voting")
	cotSamples := flag.Int("cot-samples", 3, "Number of votes when --cot is set")
	out := flag.String("out", "", "Where to write the JSON report (default: <data-dir>/broca-eval-<ts>.json)")
	compareMode := flag.Bool("compare", false, "Run eval on two checkpoints and print A vs B diff (args: pathA pathB)")
	verbose := flag.Bool("v", false, "Print full generation for every task (default: only failures verbose)")
	useGPU := flag.Bool("gpu", false, "Use cuBLAS GPU matmul (DANGEROUS if training is running on same GPU)")
	flag.Parse()

	// Default behaviour is CPU-only: this tool is meant to run safely
	// alongside an active training process. The training run already
	// owns the GPU; opening a second cuBLAS handle would contend for
	// device 0 and slow both processes down. Pass --gpu to override.
	gpuEnabled = *useGPU

	if *compareMode {
		args := flag.Args()
		if len(args) != 2 {
			log.Fatalf("--compare needs exactly two checkpoint paths, got %d", len(args))
		}
		runCompare(*dataDir, args[0], args[1], *maxTokens, *minTokens, *temperature, *topK, *seed,
			*cot, *cotSamples, *verbose)
		return
	}

	report := runSingle(*dataDir, *modelPath, *maxTokens, *minTokens, *temperature, *topK, *seed,
		*cot, *cotSamples, *verbose)

	if *out == "" {
		*out = filepath.Join(*dataDir, fmt.Sprintf("broca-eval-%s.json", time.Now().Format("20060102-150405")))
	}
	if err := writeJSON(*out, report); err != nil {
		log.Fatalf("write report: %v", err)
	}
	fmt.Printf("\nReport: %s\n", *out)
}

// loadCheckpoint resolves modelPath ("", "best", or a path) and returns
// the loaded transformer plus its on-disk path.
func loadCheckpoint(org *cortex.Organism, dataDir, modelPath string, rng *rand.Rand) (string, *cortex.MiniTransformer) {
	resolved := filepath.Join(dataDir, "transformer.nxtf")
	switch {
	case modelPath == "":
		return resolved, org.Transformer
	case modelPath == "best":
		resolved = filepath.Join(dataDir, "transformer.best.nxtf")
	default:
		resolved = modelPath
	}
	loaded, err := cortex.LoadMiniTransformer(resolved, rng)
	if err != nil {
		log.Fatalf("load checkpoint %s: %v", resolved, err)
	}
	return resolved, loaded
}

// runSingle loads one checkpoint, runs the suite, prints the summary,
// and returns the full report (also written to disk by main).
func runSingle(
	dataDir, modelPath string,
	maxTokens, minTokens int, temp float64, topK int, seed int64,
	cot bool, cotSamples int, verbose bool,
) runReport {
	rng := rand.New(rand.NewSource(seed))

	if gpuEnabled {
		if err := compute.InitCuBLAS(); err == nil {
			fmt.Println("[cuBLAS] GPU matmul active")
			defer compute.CloseCuBLAS()
		} else {
			fmt.Printf("[cuBLAS] requested but unavailable (%v); falling back to CPU\n", err)
		}
	} else {
		fmt.Println("[compute] CPU-only mode (safe to run alongside training)")
	}

	cfg := cortex.DefaultConfig()
	cfg.DataDir = dataDir
	cfg.Demo = false
	cfg.NoSave = true
	if cot {
		cfg.CoTEnabled = true
		cfg.CoTSamples = cotSamples
		cfg.CoTBaseTemperature = float32(temp)
		cfg.CoTUsePrimer = true
	}

	org, err := cortex.LoadOrganism(cfg, rng)
	if err != nil || org == nil {
		log.Fatalf("LoadOrganism failed: %v", err)
	}
	if org.Transformer == nil || org.Tokenizer == nil {
		log.Fatal("transformer or tokenizer missing — train one first")
	}

	resolvedModel, transformer := loadCheckpoint(org, dataDir, modelPath, rng)
	org.Transformer = transformer

	fmt.Printf("Model:        %s\n", resolvedModel)
	fmt.Printf("Params:       %d\n", org.Transformer.ParamCount())
	fmt.Printf("Vocab:        %d (max_seq %d)\n",
		org.Tokenizer.ActualVocabSize(), org.Transformer.Config.MaxSeqLen)
	fmt.Printf("Sampling:     temp=%.2f top_k=%d max_tokens=%d min_tokens=%d seed=%d\n",
		temp, topK, maxTokens, minTokens, seed)
	if cot {
		fmt.Printf("CoT:          enabled, %d samples\n", cotSamples)
	}
	fmt.Printf("Suite:        %d tasks across %d categories\n\n",
		len(evalsuite.Standard), len(evalsuite.Categories(evalsuite.Standard)))

	// Generation closures share tokenizer + transformer; the CoT path
	// goes through the Self-Consistency helper.
	generate := func(prompt string) (string, int64) {
		ids := org.Tokenizer.Encode(prompt)
		input := append([]int{org.Tokenizer.BosID()}, ids...)
		t0 := time.Now()
		full := org.Transformer.GenerateFastMin(input, maxTokens, minTokens, float32(temp), topK)
		ms := time.Since(t0).Milliseconds()
		if len(full) <= len(input) {
			return "", ms
		}
		return org.Tokenizer.Decode(full[len(input):]), ms
	}
	generateCoT := func(prompt string) (string, int64) {
		t0 := time.Now()
		cfgCoT := cortex.CoTConfig{
			Samples:         cotSamples,
			MaxTokens:       maxTokens,
			MinTokens:       minTokens,
			BaseTemperature: float32(temp),
			TopK:            topK,
			UseCoTPrimer:    true,
		}
		// Audit 2026-05-26 fix #2: previously memoryContext was "" hardcoded,
		// which meant broca-eval --cot ignored Hippocampus entirely even
		// though the organism had ~2000 memories loaded. Now we replicate
		// the Organism.Process recall logic: encode prompt → SDR → query
		// Hippocampus (keyword-expanded path, which handles synonyms via
		// Brain). If anything comes back, we hand its context string to
		// BuildCoTPrompt so it becomes part of the prompt the transformer
		// sees. If nothing matches, we fall back to "" (original behaviour).
		memCtx := ""
		if org.Hippocampus != nil && org.Encoder != nil {
			promptSDR := org.Encoder.EncodeSentence(prompt)
			inputTokens := strings.Fields(strings.ToLower(prompt))
			threshold := org.Config.HippocampusRecallThresh
			if mem, sim, ok := org.Hippocampus.RecallByKeywordsExpanded(
				inputTokens, int(threshold), promptSDR, org.Brain); ok && sim > 0 {
				memCtx = mem.Context
			} else if mem, sim, ok := org.Hippocampus.RecallScored(
				promptSDR, threshold); ok && sim > 0 {
				memCtx = mem.Context
			}
		}
		ans, ok := cortex.GenerateWithSelfConsistency(
			org.Transformer, org.Tokenizer, memCtx,
			strings.Fields(prompt), cfgCoT)
		ms := time.Since(t0).Milliseconds()
		if !ok {
			return "", ms
		}
		return ans, ms
	}

	report := runReport{
		Timestamp:   time.Now().Format(time.RFC3339),
		ModelPath:   resolvedModel,
		Params:      org.Transformer.ParamCount(),
		VocabSize:   org.Tokenizer.ActualVocabSize(),
		Temperature: temp,
		TopK:        topK,
		MaxTokens:   maxTokens,
		MinTokens:   minTokens,
		Seed:        seed,
		CoTEnabled:  cot,
		SuiteSize:   len(evalsuite.Standard),
		Results:     make([]evalsuite.ScoreResult, 0, len(evalsuite.Standard)),
	}
	if cot {
		report.CoTSamples = cotSamples
	}

	tStart := time.Now()
	for _, t := range evalsuite.Standard {
		var gen string
		var ms int64
		if cot {
			gen, ms = generateCoT(t.Prompt)
		} else {
			gen, ms = generate(t.Prompt)
		}
		r := evalsuite.Grade(t, gen, ms)
		report.Results = append(report.Results, r)

		mark := "[X]"
		if r.Correct {
			mark = "[OK]"
		}
		if !r.Correct || verbose {
			fmt.Printf("  %s [%s/%s] %dms\n", mark, r.Category, r.TaskID, r.GenMs)
			fmt.Printf("      Q: %s\n", r.Prompt)
			fmt.Printf("      A: %s\n", truncate(r.Generated, 120))
			fmt.Printf("      Expected: %s  (%s)\n", r.Expected, r.Reason)
		} else {
			fmt.Printf("  %s [%s/%s] %dms - %s\n", mark, r.Category, r.TaskID, r.GenMs,
				truncate(r.Generated, 80))
		}
	}
	report.TotalWallSecs = time.Since(tStart).Seconds()

	perCat, overall := evalsuite.Summarise(report.Results)
	report.PerCategory = perCat
	report.Overall = overall

	fmt.Printf("\n== EVAL SUMMARY ==\n")
	fmt.Printf("  %-12s %5s %7s %7s %10s\n", "Category", "Total", "Correct", "Acc%", "AvgMs")
	for _, c := range perCat {
		fmt.Printf("  %-12s %5d %7d %6.1f%% %10.0f\n",
			c.Category, c.Total, c.Correct, 100*c.Accuracy, c.AvgGenMs)
	}
	fmt.Printf("  %-12s %5d %7d %6.1f%% %10.0f\n", "-----", overall.Total, overall.Correct,
		100*overall.Accuracy, overall.AvgGenMs)
	fmt.Printf("  Wall time: %.1fs\n", report.TotalWallSecs)

	return report
}

// runCompare evaluates two checkpoints back-to-back and prints a delta.
// Useful as the "did training help?" smoke test between cursa C and D.
func runCompare(
	dataDir, pathA, pathB string,
	maxTokens, minTokens int, temp float64, topK int, seed int64,
	cot bool, cotSamples int, verbose bool,
) {
	fmt.Printf("============== CHECKPOINT A ==============\n  %s\n\n", pathA)
	repA := runSingle(dataDir, pathA, maxTokens, minTokens, temp, topK, seed, cot, cotSamples, verbose)

	fmt.Printf("\n============== CHECKPOINT B ==============\n  %s\n\n", pathB)
	repB := runSingle(dataDir, pathB, maxTokens, minTokens, temp, topK, seed, cot, cotSamples, verbose)

	fmt.Printf("\n============== A vs B DIFF ==============\n")
	fmt.Printf("  %-12s %8s %8s %8s\n", "Category", "A_Acc%", "B_Acc%", "Delta pp")
	catMap := map[string]evalsuite.CategoryStats{}
	for _, c := range repA.PerCategory {
		catMap[c.Category] = c
	}
	for _, b := range repB.PerCategory {
		a, ok := catMap[b.Category]
		aAcc := 0.0
		if ok {
			aAcc = a.Accuracy
		}
		delta := 100 * (b.Accuracy - aAcc)
		arrow := "  "
		switch {
		case delta > 0.5:
			arrow = "++"
		case delta > 0:
			arrow = "+ "
		case delta < -0.5:
			arrow = "--"
		case delta < 0:
			arrow = "- "
		}
		fmt.Printf("  %-12s %7.1f%% %7.1f%% %+6.1f %s\n",
			b.Category, 100*aAcc, 100*b.Accuracy, delta, arrow)
	}
	overallDelta := 100 * (repB.Overall.Accuracy - repA.Overall.Accuracy)
	fmt.Printf("  %-12s %7.1f%% %7.1f%% %+6.1f pp\n",
		"OVERALL", 100*repA.Overall.Accuracy, 100*repB.Overall.Accuracy, overallDelta)

	// Per-task regressions / new wins
	resAByID := map[string]evalsuite.ScoreResult{}
	for _, r := range repA.Results {
		resAByID[r.TaskID] = r
	}
	var regressed, newlyCorrect []string
	for _, b := range repB.Results {
		a, ok := resAByID[b.TaskID]
		if !ok {
			continue
		}
		if a.Correct && !b.Correct {
			regressed = append(regressed, b.TaskID)
		}
		if !a.Correct && b.Correct {
			newlyCorrect = append(newlyCorrect, b.TaskID)
		}
	}
	if len(newlyCorrect) > 0 {
		fmt.Printf("\n  Newly correct in B (%d): %s\n", len(newlyCorrect), strings.Join(newlyCorrect, ", "))
	}
	if len(regressed) > 0 {
		fmt.Printf("\n  Regressed in B (%d): %s\n", len(regressed), strings.Join(regressed, ", "))
	}

	// Write both reports + a diff summary
	stamp := time.Now().Format("20060102-150405")
	outDir := filepath.Join(dataDir, "evals")
	_ = os.MkdirAll(outDir, 0o755)
	_ = writeJSON(filepath.Join(outDir, "compare-"+stamp+"-A.json"), repA)
	_ = writeJSON(filepath.Join(outDir, "compare-"+stamp+"-B.json"), repB)
	fmt.Printf("\nReports written to %s/compare-%s-{A,B}.json\n", outDir, stamp)
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}
