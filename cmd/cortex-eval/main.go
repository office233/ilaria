package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"ilaria/cortex"
)

// ──────────────────────────────────────────────────────────────────────────────
// Comprehensive test case — extends the cortex.TestCase with category + expected
// ──────────────────────────────────────────────────────────────────────────────

type ComprehensiveCase struct {
	Input    string `json:"input"`
	Expected string `json:"expected"`
	Category string `json:"category"` // recall | generalization | wikipedia | reasoning
}

// CategoryStats tracks per-category performance metrics.
type CategoryStats struct {
	Total        int
	FullMatch    int
	PartialMatch int
	Failed       int
	SumOverlap   float64
}

// CaseResult holds the outcome of running a single ComprehensiveCase.
type CaseResult struct {
	Case       ComprehensiveCase
	Response   string
	Score      string  // "FULL", "PARTIAL", "FAIL"
	Overlap    float64 // word overlap ratio 0.0–1.0
	Confidence uint8
}

func main() {
	dataDir := flag.String("data-dir", "./data/cortex", "Path to organism data directory")
	seed := flag.Int64("seed", 42, "Random seed for deterministic runs")
	fresh := flag.Bool("fresh", false, "Start with a new organism (ignore saved state)")
	evalPath := flag.String("eval", "", "Path to a comprehensive JSONL eval file")
	legacy := flag.Bool("legacy", false, "Run legacy 3-suite eval (basic_recall, no_echo, generalization)")
	fullThresh := flag.Float64("full-threshold", 0.80, "Word overlap threshold for a FULL match (0.0 to 1.0)")
	partialThresh := flag.Float64("partial-threshold", 0.50, "Word overlap threshold for a PARTIAL match (0.0 to 1.0)")
	maxGen := flag.Int("max-gen", 0, "Override Config.MaxGenWords (0 = use config default). Useful with Broca 2.0 to bound runtime.")
	flag.Parse()

	cfg := cortex.DefaultConfig()
	cfg.DataDir = *dataDir
	cfg.Fresh = *fresh
	cfg.Seed = *seed
	cfg.Demo = false
	cfg.NoSave = true
	if *maxGen > 0 {
		cfg.MaxGenWords = *maxGen
	}

	// Pre-warm: load organism once to verify state is valid.
	loadOrganism(cfg, rand.New(rand.NewSource(cfg.Seed)), true)
	newOrganism := func() *cortex.Organism {
		return loadOrganism(cfg, rand.New(rand.NewSource(cfg.Seed)), false)
	}

	// ── Legacy mode (unchanged behaviour) ────────────────────────────────
	if *legacy {
		runLegacy(newOrganism, *evalPath)
		return
	}

	// ── Comprehensive mode ───────────────────────────────────────────────
	path := *evalPath
	if path == "" {
		path = filepath.Join(".", "data", "evals", "comprehensive.jsonl")
	}
	cases, err := loadComprehensiveSuite(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Loaded %d comprehensive test cases from %s\n\n", len(cases), path)

	fmt.Println("  ⚠️  EVALUATION NOTICE:")
	fmt.Println("  Word overlap evaluation is a lexical proximity metric (Jaccard-like overlap of keywords).")
	fmt.Println("  It serves as a fast diagnostic tool for semantic recall and cognitive association, but")
	fmt.Println("  does not assess linguistic fluency, syntactic correctness, or grammatical coherence.")
	fmt.Printf("  Full evaluation scoring (FULL >= %.0f%%, PARTIAL >= %.0f%%) is strict and aims to limit false positives.\n", *fullThresh*100, *partialThresh*100)
	fmt.Println()

	results := runComprehensive(cases, newOrganism, *fullThresh, *partialThresh)
	printComprehensiveReport(results)
}

// ─────────────────────────────────────────────────────────────────────────────
// Comprehensive eval logic
// ─────────────────────────────────────────────────────────────────────────────

func loadComprehensiveSuite(path string) ([]ComprehensiveCase, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open comprehensive suite %s: %w", path, err)
	}
	defer f.Close()

	var cases []ComprehensiveCase
	scanner := bufio.NewScanner(f)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "//") {
			continue
		}
		var cc ComprehensiveCase
		if err := json.Unmarshal([]byte(line), &cc); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNo, err)
		}
		if cc.Category == "" {
			cc.Category = "unknown"
		}
		cases = append(cases, cc)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan: %w", err)
	}
	return cases, nil
}

