// broca-probe — direct sampling from the trained Broca 2.0 transformer.
//
// Bypasses the organism response pipeline (confidence gating, fallbacks,
// memory) and just feeds a prompt to the transformer to inspect raw
// generation quality. Useful right after a training run to judge whether
// the loss number translates into intelligible text.
//
// Three modes:
//   - interactive: -prompts empty (read stdin loop)
//   - batch:       -prompts "a|b|c" (run list, print to stdout)
//   - bench:       -bench (run the standard benchmark prompt set,
//     collect quality metrics, write JSON report to -out)
//
// The -model flag picks which checkpoint to load. Special value "best"
// resolves to <data-dir>/transformer.best.nxtf so you can compare the
// latest-vs-best checkpoint without changing files on disk.
package main

import (
	"bufio"
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
)

// benchPrompts is the standard set used to compare checkpoints. Mix of
// styles: factual recall, instruction following, open-ended generation,
// short Q&A. Kept stable across runs so reports are comparable.
var benchPrompts = []string{
	"What is the capital of France?",
	"Explain photosynthesis in one sentence.",
	"List three primary colors.",
	"Write a short poem about the moon.",
	"Translate 'good morning' to Spanish.",
	"What causes rain?",
	"Give one tip for learning a new language.",
	"Who wrote Romeo and Juliet?",
	"What is 12 times 7?",
	"Describe the taste of an apple.",
}

// promptReport captures per-prompt quality metrics for one generation.
type promptReport struct {
	Prompt        string  `json:"prompt"`
	Generated     string  `json:"generated"`
	NumTokens     int     `json:"num_tokens"`
	UniqueTokens  int     `json:"unique_tokens"`
	UniqueRatio   float64 `json:"unique_ratio"`    // unique / total — lower = repetitive
	MaxRunLen     int     `json:"max_run_len"`     // longest run of identical tokens
	BigramRepRate float64 `json:"bigram_rep_rate"` // duplicate bigrams / total bigrams
	SecondsMs     int64   `json:"gen_ms"`
}

// benchReport is the top-level JSON document.
type benchReport struct {
	Timestamp   string         `json:"timestamp"`
	ModelPath   string         `json:"model_path"`
	Params      int            `json:"params"`
	VocabSize   int            `json:"vocab_size"`
	Temperature float64        `json:"temperature"`
	TopK        int            `json:"top_k"`
	MaxTokens   int            `json:"max_tokens"`
	Seed        int64          `json:"seed"`
	Prompts     []promptReport `json:"prompts"`
	AvgUnique   float64        `json:"avg_unique_ratio"`
	AvgBigram   float64        `json:"avg_bigram_rep"`
	AvgMaxRun   float64        `json:"avg_max_run"`
}

func main() {
	dataDir := flag.String("data-dir", "./data/cortex-auto", "Organism data directory")
	modelPath := flag.String("model", "", "Transformer .nxtf path. Empty = canonical. 'best' = transformer.best.nxtf")
	maxTokens := flag.Int("max-tokens", 60, "Tokens to generate")
	temperature := flag.Float64("temp", 0.8, "Sampling temperature")
	topK := flag.Int("top-k", 40, "Top-k sampling cutoff")
	seed := flag.Int64("seed", 1, "RNG seed (for the sampler only)")
	prompts := flag.String("prompts", "", "Pipe-separated prompts; empty = interactive (or use -bench)")
	bench := flag.Bool("bench", false, "Run the standard benchmark prompt set and emit a JSON report")
	out := flag.String("out", "", "Where to write the bench report JSON (default: <data-dir>/bench-<timestamp>.json)")
	flag.Parse()

	cfg := cortex.DefaultConfig()
	cfg.DataDir = *dataDir
	cfg.Demo = false
	cfg.NoSave = true
	rng := rand.New(rand.NewSource(*seed))

	if err := compute.InitCuBLAS(); err == nil {
		fmt.Println("[cuBLAS] GPU matmul active")
		defer compute.CloseCuBLAS()
	}

	org, err := cortex.LoadOrganism(cfg, rng)
	if err != nil || org == nil {
		log.Fatalf("LoadOrganism failed: %v", err)
	}
	if org.Transformer == nil || org.Tokenizer == nil {
		log.Fatal("transformer or tokenizer missing — train one first")
	}

	// Resolve -model and optionally swap in a different checkpoint than
	// the one organism.Load already brought in. We just overwrite the
	// transformer field; the rest of the organism is unused here.
	resolvedModel := filepath.Join(*dataDir, "transformer.nxtf")
	switch {
	case *modelPath == "":
		// keep what organism loaded
	case *modelPath == "best":
		resolvedModel = filepath.Join(*dataDir, "transformer.best.nxtf")
		if loaded, lerr := cortex.LoadMiniTransformer(resolvedModel, rng); lerr != nil {
			log.Fatalf("load best checkpoint: %v", lerr)
		} else {
			org.Transformer = loaded
		}
	default:
		resolvedModel = *modelPath
		if loaded, lerr := cortex.LoadMiniTransformer(resolvedModel, rng); lerr != nil {
			log.Fatalf("load model %s: %v", resolvedModel, lerr)
		} else {
			org.Transformer = loaded
		}
	}

	fmt.Printf("Model: %s\n", resolvedModel)
	fmt.Printf("Transformer: %d params, vocab %d, max_seq %d\n",
		org.Transformer.ParamCount(),
		org.Tokenizer.ActualVocabSize(),
		org.Transformer.Config.MaxSeqLen)
	fmt.Printf("Sampling: temp=%.2f top_k=%d max_tokens=%d seed=%d\n\n",
		*temperature, *topK, *maxTokens, *seed)

	generate := func(prompt string) (text string, tokIDs []int, ms int64) {
		ids := org.Tokenizer.Encode(prompt)
		input := append([]int{org.Tokenizer.BosID()}, ids...)
		t0 := time.Now()
		full := org.Transformer.GenerateFast(input, *maxTokens, float32(*temperature), *topK)
		ms = time.Since(t0).Milliseconds()
		generated := full[len(input):]
		return org.Tokenizer.Decode(generated), generated, ms
	}

	if *bench {
		runBench(org, generate, *modelPath, resolvedModel, *temperature, *topK, *maxTokens, *seed, *out, *dataDir)
		return
	}

	run := func(prompt string) {
		prompt = strings.TrimSpace(prompt)
		if prompt == "" {
			return
		}
		text, _, ms := generate(prompt)
		fmt.Printf("> %s\n  %s\n  [%dms]\n\n", prompt, strings.TrimSpace(text), ms)
	}

	if *prompts != "" {
		for _, p := range strings.Split(*prompts, "|") {
			run(p)
		}
		return
	}

	fmt.Println("Type a prompt and press Enter. Empty line or Ctrl+C to exit.")
	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("prompt> ")
		if !scanner.Scan() {
			return
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			return
		}
		run(line)
	}
}

