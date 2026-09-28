// cortex-learn-demo — end-to-end demonstration of continuous web learning.
//
// What it does:
//  1. Loads the organism from disk.
//  2. Asks a question about a specific topic — captures the BEFORE answer.
//  3. Searches Wikipedia for that topic.
//  4. Feeds the result through the learning pipeline (LearnFromResults).
//  5. Asks the same question again — captures the AFTER answer.
//  6. Prints both side-by-side so the impact of one learning step is visible.
//
// This is the demo no LLM can do: real-time learning during the same
// process, without retraining, persisting to disk for the next session.
//
// Usage:
//
//	cortex-learn-demo -data-dir ./data/cortex-auto -topic "Saturn" -lang en -ask "What is Saturn?"
package main

import (
	"flag"
	"fmt"
	"log"
	"math/rand"
	"strings"

	"ilaria/cortex"
)

func main() {
	dataDir := flag.String("data-dir", "./data/cortex-auto", "Organism data directory")
	topic := flag.String("topic", "Saturn", "Wikipedia topic to fetch")
	lang := flag.String("lang", "en", "Wikipedia language (en, ro, ...)")
	ask := flag.String("ask", "", "Question to ask before+after learning. Defaults to: What is <topic>?")
	noSave := flag.Bool("no-save", false, "Do not persist learned state to disk")
	diag := flag.Bool("diag", false, "Print hippocampus recall diagnosis after the AFTER step")
	seed := flag.Int64("seed", 42, "RNG seed")
	flag.Parse()

	if *ask == "" {
		*ask = "What is " + *topic + "?"
	}

	cfg := cortex.DefaultConfig()
	cfg.DataDir = *dataDir
	cfg.Seed = *seed
	cfg.Demo = false
	cfg.NoSave = *noSave

	rng := rand.New(rand.NewSource(cfg.Seed))

	fmt.Println("=== cortex-learn-demo ===")
	fmt.Printf("Loading organism from %s ...\n", *dataDir)
	org, err := cortex.LoadOrganism(cfg, rng)
	if err != nil || org == nil {
		log.Fatalf("LoadOrganism failed: %v", err)
	}
	fmt.Printf("Loaded: vocab=%d, hippocampus=%d memories\n",
		org.Vocab.Size(), org.Hippocampus.Size())

	// ── 1. BEFORE ─────────────────────────────────────────────────────
	fmt.Printf("\n--- BEFORE learning ---\n")
	fmt.Printf("Q: %s\n", *ask)
	before := strings.TrimSpace(org.Process(*ask))
	fmt.Printf("A: %s\n", truncate(before, 240))

	// ── 2. SEARCH + LEARN ─────────────────────────────────────────────
	fmt.Printf("\n--- LEARNING from Wikipedia(%s): %q ---\n", *lang, *topic)
	wl := cortex.NewWebLearnerFromConfig(cfg)

	summary, err := wl.GetWikipediaSummary(*topic, *lang)
	if err != nil {
		log.Fatalf("Wikipedia fetch failed: %v", err)
	}
	if summary == nil || summary.Content == "" {
		log.Fatalf("Empty Wikipedia summary for %q", *topic)
	}
	fmt.Printf("Got %d chars from %q\n", len(summary.Content), summary.Title)
	fmt.Printf("Preview: %s\n", truncate(summary.Content, 200))

	hippoBefore := org.Hippocampus.Size()
	learned := wl.LearnFromResults(org, []cortex.SearchResult{*summary})
	hippoAfter := org.Hippocampus.Size()
	fmt.Printf("Learned items: %d  |  Hippocampus: %d -> %d (+%d)\n",
		learned, hippoBefore, hippoAfter, hippoAfter-hippoBefore)

	// ── 3. AFTER ──────────────────────────────────────────────────────
	fmt.Printf("\n--- AFTER learning ---\n")
	fmt.Printf("Q: %s\n", *ask)
	after := strings.TrimSpace(org.Process(*ask))
	fmt.Printf("A: %s\n", truncate(after, 240))

	// ── 3b. RECALL DIAGNOSIS (opt-in) ────────────────────────────────
	// Inspect what the hippocampus actually returns for the query, so we
	// can tell whether the new memory exists but is outranked by an
	// older generic one. Off by default — useful when debugging recall
	// regressions but noisy in normal use.
	if *diag {
		fmt.Printf("\n--- RECALL DIAGNOSIS (post-learn) ---\n")
		// Use Wernicke.Understand the same way Process() does, otherwise
		// the diagnosis SDR doesn't match what the live recall path sees.
		combinedSDR := org.Wernicke.Understand(*ask).Combined
		fmt.Printf("query Wernicke SDR active=%d\n", combinedSDR.ActiveCount)
		if mem, sim, ok := org.Hippocampus.RecallScored(combinedSDR, 0); ok {
			fmt.Printf("SDR best match (sim=%d): %s\n", sim, truncate(mem.Context, 160))
		} else {
			fmt.Println("SDR recall: no match")
		}
		inputTokens := cortex.Tokenize(*ask)
		if mem, score, ok := org.Hippocampus.RecallByKeywordsExpanded(inputTokens, 1, combinedSDR, org.Brain); ok {
			fmt.Printf("Keyword best match (score=%d): %s\n", score, truncate(mem.Context, 160))
		} else {
			fmt.Println("Keyword recall: no match")
		}
		fmt.Printf("Memories containing %q (newly learned):\n", *topic)
		hits := 0
		for _, m := range org.Hippocampus.Memories {
			if strings.Contains(strings.ToLower(m.Context), strings.ToLower(*topic)) {
				hits++
				if hits <= 3 {
					fmt.Printf("  - %s\n", truncate(m.Context, 140))
				}
			}
		}
		fmt.Printf("  (total: %d)\n", hits)
	}

	// ── 4. VERDICT ────────────────────────────────────────────────────
	fmt.Printf("\n--- VERDICT ---\n")
	changed := before != after
	fmt.Printf("Response changed: %v\n", changed)
	if changed {
		fmt.Println("✅ Real-time learning observable: organism produced a different answer")
		fmt.Println("   after a single Wikipedia fetch, without any retraining step.")
	} else {
		fmt.Println("⚠️  Response did not change. Possible causes:")
		fmt.Println("   - Topic already present in episodic memory")
		fmt.Println("   - Confidence threshold blocked the new answer")
		fmt.Println("   - Memory recall picked the same older fact")
	}

	if !cfg.NoSave {
		fmt.Println("\nSaving organism (persists what was learned this run)...")
		if err := org.Save(cfg.DataDir); err != nil {
			log.Fatalf("save failed: %v", err)
		}
		fmt.Println("Done.")
	}
}

// truncate keeps long Wikipedia bodies from drowning the terminal.
// Falls back to the original string when shorter than max.
func truncate(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max] + " …"
}
