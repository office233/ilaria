package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"ilaria/cortex"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// QAPair represents a question-answer training pair loaded from JSON.
type QAPair struct {
	Q string `json:"q"`
	A string `json:"a"`
}

// loadQA reads Q&A pairs from a JSON file.
func loadQA(path string) ([]QAPair, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var pairs []QAPair
	if err := json.Unmarshal(data, &pairs); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return pairs, nil
}

// loadTexts reads plain text lines from a file (one text per line).
func loadTexts(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	var texts []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB lines
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" && !strings.HasPrefix(line, "#") {
			texts = append(texts, line)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan %s: %w", path, err)
	}
	return texts, nil
}

func main() {
	// CLI flags
	configPath := flag.String("config", "", "Path to JSON config file (overrides DefaultConfig)")
	dataDir := flag.String("data-dir", "", "Data directory (overrides config; default ./data/cortex-training)")
	radioEnabled := flag.Bool("radio-cortex-enabled", true, "Enable RadioCortex")
	neuroRadioEnabled := flag.Bool("neuro-radio-enabled", true, "Enable NeuroRadioCortex")
	qaEpochs := flag.Int("epochs", 3, "Number of Q&A training epochs")
	nrEpochs := flag.Int("nr-epochs", 5, "Number of NeuroRadio training epochs")
	flag.Parse()

	fmt.Println("╔══════════════════════════════════════════════════════════════╗")
	fmt.Println("║  🧠 ILARIA — Training Session                        ║")
	fmt.Println("║  External Data · CUDA GPU · Configurable Neurons            ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════╝")
	fmt.Println()

	cfg, configSource, err := cortex.MustLoadConfigWithDefaults(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Config error: %v\n", err)
		os.Exit(1)
	}
	if configSource != "" {
		fmt.Printf("  📋 Config loaded from: %s\n", configSource)
	}
	// Without a config file, retain this command's historical default path.
	// An explicit JSON path, including ./data/cortex, must not be rewritten.
	if configSource == "" {
		cfg.DataDir = "./data/cortex-training"
	}
	if err := cortex.ApplyConfigFlags(&cfg, flag.CommandLine, map[string]func(){
		"data-dir":             func() { cfg.DataDir = *dataDir },
		"radio-cortex-enabled": func() { cfg.RadioCortexEnabled = *radioEnabled },
		"neuro-radio-enabled":  func() { cfg.NeuroRadioEnabled = *neuroRadioEnabled },
	}); err != nil {
		fmt.Fprintf(os.Stderr, "Invalid merged config: %v\n", err)
		os.Exit(1)
	}
	if *qaEpochs < 1 || *nrEpochs < 1 {
		fmt.Fprintln(os.Stderr, "Training epochs must be positive")
		os.Exit(1)
	}
	rng := rand.New(rand.NewSource(cfg.Seed))

	// ══════════════════════════════════════════════════════════
	// LOAD EXTERNAL TRAINING DATA
	// ══════════════════════════════════════════════════════════
	trainingDataDir := cfg.TrainingDataDir

	qaPath := filepath.Join(trainingDataDir, "qa.json")
	textsPath := filepath.Join(trainingDataDir, "texts.txt")

	fmt.Printf("  📂 Loading data from: %s\n", trainingDataDir)

	qaCorpus, err := loadQA(qaPath)
	if err != nil {
		fmt.Printf("  ⚠️  No Q&A data: %v\n", err)
		qaCorpus = nil
	} else {
		fmt.Printf("  ✅ Loaded %d Q&A pairs from %s\n", len(qaCorpus), filepath.Base(qaPath))
	}

	textCorpus, err := loadTexts(textsPath)
	if err != nil {
		fmt.Printf("  ⚠️  No text data: %v\n", err)
		textCorpus = nil
	} else {
		fmt.Printf("  ✅ Loaded %d texts from %s\n", len(textCorpus), filepath.Base(textsPath))
	}

	if len(qaCorpus) == 0 && len(textCorpus) == 0 {
		fmt.Println("  ❌ No training data found! Create qa.json and/or texts.txt in", trainingDataDir)
		os.Exit(1)
	}
	fmt.Println()

	// ══════════════════════════════════════════════════════════
	// CREATE ORGANISM
	// ══════════════════════════════════════════════════════════
	fmt.Println("  🔬 Creating organism...")
	startTime := time.Now()
	org, err := cortex.OpenOrganism(cfg, rng)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Cannot open organism: %v\n", err)
		os.Exit(1)
	}
	if org.RadioCortex != nil {
		fmt.Printf("  ✅ Organism alive. RadioCortex: %d neurons (%.1f MB)\n",
			org.RadioCortex.Size, float64(org.RadioCortex.Size*4)/(1024*1024))
		// Try GPU
		if org.RadioCortex.InitGPU() {
			fmt.Println("  🚀 GPU CUDA acceleration: ENABLED")
		} else {
			fmt.Println("  💻 Using CPU (no CUDA DLL found)")
		}
	} else {
		fmt.Println("  ✅ Organism alive. RadioCortex: disabled")
	}
	fmt.Printf("  ⏱  Init time: %v\n\n", time.Since(startTime))

	// ══════════════════════════════════════════════════════════
	// PHASE 1: Text absorption
	// ══════════════════════════════════════════════════════════
	if len(textCorpus) > 0 {
		fmt.Println("┌──────────────────────────────────────────────────────────────┐")
		fmt.Printf("│  📚 PHASE 1: TEXT ABSORPTION (%d texts)                      │\n", len(textCorpus))
		fmt.Println("└──────────────────────────────────────────────────────────────┘")

		phase1Start := time.Now()
		for i, text := range textCorpus {
			org.Learn(text)

			// Feed co-occurrence data to SemanticFreqCodec
			if org.NeuroRadio != nil {
				// Tokenize into word IDs and observe co-occurrence
				words := strings.Fields(strings.ToLower(text))
				ids := make([]int, len(words))
				for w, word := range words {
					ids[w] = int(org.Vocab.GetOrCreate(word))
				}
				org.NeuroRadio.Codec.ObserveCooccurrence(ids)
			}

			if (i+1)%20 == 0 || i+1 == len(textCorpus) {
				fmt.Printf("  📝 Absorbed %d / %d texts\n", i+1, len(textCorpus))
			}
		}

		// Build semantic frequencies from co-occurrence
		if org.NeuroRadio != nil {
			org.NeuroRadio.Codec.AssignFrequencies()
			org.NeuroRadio.RebuildDecoder()
			nTok, nFreq, nCooc := org.NeuroRadio.Codec.Stats()
			fmt.Printf("  🎯 SemanticFreqCodec: %d tokens → %d frequencies (%d co-occurrences)\n",
				nTok, nFreq, nCooc)
		}

		fmt.Printf("  ✅ Absorbed %d texts in %v\n\n", len(textCorpus), time.Since(phase1Start))
	}

	// ══════════════════════════════════════════════════════════
	// PHASE 2: Q&A Training
	// ══════════════════════════════════════════════════════════
	if len(qaCorpus) > 0 {
		epochs := *qaEpochs
		fmt.Println("┌──────────────────────────────────────────────────────────────┐")
		fmt.Printf("│  🎓 PHASE 2: Q&A TRAINING (%d epochs × %d pairs)             │\n", epochs, len(qaCorpus))
		fmt.Println("└──────────────────────────────────────────────────────────────┘")

		phase2Start := time.Now()
		for epoch := 1; epoch <= epochs; epoch++ {
			epochStart := time.Now()
			fmt.Printf("\n  📖 Epoch %d/%d:\n", epoch, epochs)

			perm := rng.Perm(len(qaCorpus))
			for i, idx := range perm {
				qa := qaCorpus[idx]
				org.LearnQA(qa.Q, qa.A)
				if (i+1)%30 == 0 && org.RadioCortex != nil {
					stats := org.RadioCortex.Stats()
					fmt.Printf("     [%3d/%d] Radio ticks: %d | alive: %d | avg amp: %d\n",
						i+1, len(qaCorpus), stats.TickCount, stats.AliveNeurons, stats.AvgAmplitude)
				}
			}

			fmt.Printf("  💤 Sleep after epoch %d (took %v)...\n", epoch, time.Since(epochStart))
			logs := org.Sleep()
			for _, log := range logs {
				if strings.Contains(log, "Radio") || strings.Contains(log, "Neurogenesis") {
					fmt.Printf("     %s\n", log)
				}
			}
		}

		fmt.Printf("\n  ✅ Training complete in %v\n", time.Since(phase2Start))
		if org.RadioCortex != nil {
			radioStats := org.RadioCortex.Stats()
			fmt.Printf("     Radio ticks: %d | Alive: %d/%d | Avg amplitude: %d\n\n",
				radioStats.TickCount, radioStats.AliveNeurons, radioStats.TotalNeurons, radioStats.AvgAmplitude)
		}
	}

	// ══════════════════════════════════════════════════════════
	// PHASE 2.5: NeuroRadioCortex Training (unified architecture)
	// ══════════════════════════════════════════════════════════
	if org.NeuroRadio != nil && len(qaCorpus) > 0 {
		epochs := *nrEpochs
		fmt.Println("┌──────────────────────────────────────────────────────────────┐")
		fmt.Printf("│  ⚡ PHASE 2.5: NEURO-RADIO TRAINING (%d epochs × %d pairs)    │\n", epochs, len(qaCorpus))
		fmt.Println("│  TernaryTile weights + RadioMeta routing + Semantic Freqs    │")
		fmt.Println("└──────────────────────────────────────────────────────────────┘")

		nrStart := time.Now()
		for epoch := 1; epoch <= epochs; epoch++ {
			epochStart := time.Now()
			fmt.Printf("\n  ⚡ NR Epoch %d/%d:\n", epoch, epochs)

			totalMatches := 0
			perm := rng.Perm(len(qaCorpus))
			for i, idx := range perm {
				qa := qaCorpus[idx]

				// Tokenize Q and A into vocab IDs
				qWords := strings.Fields(strings.ToLower(qa.Q))
				aWords := strings.Fields(strings.ToLower(qa.A))

				qIDs := make([]int, len(qWords))
				for w, word := range qWords {
					qIDs[w] = int(org.Vocab.GetOrCreate(word))
				}

				// Train on each answer word as target
				for _, word := range aWords {
					targetID := int(org.Vocab.GetOrCreate(word))
					matches := org.NeuroRadio.TrainStep(qIDs, targetID, 5)
					totalMatches += matches
				}

				// Also feed co-occurrence
				allWords := make([]string, 0, len(qWords)+len(aWords))
				allWords = append(allWords, qWords...)
				allWords = append(allWords, aWords...)
				allIDs := make([]int, len(allWords))
				for w, word := range allWords {
					allIDs[w] = int(org.Vocab.GetOrCreate(word))
				}
				org.NeuroRadio.Codec.ObserveCooccurrence(allIDs)

				if (i+1)%30 == 0 {
					nrStats := org.NeuroRadio.Stats()
					fmt.Printf("     [%3d/%d] ticks: %d | alive: %d/%d | active: %d | avg amp: %d | matches: %d\n",
						i+1, len(qaCorpus),
						nrStats.TickCount, nrStats.AliveTiles, nrStats.TotalTiles,
						nrStats.ActiveLast, nrStats.AvgAmplitude, totalMatches)
				}
			}

			// Neurogenesis between epochs
			replaced := org.NeuroRadio.Neurogenesis()
			fmt.Printf("  🧬 Epoch %d done (%v) | Neurogenesis: %d tiles replaced\n",
				epoch, time.Since(epochStart), replaced)

			// Re-assign semantic frequencies every epoch
			org.NeuroRadio.Codec.AssignFrequencies()
			org.NeuroRadio.RebuildDecoder()
		}

		fmt.Printf("\n  ✅ NeuroRadio training complete in %v\n", time.Since(nrStart))
		nrFinal := org.NeuroRadio.Stats()
		fmt.Printf("     Tiles: %d alive / %d total | Avg amplitude: %d | Ticks: %d\n\n",
			nrFinal.AliveTiles, nrFinal.TotalTiles, nrFinal.AvgAmplitude, nrFinal.TickCount)
	}

	// ══════════════════════════════════════════════════════════
	// PHASE 3: Recall testing
	// ══════════════════════════════════════════════════════════
	fmt.Println("┌──────────────────────────────────────────────────────────────┐")
	fmt.Println("│  🧪 PHASE 3: RECALL TESTING                                 │")
	fmt.Println("└──────────────────────────────────────────────────────────────┘")

	testQuestions := []struct{ Q, Expected string }{
		{"ce face pisica", "pisica doarme"},
		{"ce face câinele", "câinele aleargă"},
		{"unde doarme pisica", "canapea"},
		{"ce culoare are cerul", "albastru"},
		{"ce mănâncă pisica", "pește"},
		{"cum face câinele", "ham"},
		{"what is a neuron", "cell"},
		{"what is the brain", "organ"},
		{"what is memory", "store"},
		{"how do neurons communicate", "electrical"},
		{"what color is the sky", "blue"},
		{"how many legs does a dog have", "four"},
		{"hello", "hello"},
		{"what is your name", "ilaria"},
		{"is fire hot or cold", "hot"},
		{"ce este soarele", "stea"},
	}

	correct, partial := 0, 0
	for _, t := range testQuestions {
		response := org.Process(t.Q)
		matched := strings.Contains(strings.ToLower(response), strings.ToLower(t.Expected))
		icon := "❌"
		if matched {
			icon = "✅"
			correct++
		} else if response != "" && response != cortex.NoConfidentResponse {
			icon = "🔶"
			partial++
		}
		display := response
		if len(display) > 60 {
			display = display[:60] + "..."
		}
		fmt.Printf("  %s Q: %-35s → %s\n", icon, t.Q, display)
	}

	fmt.Printf("\n  📊 Results: %d/%d correct, %d partial, %d missed\n",
		correct, len(testQuestions), partial, len(testQuestions)-correct-partial)

	// ══════════════════════════════════════════════════════════
	// PHASE 4: Final stats
	// ══════════════════════════════════════════════════════════
	fmt.Println()
	fmt.Println("┌──────────────────────────────────────────────────────────────┐")
	fmt.Println("│  📊 FINAL STATS                                             │")
	fmt.Println("└──────────────────────────────────────────────────────────────┘")

	stats := org.Stats()

	fmt.Printf("  🧠 Hippocampus memories : %d\n", stats.HippocampusMemories)
	fmt.Printf("  🗣  Broca patterns       : %d\n", stats.BrocaPatterns)
	fmt.Printf("  👂 Wernicke rules        : %d\n", stats.WernickeNGrams)
	fmt.Printf("  🎯 Prefrontal synapses   : %d\n", stats.PrefrontalSynapses)
	if org.RadioCortex != nil {
		radioFinal := org.RadioCortex.Stats()
		fmt.Printf("  📡 Radio neurons         : %d (alive: %d)\n", radioFinal.TotalNeurons, radioFinal.AliveNeurons)
		fmt.Printf("  📡 Radio ticks           : %d\n", radioFinal.TickCount)
		fmt.Printf("  📡 Radio avg amplitude   : %d / 255\n", radioFinal.AvgAmplitude)
	}

	if org.NeuroRadio != nil {
		nrFinal := org.NeuroRadio.Stats()
		fmt.Printf("  ⚡ NeuroRadio tiles       : %d (alive: %d)\n", nrFinal.TotalTiles, nrFinal.AliveTiles)
		fmt.Printf("  ⚡ NeuroRadio ticks       : %d\n", nrFinal.TickCount)
		fmt.Printf("  ⚡ NeuroRadio avg amp     : %d / 255\n", nrFinal.AvgAmplitude)
		fmt.Printf("  ⚡ NeuroRadio last active : %d\n", nrFinal.ActiveLast)
	}

	fmt.Printf("  💚 Mood                  : %s\n", stats.EmotionalMood)
	fmt.Printf("  🪞 Self accuracy         : %d / 255\n", stats.SelfAccuracy)
	fmt.Printf("  💬 Total interactions     : %d\n", stats.InteractionCount)

	fmt.Println()
	fmt.Println("  ✅ Training session complete!")

	// Save
	if err := org.Save(cfg.DataDir); err != nil {
		fmt.Printf("  ⚠️  Save error: %v\n", err)
	} else {
		fmt.Println("  💾 Organism saved to", cfg.DataDir)
	}
}