// runBench iterates benchPrompts, gathers per-prompt quality metrics,
// prints a human-readable summary, and writes a JSON report.
func runBench(
	org *cortex.Organism,
	generate func(string) (string, []int, int64),
	modelFlag, resolvedModel string,
	temp float64, topK, maxTokens int, seed int64,
	outPath, dataDir string,
) {
	report := benchReport{
		Timestamp:   time.Now().Format(time.RFC3339),
		ModelPath:   resolvedModel,
		Params:      org.Transformer.ParamCount(),
		VocabSize:   org.Tokenizer.ActualVocabSize(),
		Temperature: temp,
		TopK:        topK,
		MaxTokens:   maxTokens,
		Seed:        seed,
		Prompts:     make([]promptReport, 0, len(benchPrompts)),
	}

	var sumUnique, sumBigram, sumRun float64
	for _, p := range benchPrompts {
		text, ids, ms := generate(p)
		pr := promptReport{
			Prompt:        p,
			Generated:     strings.TrimSpace(text),
			NumTokens:     len(ids),
			SecondsMs:     ms,
			UniqueTokens:  countUnique(ids),
			MaxRunLen:     maxConsecutiveRun(ids),
			BigramRepRate: bigramRepetitionRate(ids),
		}
		if pr.NumTokens > 0 {
			pr.UniqueRatio = float64(pr.UniqueTokens) / float64(pr.NumTokens)
		}
		report.Prompts = append(report.Prompts, pr)
		sumUnique += pr.UniqueRatio
		sumBigram += pr.BigramRepRate
		sumRun += float64(pr.MaxRunLen)

		fmt.Printf("> %s\n  %s\n  [%d tok | unique=%.0f%% | bigram_rep=%.0f%% | max_run=%d | %dms]\n\n",
			p, pr.Generated,
			pr.NumTokens, 100*pr.UniqueRatio, 100*pr.BigramRepRate, pr.MaxRunLen, ms)
	}
	n := float64(len(benchPrompts))
	report.AvgUnique = sumUnique / n
	report.AvgBigram = sumBigram / n
	report.AvgMaxRun = sumRun / n

	fmt.Printf("=== Bench summary ===\n")
	fmt.Printf("  avg unique ratio : %.1f%% (higher = more diverse, ~80-95%% is healthy)\n", 100*report.AvgUnique)
	fmt.Printf("  avg bigram repeat: %.1f%% (lower = less looping, <20%% is healthy)\n", 100*report.AvgBigram)
	fmt.Printf("  avg max run len  : %.1f tokens (lower = no token storms, <5 is healthy)\n", report.AvgMaxRun)

	if outPath == "" {
		outPath = filepath.Join(dataDir, fmt.Sprintf("bench-%s.json", time.Now().Format("20060102-150405")))
	}
	if err := writeJSON(outPath, report); err != nil {
		log.Fatalf("write report: %v", err)
	}
	fmt.Printf("\nReport: %s\n", outPath)
}

func countUnique(ids []int) int {
	seen := make(map[int]struct{}, len(ids))
	for _, id := range ids {
		seen[id] = struct{}{}
	}
	return len(seen)
}

// maxConsecutiveRun is the longest streak of the same token id. A value
// above ~5 usually means the model collapsed into a "the the the..."
// degenerate loop.
func maxConsecutiveRun(ids []int) int {
	if len(ids) == 0 {
		return 0
	}
	best, cur := 1, 1
	for i := 1; i < len(ids); i++ {
		if ids[i] == ids[i-1] {
			cur++
			if cur > best {
				best = cur
			}
		} else {
			cur = 1
		}
	}
	return best
}

// bigramRepetitionRate is (count of bigrams seen more than once) /
// (total bigrams). Catches looping that maxConsecutiveRun misses (e.g.
// "A B A B A B" has no token run but bigram_rep=1.0).
func bigramRepetitionRate(ids []int) float64 {
	if len(ids) < 2 {
		return 0
	}
	counts := make(map[[2]int]int)
	total := 0
	for i := 0; i < len(ids)-1; i++ {
		counts[[2]int{ids[i], ids[i+1]}]++
		total++
	}
	dup := 0
	for _, c := range counts {
		if c > 1 {
			dup += c
		}
	}
	return float64(dup) / float64(total)
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}
