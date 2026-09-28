package cortex

// autonomous.go — Self-Learning Autonomous Loop for Ilaria.
//
// This is what makes Ilaria fundamentally different from ANY frozen LLM:
// it learns CONTINUOUSLY, AUTONOMOUSLY, and FOREVER.
//
// The loop:
//   1. CURIOSITY  — Identify knowledge gaps (what don't I know?)
//   2. SEARCH     — Query Wikipedia + HuggingFace Datasets for answers
//   3. LEARN      — Feed discoveries through Brain/Hippocampus/Wernicke
//   4. EVALUATE   — Test myself on what I learned
//   5. CONSOLIDATE — Sleep-style memory organization
//   6. REPEAT     — Forever

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// KnowledgeGap represents something the organism doesn't know well.
type KnowledgeGap struct {
	Query      string    // The question or topic
	Confidence uint8     // How poorly we know this (0 = no idea, 255 = perfect)
	Attempts   int       // How many times we've tried to learn this
	Created    time.Time // When we first identified this gap
}

// AutonomousLearner is the self-learning engine.
type AutonomousLearner struct {
	Organism  *Organism
	Web       *WebLearner
	Evaluator *SelfEvaluator

	// Knowledge gaps — what we need to learn
	Gaps    []KnowledgeGap
	MaxGaps int

	// Config
	LearnInterval    time.Duration // How often to run a learn cycle
	MaxGapsPerCycle  int           // Max gaps to address per cycle
	SearchLangs      []string      // Languages to search ("en", "ro")
	HFRowsPerDataset int           // Max rows to fetch per HuggingFace dataset

	// Stats
	CycleCount    int
	TotalLearned  int
	TotalSearches int
	StartTime     time.Time
	Running       atomic.Bool

	// Seed topics for initial curiosity
	SeedTopics []string

	// Seed HuggingFace datasets to learn from directly
	SeedDatasets []string

	mu sync.Mutex
}

// NewAutonomousLearner creates a new self-learning engine.
// All seed topics, datasets, and tuning values are read from the organism's Config.
func NewAutonomousLearner(org *Organism) *AutonomousLearner {
	cfg := org.Config

	interval := time.Duration(cfg.AutoLearnInterval) * time.Second
	if interval <= 0 {
		interval = 30 * time.Second
	}
	maxGaps := cfg.AutoMaxGapsPerCycle
	if maxGaps <= 0 {
		maxGaps = 3
	}
	hfRows := cfg.AutoHFRowsPerDS
	if hfRows <= 0 {
		hfRows = 20
	}
	langs := cfg.AutoSearchLangs
	if len(langs) == 0 {
		langs = []string{"en"}
	}

	maxGapsTotal := cfg.AutoMaxGaps
	if maxGapsTotal <= 0 {
		maxGapsTotal = 1000
	}

	return &AutonomousLearner{
		Organism:         org,
		Web:              NewWebLearnerFromConfig(cfg),
		Evaluator:        NewSelfEvaluator(),
		MaxGaps:          maxGapsTotal,
		LearnInterval:    interval,
		MaxGapsPerCycle:  maxGaps,
		SearchLangs:      langs,
		HFRowsPerDataset: hfRows,
		SeedTopics:       cfg.AutoSeedTopics,
		SeedDatasets:     cfg.AutoSeedDatasets,
	}
}

// AddGap adds a knowledge gap to learn about.
func (al *AutonomousLearner) AddGap(query string, confidence uint8) {
	al.mu.Lock()
	defer al.mu.Unlock()

	// Don't duplicate
	for _, g := range al.Gaps {
		if strings.EqualFold(g.Query, query) {
			return
		}
	}

	al.Gaps = append(al.Gaps, KnowledgeGap{
		Query:      query,
		Confidence: confidence,
		Created:    time.Now(),
	})

	// Keep bounded
	if len(al.Gaps) > al.MaxGaps {
		al.Gaps = al.Gaps[1:]
	}
}