func runComprehensive(cases []ComprehensiveCase, newOrg func() *cortex.Organism, fullThresh, partialThresh float64) []CaseResult {
	results := make([]CaseResult, 0, len(cases))
	for i, cc := range cases {
		org := newOrg()
		response := org.Process(cc.Input)
		conf := org.Prefrontal.GetConfidence()
		if response == cortex.NoConfidentResponse {
			conf = 0
		}

		overlap := wordOverlap(response, cc.Expected)
		score := "FAIL"
		if overlap >= fullThresh {
			score = "FULL"
		} else if overlap >= partialThresh {
			score = "PARTIAL"
		}

		results = append(results, CaseResult{
			Case:       cc,
			Response:   response,
			Score:      score,
			Overlap:    overlap,
			Confidence: conf,
		})

		icon := "✗"
		if score == "FULL" {
			icon = "✓"
		} else if score == "PARTIAL" {
			icon = "~"
		}
		fmt.Printf("  [%s] %2d. %-7s | %-50s → overlap=%.0f%%\n",
			icon, i+1, fmt.Sprintf("[%s]", cc.Category), truncate(cc.Input, 50), overlap*100)
	}
	fmt.Println()
	return results
}

// wordOverlap computes the ratio of expected words found in the response.
func wordOverlap(response, expected string) float64 {
	trimmed := strings.Trim(strings.TrimSpace(response), " \t\n\r.,;:!?\"'()[]{}")
	if trimmed == "" || trimmed == "?" || trimmed == "." {
		return 0.0
	}
	expectedWords := tokenize(expected)
	if len(expectedWords) == 0 {
		return 1.0 // vacuously true
	}
	responseLower := strings.ToLower(response)
	matched := 0
	for _, w := range expectedWords {
		if strings.Contains(responseLower, strings.ToLower(w)) {
			matched++
		}
	}
	return float64(matched) / float64(len(expectedWords))
}

func tokenize(s string) []string {
	raw := strings.Fields(strings.ToLower(s))
	words := make([]string, 0, len(raw))
	for _, w := range raw {
		w = strings.Trim(w, ".,;:!?\"'()[]{}")
		if w != "" {
			words = append(words, w)
		}
	}
	return words
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-3] + "..."
}

// ─────────────────────────────────────────────────────────────────────────────
// Comprehensive report
// ─────────────────────────────────────────────────────────────────────────────

