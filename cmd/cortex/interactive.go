package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"nexus-cortex/cortex"
)

// runInteractive starts an interactive REPL session with the organism.
// The user types text, the organism responds. Special /commands are
// available for introspection and control.
func runInteractive(org *cortex.Organism) {
	fmt.Println()
	fmt.Println("═══ NEXUS CORTEX — Interactive Mode ═══")
	fmt.Println("Type anything to interact. Commands:")
	fmt.Println("  /stats  — show organism stats")
	fmt.Println("  /sleep  — trigger sleep cycle")
	fmt.Println("  /mood   — show emotional state")
	fmt.Println("  /self   — show self-model")
	fmt.Println("  /learn <text>  — teach the organism")
	fmt.Println("  /save   — save organism to disk")
	fmt.Println("  /quit   — exit")

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 64*1024) // Handle long input
	fmt.Print("\n🧠 > ")
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())

		switch {
		case line == "":
			// Skip empty lines.

		case line == "/quit" || line == "/exit":
			fmt.Println("\n👋 Goodbye — the organism rests.")
			return

		case line == "/stats":
			interactiveStats(org)

		case line == "/sleep":
			interactiveSleep(org)

		case line == "/mood":
			interactiveMood(org)

		case line == "/self":
			interactiveSelf(org)

		case strings.HasPrefix(line, "/learn "):
			text := strings.TrimSpace(line[len("/learn "):])
			if text == "" {
				fmt.Println("⚠️  Usage: /learn <text>")
			} else {
				org.Learn(text)
				fmt.Printf("📚 Learned: %q\n", text)
			}

		case line == "/save":
			if err := org.Save(org.Config.DataDir); err != nil {
				fmt.Printf("❌ Save failed: %v\n", err)
			} else {
				fmt.Printf("💾 Organism saved to %s\n", org.Config.DataDir)
			}

		default:
			response := org.Process(line)
			if response == "" {
				response = "(no response)"
			}
			s := org.Stats()
			prov := org.LastProvenance()
			fmt.Printf("💬 Response: %s\n", response)
			fmt.Printf("   [provenance] source=%s tool=%s recalled=%d\n",
				prov.Source, prov.Tool, prov.Recalled)
			fmt.Printf("   Mood: %s | Surprise: %d/255 | Confidence: %d/255\n",
				s.EmotionalMood, s.SurpriseLevel, org.Self.AvgConfidence)
		}

		fmt.Print("\n🧠 > ")
	}

	// Scanner ended (EOF / pipe closed).
	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "\n⚠️  Input error: %v\n", err)
	}
	fmt.Println("\n👋 Goodbye — the organism rests.")
}

// interactiveStats prints a compact summary of key organism stats.
func interactiveStats(org *cortex.Organism) {
	s := org.Stats()
	fmt.Println("📊 Organism Stats")
	fmt.Printf("   Interactions   : %d\n", s.InteractionCount)
	fmt.Printf("   Memories       : %d / %d\n", s.HippocampusMemories, s.HippocampusMaxMemories)
	fmt.Printf("   Vocab size     : %d\n", s.VocabSize)
	fmt.Printf("   Brain synapses : %d (active: %d)\n", s.BrainSynapses, s.BrainActiveSynapses)
	fmt.Printf("   Broca patterns : %d\n", s.BrocaPatterns)
	fmt.Printf("   Wernicke rules : %d\n", s.WernickeRules)
	fmt.Printf("   Cache entries  : %d\n", s.CerebellumCached)
	fmt.Printf("   Synaptic mass  : %d\n", s.TotalSynapticWeight)
}

// interactiveSleep triggers a sleep cycle and shows before/after deltas.
func interactiveSleep(org *cortex.Organism) {
	before := org.Stats()
	fmt.Println("💤 Entering sleep cycle...")
	org.Sleep()
	after := org.Stats()

	memDelta := after.HippocampusMemories - before.HippocampusMemories
	synDelta := after.TotalSynapticWeight - before.TotalSynapticWeight

	fmt.Println("✅ Sleep cycle complete.")
	fmt.Printf("   Memories : %d → %d (%+d)\n", before.HippocampusMemories, after.HippocampusMemories, memDelta)
	fmt.Printf("   Synaptic : %d → %d (%+d)\n", before.TotalSynapticWeight, after.TotalSynapticWeight, synDelta)
	fmt.Printf("   Cache    : %d → %d\n", before.CerebellumCached, after.CerebellumCached)
}

// interactiveMood displays the organism's current emotional state.
func interactiveMood(org *cortex.Organism) {
	mood := org.Emotion.GetMood()
	state := org.Emotion.GetState()
	fmt.Println("🎭 Emotional State")
	fmt.Printf("   Mood       : %s\n", mood)
	fmt.Printf("   Valence    : %d  (-128..+127)\n", state.Valence)
	fmt.Printf("   Arousal    : %d / 255\n", state.Arousal)
	fmt.Printf("   Curiosity  : %d / 255\n", state.Curiosity)
	fmt.Printf("   Confidence : %d / 255\n", state.Confidence)
	fmt.Printf("   Social     : %d / 255\n", state.Social)
}

// interactiveSelf displays the organism's self-model and metacognition.
func interactiveSelf(org *cortex.Organism) {
	accuracy := org.Self.GetAccuracy()
	strong := org.Self.StrongTopics()
	weak := org.Self.WeakTopics()

	fmt.Println("🪞 Self-Model")
	fmt.Printf("   Accuracy      : %d / 255\n", accuracy)
	fmt.Printf("   Strong topics : %s\n", formatTopics(strong))
	fmt.Printf("   Weak topics   : %s\n", formatTopics(weak))
}

// formatTopics joins topic names for display, or returns "(none)".
func formatTopics(topics []string) string {
	if len(topics) == 0 {
		return "(none)"
	}
	return strings.Join(topics, ", ")
}