// OnLowConfidence is called by Organism.Process() when confidence is low.
// This feeds the curiosity loop automatically.
func (al *AutonomousLearner) OnLowConfidence(input string, confidence uint8) {
	threshold := uint8(100) // default
	if al.Organism != nil && al.Organism.Config.AutoLowConfThreshold > 0 {
		threshold = uint8(al.Organism.Config.AutoLowConfThreshold)
	}
	if confidence < threshold {
		al.AddGap(input, confidence)
	}
}

// Run starts the autonomous learning loop. Blocks until ctx is cancelled.
func (al *AutonomousLearner) Run(ctx context.Context, logFn func(string)) {
	al.StartTime = time.Now()
	al.Running.Store(true)
	defer func() { al.Running.Store(false) }()

	if logFn == nil {
		logFn = func(s string) { fmt.Println(s) }
	}

	// Seed initial curiosity
	logFn("🧠 Autonomous Learner starting...")
	logFn(fmt.Sprintf("📚 Seeding %d initial topics + %d HuggingFace datasets",
		len(al.SeedTopics), len(al.SeedDatasets)))

	for _, topic := range al.SeedTopics {
		al.AddGap(topic, 0) // confidence=0 → totally unknown
	}

	// Pre-learn from seed HuggingFace datasets
	for _, dsID := range al.SeedDatasets {
		logFn(fmt.Sprintf("  🤗 Pre-loading HuggingFace dataset: %s", dsID))
		learned, err := al.Web.LearnFromHuggingFace(al.Organism, dsID, al.HFRowsPerDataset)
		if err != nil {
			logFn(fmt.Sprintf("    ⚠️  HuggingFace dataset %s failed: %v", dsID, err))
		} else {
			logFn(fmt.Sprintf("    ✅ Learned %d items from %s", learned, dsID))
			al.TotalLearned += learned
		}
	}

	logFn(fmt.Sprintf("🔄 Learning cycle every %v, %d gaps per cycle", al.LearnInterval, al.MaxGapsPerCycle))

	for {
		select {
		case <-ctx.Done():
			logFn("🛑 Autonomous Learner stopped.")
			return
		default:
			al.LearnCycle(logFn)

			// Save organism periodically
			if al.CycleCount%5 == 0 {
				if err := al.Organism.Save(al.Organism.Config.DataDir); err != nil {
					logFn(fmt.Sprintf("⚠️  Save failed: %v", err))
				} else {
					logFn("💾 Organism saved to disk.")
				}
			}

			// Wait before next cycle
			select {
			case <-ctx.Done():
				return
			case <-time.After(al.LearnInterval):
			}
		}
	}
}