func printComprehensiveReport(results []CaseResult) {
	// ── Failures detail ──────────────────────────────────────────────────
	fmt.Println("FAILED / PARTIAL TEST CASES")
	fmt.Println(strings.Repeat("─", 100))
	hasIssues := false
	for _, r := range results {
		if r.Score == "FULL" {
			continue
		}
		hasIssues = true
		fmt.Printf("  Category: %s\n", r.Case.Category)
		fmt.Printf("  Input:    %q\n", r.Case.Input)
		fmt.Printf("  Expected: %q\n", r.Case.Expected)
		fmt.Printf("  Got:      %q  (conf: %d, overlap: %.0f%%, score: %s)\n",
			r.Response, r.Confidence, r.Overlap*100, r.Score)
		fmt.Println(strings.Repeat("─", 100))
	}
	if !hasIssues {
		fmt.Println("  None — all test cases passed!")
		fmt.Println(strings.Repeat("─", 100))
	}

	// ── Per-category breakdown ───────────────────────────────────────────
	cats := buildCategoryStats(results)
	orderedCats := []string{"recall", "generalization", "wikipedia", "reasoning"}
	// Add any categories present but not in the predefined list.
	for cat := range cats {
		found := false
		for _, o := range orderedCats {
			if o == cat {
				found = true
				break
			}
		}
		if !found {
			orderedCats = append(orderedCats, cat)
		}
	}

	fmt.Println("\nPER-CATEGORY SCOREBOARD")
	fmt.Printf("  %-18s %6s %6s %8s %6s %10s\n",
		"Category", "Total", "Full", "Partial", "Fail", "Avg Ovlp")
	fmt.Println("  " + strings.Repeat("─", 58))

	var grandTotal, grandFull, grandPartial, grandFail int
	var grandOverlap float64
	for _, cat := range orderedCats {
		s, ok := cats[cat]
		if !ok {
			continue
		}
		avg := 0.0
		if s.Total > 0 {
			avg = s.SumOverlap / float64(s.Total) * 100
		}
		fmt.Printf("  %-18s %6d %6d %8d %6d %9.1f%%\n",
			cat, s.Total, s.FullMatch, s.PartialMatch, s.Failed, avg)
		grandTotal += s.Total
		grandFull += s.FullMatch
		grandPartial += s.PartialMatch
		grandFail += s.Failed
		grandOverlap += s.SumOverlap
	}
	fmt.Println("  " + strings.Repeat("─", 58))
	grandAvg := 0.0
	if grandTotal > 0 {
		grandAvg = grandOverlap / float64(grandTotal) * 100
	}
	fmt.Printf("  %-18s %6d %6d %8d %6d %9.1f%%\n",
		"TOTAL", grandTotal, grandFull, grandPartial, grandFail, grandAvg)

	// ── Confidence calibration ───────────────────────────────────────────
	fmt.Println("\nCONFIDENCE CALIBRATION")
	type confBucket struct {
		cat                      string
		avgAll, avgFull, avgFail float64
	}
	var buckets []confBucket
	for _, cat := range orderedCats {
		s, ok := cats[cat]
		if !ok {
			continue
		}
		var sumAll, sumFull, sumFail uint64
		var cntFull, cntFail int
		for _, r := range results {
			if r.Case.Category != cat {
				continue
			}
			sumAll += uint64(r.Confidence)
			if r.Score == "FULL" {
				sumFull += uint64(r.Confidence)
				cntFull++
			} else {
				sumFail += uint64(r.Confidence)
				cntFail++
			}
		}
		b := confBucket{cat: cat}
		if s.Total > 0 {
			b.avgAll = float64(sumAll) / float64(s.Total)
		}
		if cntFull > 0 {
			b.avgFull = float64(sumFull) / float64(cntFull)
		}
		if cntFail > 0 {
			b.avgFail = float64(sumFail) / float64(cntFail)
		}
		buckets = append(buckets, b)
	}
	fmt.Printf("  %-18s %8s %8s %8s\n", "Category", "Avg", "Full", "Fail")
	fmt.Println("  " + strings.Repeat("─", 46))
	for _, b := range buckets {
		fmt.Printf("  %-18s %8.1f %8.1f %8.1f\n", b.cat, b.avgAll, b.avgFull, b.avgFail)
	}

	// ── Final composite score ────────────────────────────────────────────
	score := compositeScore(cats)
	fmt.Printf("\n══════════════════════════════════════════════════════════\n")
	fmt.Printf("  ILARIA COMPREHENSIVE SCORE:  %.1f / 100.0\n", score)
	fmt.Printf("══════════════════════════════════════════════════════════\n")
}

func buildCategoryStats(results []CaseResult) map[string]*CategoryStats {
	cats := make(map[string]*CategoryStats)
	for _, r := range results {
		s, ok := cats[r.Case.Category]
		if !ok {
			s = &CategoryStats{}
			cats[r.Case.Category] = s
		}
		s.Total++
		s.SumOverlap += r.Overlap
		switch r.Score {
		case "FULL":
			s.FullMatch++
		case "PARTIAL":
			s.PartialMatch++
		default:
			s.Failed++
		}
	}
	return cats
}

