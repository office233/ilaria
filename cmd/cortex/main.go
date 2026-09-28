package main

import (
	"flag"
	"fmt"
	"math/rand"
	"os"
	"strings"

	"ilaria/cortex"
)

// flowEmoji returns a human-readable flow indicator.
func flowEmoji(inFlow bool) string {
	if inFlow {
		return "🌊 YES — organism is in flow!"
	}
	return "🚫 No — not yet in flow"
}

// valenceBar returns a simple text bar for valence (-128..+127).
func valenceBar(v int8) string {
	if v > 0 {
		return fmt.Sprintf("+%d (positive)", v)
	}
	if v < 0 {
		return fmt.Sprintf("%d (negative)", v)
	}
	return "0 (neutral)"
}

// topicList formats a slice of topic strings for display.
func topicList(topics []string) string {
	if len(topics) == 0 {
		return "(none)"
	}
	return strings.Join(topics, ", ")
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers — pretty-printing utilities
// ═══════════════════════════════════════════════════════════════════════

func banner() {
	fmt.Println()
	fmt.Println("╔══════════════════════════════════════════════════════════════════╗")
	fmt.Println("║                                                                  ║")
	fmt.Println("║   🧠  ILARIA — Organism Digital v0.4                       ║")
	fmt.Println("║                                                                  ║")
	fmt.Println("║   A living digital organism that learns, thinks, sleeps,         ║")
	fmt.Println("║   feels, and evolves. Zero matrix multiplications.               ║")
	fmt.Println("║                                                                  ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════════╝")
	fmt.Println()
}

func phaseHeader(num int, emoji, title string) {
	fmt.Println()
	fmt.Println("┌──────────────────────────────────────────────────────────────────┐")
	fmt.Printf("│  %s  PHASE %d: %-50s │\n", emoji, num, title)
	fmt.Println("└──────────────────────────────────────────────────────────────────┘")
	fmt.Println()
}

func separator() {
	fmt.Println("  " + strings.Repeat("─", 62))
}

func subHeader(emoji, text string) {
	fmt.Printf("  %s %s\n", emoji, text)
}

func result(text string) {
	fmt.Printf("     ✓ %s\n", text)
}

func printResponse(label, input, response string) {
	fmt.Println()
	fmt.Printf("  💬 %s\n", label)
	fmt.Printf("     Input:    %q\n", input)
	fmt.Printf("     Response: %s\n", response)
	separator()
}

func printStats(s cortex.OrganismStats) {
	fmt.Println("  ┌─────────────────────────────────────────────────────────────┐")
	fmt.Println("  │                   ORGANISM MODULE STATS                     │")
	fmt.Println("  ├─────────────────────────────────────────────────────────────┤")
	fmt.Printf("  │  🧠 Hippocampus  — Memories stored : %-21d │\n", s.HippocampusMemories)
	fmt.Printf("  │  🗣  Broca        — Patterns known  : %-21d │\n", s.BrocaPatterns)
	fmt.Printf("  │  👂 Wernicke     — Parse rules      : %-21d │\n", s.WernickeRules)
	fmt.Printf("  │  🎯 Prefrontal   — Goals tracked    : %-21d │\n", s.PrefrontalGoals)
	fmt.Printf("  │  🔁 Cerebellum   — Cache entries    : %-21d │\n", s.CerebellumCached)
	fmt.Printf("  │  📊 Total weight — Synaptic mass    : %-21d │\n", s.TotalSynapticWeight)
	fmt.Println("  ├─────────────────────────────────────────────────────────────┤")
	fmt.Printf("  │  🔮 Prediction   — Error level      : %-21d │\n", s.PredictionError)
	fmt.Printf("  │  😲 Surprise     — Surprise level   : %-21d │\n", s.SurpriseLevel)
	fmt.Printf("  │  💚 Emotion      — Mood             : %-21s │\n", s.EmotionalMood)
	fmt.Printf("  │  📈 Valence      — Feeling          : %-21d │\n", s.Valence)
	fmt.Printf("  │  ⚡ Arousal      — Activation       : %-21d │\n", s.Arousal)
	fmt.Printf("  │  🔍 Curiosity    — Curiosity level  : %-21d │\n", s.CuriosityLevel)
	fmt.Printf("  │  🧭 Exploration  — Exploration rate : %-21d │\n", s.ExplorationRate)
	fmt.Printf("  │  🪞 Self         — Accuracy         : %-21d │\n", s.SelfAccuracy)
	fmt.Printf("  │  🧬 ThousandBrn  — Disagreement     : %-21d │\n", s.ThousandBrainsDisagreement)
	fmt.Printf("  │  🏆 Reward       — Drive            : %-21d │\n", s.RewardDrive)
	fmt.Println("  └─────────────────────────────────────────────────────────────┘")
}

// ═══════════════════════════════════════════════════════════════════════
// main — the full Organism demo
// ═══════════════════════════════════════════════════════════════════════

func main() {
	// ── CLI flags ───────────────────────────────────────────────────
	// -config permite încărcarea unui JSON cu suprascrieri peste
	// DefaultConfig. Vezi cortex/config_loader.go pentru precedență
	// (flag > ILARIA_CONFIG env > ilaria.json / config.json).
	configPath := flag.String("config", "", "Path to JSON config file (overrides DefaultConfig)")
	dataDir := flag.String("data-dir", "", "Path to organism data directory (overrides config)")
	interactive := flag.Bool("i", false, "Enter interactive mode after demo")
	fresh := flag.Bool("fresh", false, "Start with a new organism (ignore saved state)")
	noSave := flag.Bool("no-save", false, "Don't auto-save after demo")
	seed := flag.Int64("seed", 0, "Random seed (only explicit flags override config)")
	demo := flag.Bool("demo", true, "Run learning and interaction demo phases")
	demoFile := flag.String("demo-file", "./data/demo/default.json", "Path to external demo scenario JSON")
	flag.Parse()

	banner()

	// Build unified config from flags and defaults.
	// Ordinea de precedență: flags CLI > JSON config > DefaultConfig.
	cfg, configSource, err := cortex.MustLoadConfigWithDefaults(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
	if configSource != "" {
		fmt.Printf("  📋 Config loaded from: %s\n", configSource)
	}
	if err := cortex.ApplyConfigFlags(&cfg, flag.CommandLine, map[string]func(){
		"data-dir": func() { cfg.DataDir = *dataDir },
		"fresh":    func() { cfg.Fresh = *fresh },
		"no-save":  func() { cfg.NoSave = *noSave },
		"seed":     func() { cfg.Seed = *seed },
		"demo":     func() { cfg.Demo = *demo },
	}); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: invalid merged config: %v\n", err)
		os.Exit(1)
	}

	// Deterministic RNG for reproducible results.
	rng := rand.New(rand.NewSource(cfg.Seed))

	// ── Create or restore the Organism ──────────────────────────────
	fmt.Printf("  🔬 Initializing Organism (data dir: %s)...\n", cfg.DataDir)
	org, err := cortex.OpenOrganism(cfg, rng)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("  ✅ Organism is alive.")
	fmt.Println()

	var learningSentences []string
	var interactions []demoQuery
	var postSleepQueries []demoQuery
	sleepCycles := 0

	if cfg.Demo {
		spec, err := loadDemoSpec(*demoFile)
		if err != nil {
			fmt.Printf("  Demo load failed: %v\n", err)
			os.Exit(1)
		}
		learningSentences = spec.LearningSentences
		interactions = spec.Interactions
		postSleepQueries = spec.PostSleepQueries

		// ══════════════════════════════════════════════════════════════════
		// PHASE 1: LEARNING
		// ══════════════════════════════════════════════════════════════════
		phaseHeader(1, "📚", "LEARNING — Feeding knowledge to the organism")

		for i, sentence := range learningSentences {
			org.Learn(sentence)
			lang := "🇷🇴"
			if i >= 5 {
				lang = "🇬🇧"
			}
			fmt.Printf("  %s  [%2d/%2d] Learned: %q\n", lang, i+1, len(learningSentences), sentence)
		}

		fmt.Println()
		result(fmt.Sprintf("Fed %d sentences to all brain modules.", len(learningSentences)))
		statsBefore := org.Stats()
		result(fmt.Sprintf("Hippocampus now holds %d memories.", statsBefore.HippocampusMemories))
		result(fmt.Sprintf("Broca has %d language patterns.", statsBefore.BrocaPatterns))

		// ══════════════════════════════════════════════════════════════════
		// PHASE 2: INTERACTION
		// ══════════════════════════════════════════════════════════════════
		phaseHeader(2, "💡", "INTERACTION — Testing the organism's responses")

		for _, q := range interactions {
			response := org.Process(q.Input)
			printResponse(q.Label, q.Input, response)
		}

		statsAfterInteraction := org.Stats()
		fmt.Println()
		result(fmt.Sprintf("Cerebellum cache now has %d entries.", statsAfterInteraction.CerebellumCached))

		// ══════════════════════════════════════════════════════════════════
		// PHASE 3: SLEEP CYCLE
		// ══════════════════════════════════════════════════════════════════
		phaseHeader(3, "🌙", "SLEEP — Memory consolidation cycle")

		subHeader("📊", "Pre-sleep stats:")
		preSleep := org.Stats()
		printStats(preSleep)

		fmt.Println()
		subHeader("💤", "Organism entering sleep cycle...")
		fmt.Println("     ... consolidating memories ...")
		fmt.Println("     ... pruning weak synapses ...")
		fmt.Println("     ... strengthening important connections ...")
		org.Sleep()
		sleepCycles = 1
		fmt.Println("     ... 💫 Sleep cycle complete!")
		fmt.Println()

		subHeader("📊", "Post-sleep stats:")
		postSleep := org.Stats()
		printStats(postSleep)

		// Show delta.
		fmt.Println()
		memDelta := postSleep.HippocampusMemories - preSleep.HippocampusMemories
		synDelta := postSleep.TotalSynapticWeight - preSleep.TotalSynapticWeight
		fmt.Printf("  📈 Sleep delta → memories: %+d | synaptic weight: %+d\n", memDelta, synDelta)

		// ══════════════════════════════════════════════════════════════════
		// PHASE 4: POST-SLEEP INTERACTION
		// ══════════════════════════════════════════════════════════════════
		phaseHeader(4, "🌅", "POST-SLEEP — Testing improved responses")

		for _, q := range postSleepQueries {
			response := org.Process(q.Input)
			printResponse(q.Label, q.Input, response)
		}

		result("Post-sleep responses generated. Memories should be sharper after consolidation.")
	} else {
		fmt.Println("  ⏭  Demo phases bypassed (--demo=false)")
	}

	// ══════════════════════════════════════════════════════════════════
	// PHASE 5: FINAL STATS
	// ══════════════════════════════════════════════════════════════════
	phaseHeader(5, "📊", "ORGANISM STATS — Full system overview")

	finalStats := org.Stats()
	printStats(finalStats)

	// ══════════════════════════════════════════════════════════════════
	// PHASE 6: CONSCIOUSNESS REPORT
	// ══════════════════════════════════════════════════════════════════
	phaseHeader(6, "🔮", "CONSCIOUSNESS REPORT — Prediction & Awareness")

	subHeader("🔮", "Prediction Engine:")
	result(fmt.Sprintf("Prediction error   : %d / 255", finalStats.PredictionError))
	result(fmt.Sprintf("Surprise level     : %d / 255", finalStats.SurpriseLevel))
	separator()

	subHeader("🌐", "Global Workspace (Consciousness):")
	focusActive := org.Workspace.CurrentFocus.ActiveCount
	if focusActive > 0 {
		result(fmt.Sprintf("Workspace has focus — %d active bits in conscious pattern", focusActive))
	} else {
		result("Workspace has no focus — no pattern currently in consciousness")
	}
	result(fmt.Sprintf("Broadcast queue size : %d / %d", len(org.Workspace.BroadcastQueue), org.Workspace.MaxQueueSize))
	separator()

	subHeader("🧬", "Thousand Brains (Ensemble Consensus):")
	tbStats := org.ThousandBrains.Stats()
	result(fmt.Sprintf("Cortical columns     : %d", tbStats.ColumnCount))
	result(fmt.Sprintf("Avg column confidence: %d / 255", tbStats.AvgConfidence))
	result(fmt.Sprintf("Disagreement level   : %d/255 (0=agree, 255=disagree)", finalStats.ThousandBrainsDisagreement))

	// ══════════════════════════════════════════════════════════════════
	// PHASE 7: EMOTIONAL STATE
	// ══════════════════════════════════════════════════════════════════
	phaseHeader(7, "💚", "EMOTIONAL STATE — Emergent feeling")

	subHeader("🎭", "Current Mood:")
	result(fmt.Sprintf("Mood     : %s", finalStats.EmotionalMood))
	result(fmt.Sprintf("Valence  : %s", valenceBar(finalStats.Valence)))
	result(fmt.Sprintf("Arousal  : %d / 255", finalStats.Arousal))
	result(fmt.Sprintf("Curiosity: %d / 255", finalStats.CuriosityLevel))
	separator()

	subHeader("🌊", "Flow State:")
	result(fmt.Sprintf("In flow  : %s", flowEmoji(finalStats.IsInFlow)))
	separator()

	subHeader("🏆", "Reward System:")
	result(fmt.Sprintf("Reward drive: %d (pos=seek, neg=avoid)", finalStats.RewardDrive))

	// ══════════════════════════════════════════════════════════════════
	// PHASE 8: SELF-AWARENESS
	// ══════════════════════════════════════════════════════════════════
	phaseHeader(8, "🪞", "SELF-AWARENESS — Meta-cognition")

	subHeader("🪞", "Self-Model:")
	result(fmt.Sprintf("Self accuracy       : %d / 255", finalStats.SelfAccuracy))
	separator()

	subHeader("🧭", "Exploration:")
	result(fmt.Sprintf("Exploration rate    : %d / 255", finalStats.ExplorationRate))
	if org.Curiosity.ShouldExplore() {
		result("→ The organism WANTS to explore (rate > 128)")
	} else {
		result("→ The organism prefers exploitation (rate ≤ 128)")
	}
	separator()

	subHeader("💪", "Strong Topics (competence > 200):")
	result(topicList(org.Self.StrongTopics()))

	subHeader("😰", "Weak Topics (competence < 30):")
	result(topicList(org.Self.WeakTopics()))

	// ── Final summary ────────────────────────────────────────────────
	fmt.Println()
	fmt.Println("╔══════════════════════════════════════════════════════════════════╗")
	fmt.Println("║                       FINAL SUMMARY                             ║")
	fmt.Println("╠══════════════════════════════════════════════════════════════════╣")
	fmt.Println("║                                                                  ║")
	fmt.Printf("║   📚 Sentences learned         : %-30d  ║\n", len(learningSentences))
	fmt.Printf("║   💬 Interactions processed     : %-30d  ║\n", len(interactions)+len(postSleepQueries))
	fmt.Printf("║   🌙 Sleep cycles completed     : %-30d  ║\n", sleepCycles)
	fmt.Printf("║   🧠 Hippocampus memories       : %-30d  ║\n", finalStats.HippocampusMemories)
	fmt.Printf("║   🗣  Broca patterns             : %-30d  ║\n", finalStats.BrocaPatterns)
	fmt.Printf("║   👂 Wernicke rules              : %-30d  ║\n", finalStats.WernickeRules)
	fmt.Printf("║   🎯 Prefrontal goals            : %-30d  ║\n", finalStats.PrefrontalGoals)
	fmt.Printf("║   🔁 Cerebellum cached           : %-30d  ║\n", finalStats.CerebellumCached)
	fmt.Printf("║   📊 Total synaptic weight       : %-30d  ║\n", finalStats.TotalSynapticWeight)
	fmt.Println("║                                                                  ║")
	fmt.Println("║   ─── New Module Stats ───────────────────────────────────────   ║")
	fmt.Printf("║   🔮 Prediction error            : %-30d  ║\n", finalStats.PredictionError)
	fmt.Printf("║   😲 Surprise level              : %-30d  ║\n", finalStats.SurpriseLevel)
	fmt.Printf("║   💚 Emotional mood              : %-30s  ║\n", finalStats.EmotionalMood)
	fmt.Printf("║   📈 Valence                     : %-30d  ║\n", finalStats.Valence)
	fmt.Printf("║   ⚡ Arousal                     : %-30d  ║\n", finalStats.Arousal)
	fmt.Printf("║   🔍 Curiosity level             : %-30d  ║\n", finalStats.CuriosityLevel)
	fmt.Printf("║   🧭 Exploration rate            : %-30d  ║\n", finalStats.ExplorationRate)
	fmt.Printf("║   🪞 Self accuracy               : %-30d  ║\n", finalStats.SelfAccuracy)
	fmt.Printf("║   🧬 1000-Brains disagreement    : %-30d  ║\n", finalStats.ThousandBrainsDisagreement)
	fmt.Printf("║   🏆 Reward drive                : %-30d  ║\n", finalStats.RewardDrive)
	fmt.Printf("║   🌊 In flow                     : %-30v  ║\n", finalStats.IsInFlow)
	fmt.Println("║                                                                  ║")
	fmt.Println("║   ✅ Core pipeline operational (learn → think → respond).       ║")
	fmt.Println("║   🧠 ILARIA v0.4 — The organism is alive and learning.   ║")
	fmt.Println("║                                                                  ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════════╝")
	fmt.Println()

	// ── Auto-save ───────────────────────────────────────────────────
	if !cfg.NoSave {
		if err := org.Save(cfg.DataDir); err != nil {
			fmt.Printf("  ⚠️  Save failed: %v\n", err)
		} else {
			fmt.Printf("  💾 Organism saved to %s\n", cfg.DataDir)
		}
	} else {
		fmt.Println("  ⏭  Auto-save skipped (--no-save)")
	}

	// Enter interactive mode if requested.
	if *interactive {
		runInteractive(org)
	}
}