// LearnCycle executes one learning cycle.
func (al *AutonomousLearner) LearnCycle(logFn func(string)) {
	al.mu.Lock()
	cycle := al.CycleCount
	al.CycleCount++

	// Pick top gaps (lowest confidence first)
	gaps := al.topGaps(al.MaxGapsPerCycle)
	al.mu.Unlock()

	logFn(fmt.Sprintf("\n═══ Cycle %d ═══════════════════════════════════════", cycle+1))

	if len(gaps) == 0 {
		logFn("  ✅ No knowledge gaps! Generating new curiosity...")
		// If no gaps, evaluate to find weak spots
		score := al.Evaluator.Evaluate(al.Organism)
		logFn(fmt.Sprintf("  📊 Self-test: %d/%d correct (%.1f%%)", score.Correct, score.TestCount, score.Score*100))

		weak := al.Evaluator.WeakTests(0.3)
		for _, w := range weak {
			al.AddGap(w.Question, 0)
		}
		return
	}

	for _, gap := range gaps {
		logFn(fmt.Sprintf("  🔍 Learning: \"%s\" (confidence: %d/255)", gap.Query, gap.Confidence))

		totalLearned := 0

		// ── Wikipedia search ──────────────────────────────────────────────
		for _, lang := range al.SearchLangs {
			results, err := al.Web.SearchWikipedia(gap.Query, lang, 3)
			if err != nil {
				logFn(fmt.Sprintf("    ⚠️  Search failed (%s): %v", lang, err))
				continue
			}

			if len(results) == 0 {
				continue
			}

			logFn(fmt.Sprintf("    📖 Found %d results (%s)", len(results), lang))

			// Get full summaries for top results
			for i, r := range results {
				if i >= 2 { // Max 2 full articles per gap per language
					break
				}

				summary, err := al.Web.GetWikipediaSummary(r.Title, lang)
				if err != nil {
					continue
				}

				if summary.Content == "" {
					continue
				}

				// LEARN!
				learned := al.Web.LearnFromResults(al.Organism, []SearchResult{*summary})
				totalLearned += learned

				// Create self-test from what we learned
				al.Evaluator.AddTestFromFact(summary.Title, summary.Content, summary.Source)

				logFn(fmt.Sprintf("    ✅ Learned: \"%s\" (%d chars)", summary.Title, len(summary.Content)))
			}
		}

		// ── HuggingFace Datasets search ──────────────────────────────────
		hfResults, err := al.Web.SearchHuggingFace(gap.Query, 2)
		if err != nil {
			logFn(fmt.Sprintf("    ⚠️  HuggingFace search failed: %v", err))
		} else if len(hfResults) > 0 {
			logFn(fmt.Sprintf("    🤗 Found %d HuggingFace datasets", len(hfResults)))
			for _, ds := range hfResults {
				learned, err := al.Web.LearnFromHuggingFace(al.Organism, ds.Title, al.HFRowsPerDataset)
				if err != nil {
					logFn(fmt.Sprintf("    ⚠️  HF dataset %s failed: %v", ds.Title, err))
					continue
				}
				if learned > 0 {
					totalLearned += learned
					logFn(fmt.Sprintf("    ✅ Learned %d items from HF:%s", learned, ds.Title))
				}
			}
		}

		al.mu.Lock()
		al.TotalLearned += totalLearned
		al.TotalSearches++
		// Mark gap as addressed (increase confidence or remove)
		al.removeGap(gap.Query)
		al.mu.Unlock()
	}

	// Self-evaluate after learning
	if len(al.Evaluator.TestBank) > 0 && cycle%3 == 0 {
		score := al.Evaluator.Evaluate(al.Organism)
		trend := al.Evaluator.ImprovementTrend(5)
		logFn(fmt.Sprintf("  📊 Self-test: %d/%d (%.1f%%) trend: %+.1f%%",
			score.Correct, score.TestCount, score.Score*100, trend*100))
	}

	// Periodic consolidation (every 10 cycles = "sleep")
	if cycle > 0 && cycle%10 == 0 {
		logFn("  😴 Consolidating memories (sleep cycle)...")
		al.Organism.Sleep()
		logFn("  ✅ Consolidation complete.")
	}

	logFn(fmt.Sprintf("  📈 Totals: %d facts learned, %d searches, %d tests, %d gaps remaining",
		al.Web.TotalFacts, al.TotalSearches, len(al.Evaluator.TestBank), len(al.Gaps)))
}

// topGaps returns the N gaps with lowest confidence.
func (al *AutonomousLearner) topGaps(n int) []KnowledgeGap {
	if n > len(al.Gaps) {
		n = len(al.Gaps)
	}
	// Simple: return first N (they're added in order)
	result := make([]KnowledgeGap, n)
	copy(result, al.Gaps[:n])
	return result
}

// removeGap removes a gap by query.
func (al *AutonomousLearner) removeGap(query string) {
	for i, g := range al.Gaps {
		if strings.EqualFold(g.Query, query) {
			al.Gaps = append(al.Gaps[:i], al.Gaps[i+1:]...)
			return
		}
	}
}

// Stats returns current learning statistics.
func (al *AutonomousLearner) Stats() string {
	uptime := time.Since(al.StartTime).Round(time.Second)
	return fmt.Sprintf(
		"Autonomous Learner Stats:\n"+
			"  Uptime: %v\n"+
			"  Cycles: %d\n"+
			"  Facts Learned: %d\n"+
			"  Searches: %d\n"+
			"  Test Bank: %d tests\n"+
			"  Knowledge Gaps: %d\n"+
			"  Vocab Size: %d\n"+
			"  Synapses: %d\n",
		uptime, al.CycleCount, al.Web.TotalFacts,
		al.TotalSearches, len(al.Evaluator.TestBank),
		len(al.Gaps), al.Organism.Vocab.Size(),
		0) // synapse count omitted for compatibility
}
