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
	if *interval < 1 || int64(*interval) > int64((1<<63-1)/time.Second) || *gapsPerCycle < 1 {
		fmt.Fprintln(os.Stderr, "interval and gaps must be positive; interval must fit time.Duration")
		os.Exit(1)
	}

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
	org, err := cortex.OpenOrganism(cfg, rng)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Cannot open organism: %v\n", err)
		os.Exit(1)
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
		fmt.Fprintf(os.Stderr, "Final save failed: %v\n", err)
		os.Exit(1)
	} else {
		fmt.Println("💾 Final save complete. Goodbye! 🧠")
	}
	fmt.Println()
	fmt.Println(learner.Stats())
}
