package main

import (
	"flag"
	"fmt"
	"math/rand"
	"os"
	"strings"
	"time"

	"nexus-cortex/cortex"
)

func main() {
	dataDir := flag.String("data-dir", "./data/cortex", "Path to organism data directory")
	corpusPath := flag.String("corpus", "./data/corpus/general.jsonl", "Path to the training corpus file (.jsonl)")
	epochs := flag.Int("epochs", 15, "Number of curriculum epochs to train")
	fresh := flag.Bool("fresh", false, "Start with a new organism (overwrite existing saved state)")
	useCurriculum := flag.Bool("curriculum", true, "Sort training items from simple to complex")
	useRevisit := flag.Bool("revisit", true, "Enable dynamic surprise-based spaced repetition")
	revisitThreshold := flag.Int("revisit-threshold", 50, "Prediction error threshold for dynamic surprise spaced repetition")
	seed := flag.Int64("seed", 42, "Seed for deterministic random processes")
	flag.Parse()

	// 1. Initialize aesthetics
	fmt.Println()
	fmt.Println("╔══════════════════════════════════════════════════════════════════╗")
	fmt.Println("║                                                                  ║")
	fmt.Println("║  🧠  NEXUS CORTEX COGNITIVE TRAINER & CURRICULUM SCHEDULER       ║")
	fmt.Println("║                                                                  ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════════╝")
	fmt.Println()

	cfg := cortex.DefaultConfig()
	cfg.DataDir = *dataDir
	cfg.Fresh = *fresh
	cfg.Seed = *seed
	cfg.Demo = false
	cfg.NoSave = false // We WANT to persist training results!

	rng := rand.New(rand.NewSource(cfg.Seed))

	var org *cortex.Organism
	var err error
	if !cfg.Fresh {
		org, err = cortex.LoadOrganism(cfg, rng)
	}
	if org == nil {
		if err != nil {
			fmt.Printf("⚠️  No saved organism found or load failed (%v), creating a fresh one...\n", err)
		} else {
			fmt.Println("🌱 Starting with a fresh, empty organism...")
		}
		org = cortex.NewOrganism(cfg, rng)
	} else {
		fmt.Printf("✅ Successfully loaded persisted organism state (Vocab: %d words, Hippocampus: %d memories).\n", org.Vocab.Size(), org.Hippocampus.Size())
	}

	// 2. Load and parse the corpus
	fmt.Printf("📂 Loading training corpus from %s...\n", *corpusPath)
	file, err := os.Open(*corpusPath)
	if err != nil {
		fmt.Printf("❌ Failed to open corpus file: %v\n", err)
		os.Exit(1)
	}
	defer file.Close()

	items, err := cortex.ParseCorpusStream(file)
	if err != nil {
		fmt.Printf("❌ Failed to parse corpus: %v\n", err)
		os.Exit(1)
	}

	if len(items) == 0 {
		fmt.Println("⚠️  The loaded corpus is empty. Nothing to train.")
		os.Exit(0)
	}

	fmt.Printf("📊 Successfully loaded %d corpus items.\n", len(items))

	// 3. Build Curriculum
	curr := cortex.NewCurriculum(items)
	if *useCurriculum {
		fmt.Println("🪜 Applying curriculum learning: sorting items from simple to complex...")
		curr.SortByComplexity()
	} else {
		fmt.Println("⚠️  Curriculum sorting disabled. Processing items in original order.")
	}

	startVocabSize := org.Vocab.Size()
	startTime := time.Now()

	// 4. Pre-training Epochs Loop
	for epoch := 1; epoch <= *epochs; epoch++ {
		fmt.Printf("\n🏁 Epoch %d/%d starting...\n", epoch, *epochs)

		epochStartTime := time.Now()
		var totalTokens int
		var sumError uint64
		var errorCount int

		// We will keep track of errors per index to generate the revisit queue later
		errorsMap := make(map[int]uint8)

		// Regular training pass
		for idx, item := range curr.Items {
			// Token calculation for speed telemetry
			fullText := item.GetFullText()
			tokens := cortex.Tokenize(fullText)
			totalTokens += len(tokens)

			// Perform training on item and collect prediction error (surprise)
			predictionError := trainItem(org, item)
			sumError += uint64(predictionError)
			errorCount++
			errorsMap[idx] = predictionError

			// Calculate telemetry rates
			elapsed := time.Since(epochStartTime).Seconds()
			tokensPerSec := 0.0
			if elapsed > 0 {
				tokensPerSec = float64(totalTokens) / elapsed
			}

			// Get current stats
			stats := org.Stats()

			// Print clean real-time telemetry (overwrite line carriage)
			fmt.Printf("\r⏳ Tr: %3d/%3d | Tok/s: %6.1f | Err: %3d | Vocab: %5d (+%-3d) | Syn: %6d",
				idx+1, len(curr.Items), tokensPerSec, predictionError,
				stats.VocabSize, stats.VocabSize-startVocabSize, stats.BrainActiveSynapses)
		}
		fmt.Println()

		// 5. Spaced Repetition (Dynamic Surprise Revisit Pass)
		if *useRevisit {
			// Threshold is set to 50 prediction error (meaning anything surprising is trained again)
			revisitItems := curr.GenerateRevisitBatch(errorsMap, uint8(*revisitThreshold))
			if len(revisitItems) > 0 {
				fmt.Printf("🔄 Spaced Repetition: Re-evaluating %d items that triggered high surprise (error >= %d)...\n", len(revisitItems), *revisitThreshold)
				var revisitTokens int
				revisitStartTime := time.Now()

				for rIdx, item := range revisitItems {
					rTokens := cortex.Tokenize(item.GetFullText())
					revisitTokens += len(rTokens)

					// Re-train to consolidate the memory
					predictionError := trainItem(org, item)

					elapsed := time.Since(revisitStartTime).Seconds()
					tokensPerSec := 0.0
					if elapsed > 0 {
						tokensPerSec = float64(revisitTokens) / elapsed
					}

					stats := org.Stats()

					fmt.Printf("\r   ⏳ Rev: %2d/%2d | Tok/s: %6.1f | Err: %3d | Vocab: %5d (+%-3d) | Syn: %6d",
						rIdx+1, len(revisitItems), tokensPerSec, predictionError,
						stats.VocabSize, stats.VocabSize-startVocabSize, stats.BrainActiveSynapses)
				}
				fmt.Println()
			}
		}

		// Perform consolidation (biological sleep equivalent) at the end of every epoch
		// to decay weak memories, stabilize LTP traces, and prevent hippocampal memory saturation.
		org.Sleep()

		epochElapsed := time.Since(epochStartTime)
		avgError := 0
		if errorCount > 0 {
			avgError = int(sumError / uint64(errorCount))
		}
		fmt.Printf("✨ Epoch %d completed in %s. Avg Prediction Surprise: %d.\n", epoch, epochElapsed.Round(time.Millisecond), avgError)
	}

	// 5. Save the trained organism
	fmt.Println("\n💾 Consolidating synaptic changes and saving organism to disk...")
	if err := org.Save(*dataDir); err != nil {
		fmt.Printf("❌ Failed to save trained organism: %v\n", err)
		os.Exit(1)
	}

	stats := org.Stats()
	totalElapsed := time.Since(startTime)
	fmt.Println("\n🎉 TRAINING SUCCESSFUL!")
	fmt.Println(strings.Repeat("━", 68))
	fmt.Printf("⏱️  Total time:         %s\n", totalElapsed.Round(time.Second))
	fmt.Printf("📖 Vocabulary Size:    %d (+%d words)\n", stats.VocabSize, stats.VocabSize-startVocabSize)
	fmt.Printf("🧠 Active Synapses:    %d\n", stats.BrainActiveSynapses)
	fmt.Printf("💾 Episodic Memories:  %d stored\n", stats.HippocampusMemories)
	fmt.Println(strings.Repeat("━", 68))
	fmt.Println()
}

