package main

import (
	"flag"
	"fmt"
	"math/rand"

	"ilaria/cortex"
)

// cortex-diagnose: Traces a query through the ENTIRE pipeline
// to show exactly where information is lost.
func main() {
	dataDir := flag.String("data-dir", "./data/cortex", "Path to organism data")
	query := flag.String("q", "What is DNA?", "Query to diagnose")
	expected := flag.String("expected", "DNA is deoxyribonucleic acid that carries genetic information", "Expected answer text to measure SDR similarity against")
	flag.Parse()

	cfg := cortex.DefaultConfig()
	cfg.DataDir = *dataDir
	cfg.NoSave = true
	rng := rand.New(rand.NewSource(42))

	org, err := cortex.LoadOrganism(cfg, rng)
	if org == nil {
		fmt.Printf("❌ Could not load organism from %s: %v\n", *dataDir, err)
		return
	}

	fmt.Println("╔══════════════════════════════════════════════════════════════╗")
	fmt.Println("║  🔬 ILARIA PIPELINE DIAGNOSTIC                       ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════╝")
	fmt.Println()
	fmt.Printf("📝 Query: %q\n", *query)
	fmt.Printf("📊 Organism: Vocab=%d, Hippocampus=%d memories\n\n",
		org.Vocab.Size(), org.Hippocampus.Size())

	// ── STEP 1: TOKENIZE ─────────────────────────────────────
	tokens := cortex.Tokenize(*query)
	fmt.Printf("1️⃣  TOKENIZE: %v (%d tokens)\n", tokens, len(tokens))

	// ── STEP 2: ENCODE SDR ───────────────────────────────────
	sdr := org.Encoder.EncodeSentence(*query)
	fmt.Printf("2️⃣  ENCODE SDR: %d active bits / %d total (%.1f%% sparsity)\n",
		sdr.ActiveCount, sdr.Size, float64(sdr.ActiveCount)*100/float64(sdr.Size))

	// ── STEP 3: CEREBELLUM (cache) ───────────────────────────
	if cached, ok := org.Cerebellum.Lookup(sdr); ok {
		fmt.Printf("3️⃣  CEREBELLUM: ✅ HIT — conf=%d, text=%q\n", cached.Confidence, truncate(cached.Text, 100))
	} else {
		fmt.Printf("3️⃣  CEREBELLUM: ❌ MISS (no cached response)\n")
	}

	// ── STEP 4: HIPPOCAMPUS (episodic memory) ────────────────
	// Try with normal threshold
	if mem, sim, ok := org.Hippocampus.RecallScored(sdr, cfg.HippocampusRecallThresh); ok {
		fmt.Printf("4️⃣  HIPPOCAMPUS (thresh=%d): ✅ FOUND — similarity=%d/255 (%.1f%%)\n",
			cfg.HippocampusRecallThresh, sim, float64(sim)*100/255)
		fmt.Printf("     Context: %q\n", truncate(mem.Context, 120))
	} else {
		fmt.Printf("4️⃣  HIPPOCAMPUS (thresh=%d): ❌ NO MATCH\n", cfg.HippocampusRecallThresh)
	}

	// Try with zero threshold to see best available match
	if mem, sim, ok := org.Hippocampus.RecallScored(sdr, 0); ok {
		fmt.Printf("     Best match (thresh=0): similarity=%d/255 (%.1f%%), context=%q\n",
			sim, float64(sim)*100/255, truncate(mem.Context, 80))
	} else {
		fmt.Println("     Best match (thresh=0): ❌ NOTHING AT ALL")
	}

	// ── STEP 5: BRAIN GENERATE ───────────────────────────────
	brainGen := org.Brain.Generate(*query, 20)
	fmt.Printf("5️⃣  BRAIN GENERATE: %q\n", truncate(brainGen, 100))

	// ── STEP 6: PREFRONTAL (reasoning) ───────────────────────
	responseSDR := org.Prefrontal.ThinkDeep(sdr, cfg.PrefrontalMaxHops)
	prefConf := org.Prefrontal.GetConfidence()
	fmt.Printf("6️⃣  PREFRONTAL: confidence=%d/255 (threshold=%d)\n",
		prefConf, cfg.PrefrontalConfThreshold)
	if prefConf >= cfg.PrefrontalConfThreshold {
		fmt.Println("     → ✅ Above threshold!")
	} else {
		fmt.Println("     → ❌ BELOW THRESHOLD — response WILL BE BLANKED at line 337!")
		fmt.Println("     → This is the MAIN REASON for 0% self-test score!")
	}

	// ── STEP 7: BROCA (text generation from SDR) ─────────────
	brocaText := org.Broca.Generate(responseSDR, cfg.MaxGenWords)
	fmt.Printf("7️⃣  BROCA GENERATE: %q\n", truncate(brocaText, 100))

	// ── STEP 8: FULL Process() ───────────────────────────────
	response := org.Process(*query)
	fmt.Printf("8️⃣  FULL Process(): %q\n", truncate(response, 200))

	// ── DIAGNOSTIC SUMMARY ───────────────────────────────────
	fmt.Println()
	fmt.Println("═══════════════════════════════════════════════════════════════")
	fmt.Println("📋 DIAGNOSTIC SUMMARY:")
	fmt.Println()

	issues := 0

	if prefConf < cfg.PrefrontalConfThreshold {
		issues++
		fmt.Printf("   🔴 KILLER #1: Prefrontal confidence %d < threshold %d\n",
			prefConf, cfg.PrefrontalConfThreshold)
		fmt.Println("      → Line 337-339 in organism.go BLANKS the response!")
		fmt.Println("      → FIX: Lower PrefrontalConfThreshold OR improve Prefrontal network")
		fmt.Println()
	}

	if response == cortex.NoConfidentResponse {
		issues++
		fmt.Println("   🔴 KILLER #2: Final response is empty!")
		fmt.Println("      → Even if Hippocampus found something, it was killed by confidence gate")
		fmt.Println()
	}

	// Test SDR similarity between question and stored answer
	queryIsDefault := *query == "What is DNA?"
	expectedIsDefault := *expected == "DNA is deoxyribonucleic acid that carries genetic information"

	if queryIsDefault || !expectedIsDefault {
		testAnswer := *expected
		answerSDR := org.Encoder.EncodeSentence(testAnswer)
		overlapCount := sdr.Overlap(answerSDR)
		simScore := sdr.Similarity(answerSDR)
		simPercent := float64(simScore) * 100 / 255
		fmt.Printf("   📐 SDR SIMILARITY TEST:\n")
		fmt.Printf("      Target Answer: %q\n", truncate(testAnswer, 60))
		fmt.Printf("      Query SDR:     %d active bits\n", sdr.ActiveCount)
		fmt.Printf("      Answer SDR:    %d active bits\n", answerSDR.ActiveCount)
		fmt.Printf("      Overlap:       %d bits (similarity=%d/255 = %.1f%%)\n", overlapCount, simScore, simPercent)
		if simPercent < 10 {
			issues++
			fmt.Println("      🔴 VERY LOW similarity — encoder produces unrelated SDRs!")
		} else if simPercent < 30 {
			fmt.Println("      🟡 Low similarity — may cause retrieval issues")
		} else {
			fmt.Println("      ✅ Reasonable similarity")
		}
	} else {
		fmt.Printf("   📐 SDR SIMILARITY TEST: Skipped. (Pass --expected to compare query SDR against a target answer)\n")
	}

	fmt.Println()
	if issues > 0 {
		fmt.Printf("   Found %d issue(s). Fix the 🔴 items first.\n", issues)
	} else {
		fmt.Println("   ✅ No major issues detected!")
	}
}

func truncate(s string, maxLen int) string {
	if len(s) > maxLen {
		return s[:maxLen] + "..."
	}
	return s
}