// compositeScore computes a weighted overall score.
// Full match = 1.0, partial = 0.5, fail = 0.
// Categories are equally weighted.
func compositeScore(cats map[string]*CategoryStats) float64 {
	if len(cats) == 0 {
		return 0
	}
	// Sort categories for determinism.
	keys := make([]string, 0, len(cats))
	for k := range cats {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var catScoreSum float64
	for _, k := range keys {
		s := cats[k]
		if s.Total == 0 {
			continue
		}
		points := float64(s.FullMatch) + float64(s.PartialMatch)*0.5
		catScoreSum += (points / float64(s.Total)) * 100.0
	}
	return catScoreSum / float64(len(keys))
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy mode — preserved for backward compatibility
// ─────────────────────────────────────────────────────────────────────────────

func runLegacy(newOrganism func() *cortex.Organism, singlePath string) {
	var suites []cortex.SuiteResult
	if singlePath != "" {
		cases := mustLoadSuite(singlePath)
		fmt.Printf("Loaded %d test cases from %s.\n\n", len(cases), singlePath)
		suites = append(suites, cortex.RunSuiteIsolated(filepath.Base(singlePath), cases, newOrganism))
	} else {
		evalsDir := filepath.Join(".", "data", "evals")
		recallPath := filepath.Join(evalsDir, "basic_recall.jsonl")
		noEchoPath := filepath.Join(evalsDir, "no_echo.jsonl")
		generalizationPath := filepath.Join(evalsDir, "generalization.jsonl")

		recallCases := mustLoadSuite(recallPath)
		noEchoCases := mustLoadSuite(noEchoPath)
		generalizationCases := mustLoadSuite(generalizationPath)
		fmt.Printf(
			"Loaded %d seen-recall cases, %d anti-echo cases, and %d generalization cases.\n\n",
			len(recallCases), len(noEchoCases), len(generalizationCases),
		)

		suites = append(suites,
			cortex.RunSuiteIsolated("Seen Training Recall", recallCases, newOrganism),
			cortex.RunSuiteIsolated("Anti-Echo Boundaries", noEchoCases, newOrganism),
			cortex.RunSuiteIsolated("Held-out Generalization", generalizationCases, newOrganism),
		)
	}
	printLegacyReport(suites)
}

func loadOrganism(cfg cortex.Config, rng *rand.Rand, verbose bool) *cortex.Organism {
	var org *cortex.Organism
	var err error
	if !cfg.Fresh {
		org, err = cortex.LoadOrganism(cfg, rng)
	}
	if org != nil {
		if verbose {
			fmt.Println("Loaded persisted organism state.")
		}
		return org
	}
	if verbose {
		if err != nil {
			fmt.Printf("No saved organism found or load failed (%v); using fresh state.\n", err)
		} else {
			fmt.Println("Using fresh organism state.")
		}
	}
	return cortex.NewOrganism(cfg, rng)
}

func mustLoadSuite(path string) []cortex.TestCase {
	cases, err := cortex.LoadEvalSuite(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load eval suite %s: %v\n", path, err)
		os.Exit(1)
	}
	return cases
}

func printLegacyReport(suites []cortex.SuiteResult) {
	fmt.Println("FAILED TEST CASES")
	fmt.Println(strings.Repeat("-", 80))
	hasFailures := false
	for _, suite := range suites {
		for _, tr := range suite.Results {
			if tr.Passed {
				continue
			}
			hasFailures = true
			fmt.Printf("Suite:    %s\n", suite.Name)
			fmt.Printf("Input:    %q\n", tr.Case.Input)
			fmt.Printf("Got:      %q (conf: %d)\n", tr.Response, tr.Confidence)
			if len(tr.Case.ExpectedContains) > 0 {
				fmt.Printf("Expected: %v\n", tr.Case.ExpectedContains)
			}
			fmt.Printf("Reason:   %s\n", tr.Reason)
			fmt.Println(strings.Repeat("-", 80))
		}
	}
	if !hasFailures {
		fmt.Println("None")
		fmt.Println(strings.Repeat("-", 80))
	}

	fmt.Println("\nCAPABILITY SCOREBOARD")
	fmt.Printf("%-28s %6s %7s %9s %8s\n", "Suite", "Total", "Passed", "Recall", "Echo")
	for _, suite := range suites {
		fmt.Printf("%-28s %6d %7d %8.1f%% %7.1f%%\n",
			suite.Name, suite.Total, suite.Passed, suite.RecallRate, suite.EchoRate)
	}

	fmt.Println("\nCONFIDENCE CALIBRATION")
	for _, suite := range suites {
		fmt.Printf("%-28s avg=%5.1f passed=%5.1f failed=%5.1f\n",
			suite.Name, suite.AvgConfidence, suite.AvgPassedConf, suite.AvgFailedConf)
	}

	fmt.Printf("\nILARIA CAPABILITY SCORE: %.1f / 100.0\n", legacyCapabilityScore(suites))
}

func legacyCapabilityScore(suites []cortex.SuiteResult) float64 {
	var total, passed, echoed int
	for _, suite := range suites {
		total += suite.Total
		passed += suite.Passed
		echoed += suite.Echoed
	}
	if total == 0 {
		return 0
	}
	passRate := float64(passed) / float64(total) * 100.0
	antiEchoRate := 100.0 - (float64(echoed) / float64(total) * 100.0)
	return (passRate * 0.8) + (antiEchoRate * 0.2)
}
