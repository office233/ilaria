// bulk-ingest — fast Q/A corpus ingestion via LearnQAFast.
//
// Loads an existing organism, iterates a Dolly- or Alpaca-formatted
// JSONL corpus, and calls LearnQAFast(instruction, response) for each
// entry. Skips the heavy FractalCortex/RadioCortex training paths so
// we can ingest 10k pairs in seconds instead of hours.
//
// Built for Cursa E (2026-05-26): stress-test the SDR-collapse fix
// from Cursa D under 'recall in zgomot' — does the cortex-eval score
// hold once Hippocampus has 1000s of unrelated memories crowding the
// keyword index and SDR space?
//
// Format autodetection:
//   - Dolly:  {"instruction":..., "response":...}   (response field)
//   - Alpaca: {"instruction":..., "output":...}     (output field)
//   - Skips: lines with empty/missing instruction or answer
//   - Skips: {"text": ...} lines (those are unsupervised text, not Q/A)
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"math/rand"
	"os"
	"strings"
	"time"

	"ilaria/cortex"
)

type qaEntry struct {
	Instruction string `json:"instruction"`
	Response    string `json:"response"` // dolly
	Output      string `json:"output"`   // alpaca
	Text        string `json:"text"`     // unsupervised — skip
}

func main() {
	dataDir := flag.String("data-dir", "./data/cortex-auto", "Organism data directory")
	corpusPath := flag.String("corpus", "./data/corpus/dolly.jsonl", "JSONL corpus path")
	limit := flag.Int("limit", 1000, "Max number of Q/A pairs to ingest (0 = no limit)")
	seed := flag.Int64("seed", 1, "RNG seed for organism load")
	save := flag.Bool("save", true, "Persist organism state after ingest")
	progressEvery := flag.Int("progress-every", 100, "Print progress every N ingested pairs")
	flag.Parse()

	cfg := cortex.DefaultConfig()
	cfg.DataDir = *dataDir
	cfg.Demo = false
	cfg.NoSave = !*save

	rng := rand.New(rand.NewSource(*seed))
	org, err := cortex.LoadOrganism(cfg, rng)
	if err != nil || org == nil {
		fmt.Fprintf(os.Stderr, "load failed: %v\n", err)
		os.Exit(1)
	}
	startMems := org.Hippocampus.Size()
	fmt.Printf("Loaded organism: %d existing memories\n", startMems)

	f, err := os.Open(*corpusPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open corpus: %v\n", err)
		os.Exit(1)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	// Some Alpaca entries are huge (multi-paragraph). Bump buffer.
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	var (
		ingested int
		skipped  int
		lineNum  int
	)
	start := time.Now()

	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "{") {
			continue
		}
		var e qaEntry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			skipped++
			continue
		}

		q := strings.TrimSpace(e.Instruction)
		a := strings.TrimSpace(e.Response)
		if a == "" {
			a = strings.TrimSpace(e.Output)
		}
		if q == "" || a == "" {
			skipped++
			continue
		}

		org.LearnQAFast(q, a)
		ingested++

		if ingested%*progressEvery == 0 {
			rate := float64(ingested) / time.Since(start).Seconds()
			fmt.Printf("  [%d ingested, %d skipped, %.0f/s] last: %.60s\n",
				ingested, skipped, rate, q)
		}
		if *limit > 0 && ingested >= *limit {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "scan error at line %d: %v\n", lineNum, err)
	}

	endMems := org.Hippocampus.Size()
	elapsed := time.Since(start)
	fmt.Printf("\nDone. Ingested=%d, skipped=%d, in %.2fs (%.0f pairs/s)\n",
		ingested, skipped, elapsed.Seconds(),
		float64(ingested)/elapsed.Seconds())
	fmt.Printf("Hippocampus: %d → %d memories (+%d, reconsolidation merged %d)\n",
		startMems, endMems, endMems-startMems, ingested-(endMems-startMems))

	if *save {
		fmt.Printf("Saving organism to %s ...\n", *dataDir)
		saveStart := time.Now()
		if err := org.Save(*dataDir); err != nil {
			fmt.Fprintf(os.Stderr, "save failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Saved in %.2fs\n", time.Since(saveStart).Seconds())
	}
}
