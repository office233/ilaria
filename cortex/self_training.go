package cortex

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
)

// DefaultCorpusFiles is the canonical list of corpus JSONL filenames
// used by both SelfEvolve and InitBroca2. Single source of truth.
var DefaultCorpusFiles = []string{
	"general.jsonl", "reasoning.jsonl",
	"wikipedia_ro.jsonl", "alpaca.jsonl", "dolly.jsonl",
}

// selfTrainBatchSize is the gradient-accumulation size for online
// self-training. 8 sequences per Adam update is enough to smooth
// single-sample gradient noise while keeping the latency of one update
// low enough for interactive Sleep() cycles.
const selfTrainBatchSize = 8

// ─────────────────────────────────────────────────────────────────────
// Self-Training — Continuous Evolution Engine
// ─────────────────────────────────────────────────────────────────────
//
// This module connects the Organism's memory systems to the Transformer
// training loop, enabling self-evolution:
//
//   Sleep() → Extract memories → Format as training pairs
//   → Train Transformer on them → Better language generation
//   → Better responses → Better memories → Better training → ...
//
// This is the core differentiator: LLMs are frozen after training.
// Nexus Cortex evolves continuously from its own experience.

// TrainTransformerFromCorpus trains the Broca 2.0 transformer on
// text from JSONL corpus files (Wikipedia, Alpaca, etc.).
//
// Each line in the corpus should be JSON with a "text" field.
// Returns the average loss after training.
func (o *Organism) TrainTransformerFromCorpus(corpusPath string, maxLines int, lr float32) (float32, int, error) {
	if o.Transformer == nil || o.Tokenizer == nil {
		return 0, 0, fmt.Errorf("transformer or tokenizer not initialized")
	}
	opt := o.ensureAdamState()

	f, err := os.Open(corpusPath)
	if err != nil {
		return 0, 0, fmt.Errorf("open corpus: %w", err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	totalLoss := float32(0)
	steps := 0
	lineCount := 0

	// Sequences are accumulated into mini-batches: a 1-sequence Adam
	// update follows that sample's gradient noise, while the mean over
	// a batch mostly cancels it (see TrainStepAdamBatch).
	batch := make([][]int, 0, selfTrainBatchSize)

	flush := func() {
		if len(batch) == 0 {
			return
		}
		loss := o.Transformer.TrainStepAdamBatch(batch, lr, opt)
		if loss == loss { // NaN check
			totalLoss += loss * float32(len(batch))
			steps += len(batch)
		}
		batch = batch[:0]

		if steps%100 < selfTrainBatchSize && steps >= 100 {
			fmt.Printf("[Self-Train] %d steps, avg loss: %.4f\n", steps, totalLoss/float32(steps))
		}
	}

	for scanner.Scan() {
		if maxLines > 0 && lineCount >= maxLines {
			break
		}
		lineCount++

		line := scanner.Text()
		text := extractCorpusText(line)
		if text == "" || len(text) < 20 {
			continue
		}

		// Tokenize
		ids := o.Tokenizer.EncodeWithSpecial(text)
		if len(ids) < 3 {
			continue
		}

		// Truncate to max sequence length + 1 (for shifted target)
		maxLen := o.Transformer.Config.MaxSeqLen + 1
		if len(ids) > maxLen {
			ids = ids[:maxLen]
		}

		batch = append(batch, ids)
		if len(batch) >= selfTrainBatchSize {
			flush()
		}
	}
	flush()

	if steps == 0 {
		return 0, 0, fmt.Errorf("no valid training data found")
	}

	avgLoss := totalLoss / float32(steps)
	return avgLoss, steps, nil
}

// TrainTransformerFromMemories trains the transformer on the organism's
// own episodic memories — this is the self-evolution loop.
//
// During Sleep, episodic memories are replayed and used as training data
// for the language model, making future responses better.
func (o *Organism) TrainTransformerFromMemories(lr float32) (float32, int) {
	if o.Transformer == nil || o.Tokenizer == nil || o.Hippocampus == nil {
		return 0, 0
	}
	opt := o.ensureAdamState()

	memories := o.Hippocampus.GetAllContexts()
	if len(memories) == 0 {
		return 0, 0
	}

	totalLoss := float32(0)
	steps := 0
	batch := make([][]int, 0, selfTrainBatchSize)

	flush := func() {
		if len(batch) == 0 {
			return
		}
		loss := o.Transformer.TrainStepAdamBatch(batch, lr, opt)
		if loss == loss {
			totalLoss += loss * float32(len(batch))
			steps += len(batch)
		}
		batch = batch[:0]
	}

	for _, context := range memories {
		if len(context) < 10 {
			continue
		}

		// Tokenize the memory
		ids := o.Tokenizer.EncodeWithSpecial(context)
		if len(ids) < 3 {
			continue
		}

		maxLen := o.Transformer.Config.MaxSeqLen + 1
		if len(ids) > maxLen {
			ids = ids[:maxLen]
		}

		batch = append(batch, ids)
		if len(batch) >= selfTrainBatchSize {
			flush()
		}
	}
	flush()

	if steps == 0 {
		return 0, 0
	}

	return totalLoss / float32(steps), steps
}

// TrainTransformerFromQA trains on question-answer pairs,
// teaching the model to produce answers given questions.
func (o *Organism) TrainTransformerFromQA(question, answer string, lr float32) float32 {
	if o.Transformer == nil || o.Tokenizer == nil {
		return 0
	}

	// Format: <BOS> question <SEP> answer <EOS>
	qIDs := o.Tokenizer.Encode(question)
	aIDs := o.Tokenizer.Encode(answer)

	ids := make([]int, 0, len(qIDs)+len(aIDs)+3)
	ids = append(ids, o.Tokenizer.BosID())
	ids = append(ids, qIDs...)
	ids = append(ids, o.Tokenizer.SepID())
	ids = append(ids, aIDs...)
	ids = append(ids, o.Tokenizer.EosID())

	if len(ids) < 3 {
		return 0
	}

	maxLen := o.Transformer.Config.MaxSeqLen + 1
	if len(ids) > maxLen {
		ids = ids[:maxLen]
	}

	return o.Transformer.TrainStepAdam(ids, lr, o.ensureAdamState())
}

// SelfEvolve runs one full self-evolution cycle:
//  1. Replay episodic memories through Transformer training
//  2. If corpus exists, train on a batch from it
//  3. Update training stats
//
// This is called during Sleep() for continuous evolution.
func (o *Organism) SelfEvolve() (memoriesTrainedOn int, corpusTrainedOn int, avgLoss float32) {
	if o.Transformer == nil || o.Tokenizer == nil {
		return 0, 0, 0
	}

	lr := float32(o.Config.SelfEvolveLearningRate) // Learning rate from config
	totalLoss := float32(0)
	totalSteps := 0

	// Phase 1: Train on episodic memories
	memLoss, memSteps := o.TrainTransformerFromMemories(lr)
	if memSteps > 0 {
		totalLoss += memLoss * float32(memSteps)
		totalSteps += memSteps
		memoriesTrainedOn = memSteps
		fmt.Printf("[SelfEvolve] Phase 1: Trained on %d memories (loss: %.4f)\n", memSteps, memLoss)
	}

	// Phase 2: Train on corpus batch (if available)
	corpusDir := filepath.Join(o.Config.DataDir, "corpus")
	corpusFiles := DefaultCorpusFiles

	for _, cf := range corpusFiles {
		corpusPath := filepath.Join(corpusDir, cf)
		if _, err := os.Stat(corpusPath); err != nil {
			continue
		}

		// Small batch per sleep cycle to prevent catastrophic forgetting
		batchSize := o.Config.SelfEvolveBatchSize
		cLoss, cSteps, err := o.TrainTransformerFromCorpus(corpusPath, batchSize, lr)
		if err == nil && cSteps > 0 {
			totalLoss += cLoss * float32(cSteps)
			totalSteps += cSteps
			corpusTrainedOn += cSteps
			fmt.Printf("[SelfEvolve] Phase 2: Trained on %d corpus lines from %s (loss: %.4f)\n",
				cSteps, cf, cLoss)
		}
	}

	if totalSteps > 0 {
		avgLoss = totalLoss / float32(totalSteps)
	}

	return memoriesTrainedOn, corpusTrainedOn, avgLoss
}

// InitBroca2 initializes the Broca 2.0 system from scratch:
// trains a BPE tokenizer on available corpus and creates a transformer.
// This is a one-time setup operation.
func (o *Organism) InitBroca2(vocabSize int) error {
	corpusDir := filepath.Join(o.Config.DataDir, "corpus")

	// Collect training text from all JSONL files
	var lines []string
	corpusFiles := DefaultCorpusFiles

	for _, cf := range corpusFiles {
		path := filepath.Join(corpusDir, cf)
		f, err := os.Open(path)
		if err != nil {
			continue
		}

		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

		count := 0
		maxPerFile := o.Config.BPEMaxLinesPerFile // Cap per file for tokenizer training
		for scanner.Scan() {
			if count >= maxPerFile {
				break
			}
			text := extractCorpusText(scanner.Text())
			if text != "" && len(text) > 10 {
				lines = append(lines, text)
				count++
			}
		}
		f.Close()
		fmt.Printf("[InitBroca2] Read %d lines from %s\n", count, cf)
	}

	if len(lines) == 0 {
		return fmt.Errorf("no corpus data found in %s", corpusDir)
	}

	// Train BPE tokenizer
	fmt.Printf("[InitBroca2] Training BPE tokenizer on %d lines (vocab: %d)...\n",
		len(lines), vocabSize)

	tok := NewBPETokenizer(vocabSize)
	tok.Train(lines)

	// Save tokenizer
	tokPath := filepath.Join(o.Config.DataDir, "tokenizer.json")
	if err := tok.Save(tokPath); err != nil {
		return fmt.Errorf("save tokenizer: %w", err)
	}
	fmt.Printf("[InitBroca2] Tokenizer saved to %s (vocab: %d, merges: %d)\n",
		tokPath, tok.ActualVocabSize(), len(tok.Merges))

	// Create transformer
	tfCfg := TransformerConfigFromConfig(tok.ActualVocabSize(), o.Config)
	tf := NewMiniTransformer(tfCfg, o.Rng)
	fmt.Printf("[InitBroca2] Transformer created (%d params, ~%.1fM)\n",
		tf.ParamCount(), float64(tf.ParamCount())/1e6)

	// Attach to organism
	o.Tokenizer = tok
	o.Transformer = tf

	return nil
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

// extractCorpusText extracts text content from a JSONL line.
// Supports formats: {"text": "..."}, {"instruction": "...", "response": "..."}
func extractCorpusText(line string) string {
	line = strings.TrimSpace(line)
	if line == "" || line[0] != '{' {
		return ""
	}

	var data map[string]interface{}
	if err := json.Unmarshal([]byte(line), &data); err != nil {
		return ""
	}

	// Try "text" field first
	if text, ok := data["text"].(string); ok && text != "" {
		return text
	}

	// Try instruction + response format (Alpaca/Dolly)
	instruction, _ := data["instruction"].(string)
	response, _ := data["response"].(string)
	if instruction != "" && response != "" {
		return instruction + " " + response
	}

	// Try "input" + "output"
	input, _ := data["input"].(string)
	output, _ := data["output"].(string)
	if input != "" && output != "" {
		return input + " " + output
	}

	return ""
}

// ─────────────────────────────────────────────────────────────────────
// Training Scheduler
// ─────────────────────────────────────────────────────────────────────

// TrainingStats tracks the evolution of the transformer over time.
type TrainingStats struct {
	TotalSteps      int     `json:"total_steps"`
	TotalMemories   int     `json:"total_memories"`
	TotalCorpus     int     `json:"total_corpus"`
	LastLoss        float32 `json:"last_loss"`
	BestLoss        float32 `json:"best_loss"`
	SleepCycles     int     `json:"sleep_cycles"`
}

// NewTrainingStats creates an empty stats tracker.
func NewTrainingStats() *TrainingStats {
	return &TrainingStats{
		BestLoss: float32(math.Inf(1)),
	}
}

// Update records results from a self-evolution cycle.
func (ts *TrainingStats) Update(memories, corpus int, loss float32) {
	ts.TotalSteps += memories + corpus
	ts.TotalMemories += memories
	ts.TotalCorpus += corpus
	ts.LastLoss = loss
	ts.SleepCycles++
	if loss < ts.BestLoss && loss > 0 {
		ts.BestLoss = loss
	}
}
