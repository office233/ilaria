package main

import (
	"context"
	"flag"
	"fmt"
	"math/rand"
	"os"
	"os/signal"
	"syscall"
	"time"

	"ilaria/cortex"
)

func main() {
	dataDir := flag.String("data-dir", "./data/cortex", "Path to organism data directory")
	interval := flag.Int("interval", 30, "Seconds between learning cycles")
	gapsPerCycle := flag.Int("gaps", 3, "Max knowledge gaps to address per cycle")
	seed := flag.Int64("seed", 42, "Random seed")
	flag.Parse()

	fmt.Println()
	fmt.Println("╔══════════════════════════════════════════════════════════════════╗")
	fmt.Println("║                                                                  ║")
	fmt.Println("║  🧠  ILARIA AUTONOMOUS SELF-LEARNING ENGINE               ║")
	fmt.Println("║                                                                  ║")
	fmt.Println("║  The AI that teaches ITSELF. No LLM can do this.                ║")
	fmt.Println("║                                                                  ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════════╝")
	fmt.Println()

	cfg := cortex.DefaultConfig()
	cfg.DataDir = *dataDir
	cfg.Seed = *seed
	cfg.NoSave = false

	rng := rand.New(rand.NewSource(cfg.Seed))

	// Load or create organism
	var org *cortex.Organism
	var err error
	org, err = cortex.LoadOrganism(cfg, rng)
	if org == nil {
		if err != nil {
			fmt.Printf("⚠️  Load failed (%v), creating fresh organism...\n", err)
		} else {
			fmt.Println("🌱 Starting fresh organism...")
		}
		org = cortex.NewOrganism(cfg, rng)
	} else {
		fmt.Printf("✅ Loaded organism (Vocab: %d, Hippocampus: %d memories)\n",
			org.Vocab.Size(), org.Hippocampus.Size())
	}

	// Create autonomous learner
	learner := cortex.NewAutonomousLearner(org)
	learner.LearnInterval = time.Duration(*interval) * time.Second
	learner.MaxGapsPerCycle = *gapsPerCycle

	fmt.Printf("🔧 Config: interval=%ds, gaps/cycle=%d, languages=%v\n",
		*interval, *gapsPerCycle, learner.SearchLangs)
	fmt.Println()
	fmt.Println("Press Ctrl+C to stop. The organism saves automatically.")
	fmt.Println()

	// Handle graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Println("\n\n🛑 Stopping... saving organism...")
		cancel()
	}()

	// Run the autonomous learning loop
	learner.Run(ctx, func(msg string) {
		fmt.Println(msg)
	})

	// Final save
	if err := org.Save(cfg.DataDir); err != nil {
		fmt.Printf("⚠️  Final save failed: %v\n", err)
	} else {
		fmt.Println("💾 Final save complete. Goodbye! 🧠")
	}
	fmt.Println()
	fmt.Println(learner.Stats())
}