// trainItem teaches the organism one corpus item and returns the prediction
// error (0 = perfectly anticipated, 255 = no overlap at all).
//
// ORDER MATTERS. Predictor.Update compares reality against whatever
// Predictor.Predict last stored in LastPrediction. If nobody calls Predict
// first, LastPrediction is empty, overlap is always 0, and Update returns a
// constant 255 — a saturated signal that looks like "learned nothing" but
// actually means "never measured". That also pins every item above the
// spaced-repetition threshold, so each epoch re-runs the whole corpus.
//
// So: predict from the CONTEXT (the prompt), then learn, then score the
// prediction against the ACTUAL continuation (the response).
func trainItem(o *cortex.Organism, item cortex.CorpusItem) uint8 {
	if item.Text != "" {
		// Passive sequential learning
		sdr := o.Encoder.EncodeSentence(item.Text)

		// Anticipate this sentence from the running context before we
		// consume it, so the error below reflects real expectation.
		o.Predictor.Predict(o.Predictor.LastReality)

		o.Learn(item.Text)

		err := o.Predictor.Update(sdr)
		// Set up the expectation carried into the next item.
		o.Predictor.Predict(sdr)
		return err
	}

	// Active Q&A learning
	qSDR := o.Encoder.EncodeSentence(item.Instruction)
	respSDR := o.Encoder.EncodeSentence(item.Response)

	// Expect an answer given the question — this is the prediction the
	// error below actually judges.
	o.Predictor.Predict(qSDR)

	o.LearnQA(item.Instruction, item.Response)

	err := o.Predictor.Update(respSDR)
	o.Predictor.Predict(respSDR)
	return err
}
