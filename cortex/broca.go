package cortex

import (
	"math"
	"sort"
	"strings"
)

// ─────────────────────────────────────────────────────────────────────
// Broca — Language Generation
// ─────────────────────────────────────────────────────────────────────
//
// Named after Broca's area in the human brain, this module handles
// language production. It converts neural activation patterns (SDRs)
// back into coherent text by:
//
//   1. Decoding the input SDR to find the closest matching word.
//   2. Using the Brain's associative memory to predict the next word.
//   3. Chaining predictions until maxWords or a sentence boundary.
//
// Two entry points are provided:
//   - Generate(inputSDR, maxWords):     start from a raw SDR pattern.
//   - GenerateFromContext(context, max): start from known word strings.

// Broca performs language generation by decoding SDR patterns into
// text and chaining word predictions via associative memory.
type Broca struct {
	Decoder              *Decoder
	Encoder              *Encoder
	Vocab                *Vocab
	Brain                *Brain
	ConfidenceProximity  uint8
	TopNCandidates       int
	SequentialMultiplier uint16
}

// NewBroca creates a new language generation module with the given config.
func NewBroca(vocab *Vocab, encoder *Encoder, decoder *Decoder, brain *Brain, cfg Config) *Broca {
	return &Broca{
		Decoder:              decoder,
		Encoder:              encoder,
		Vocab:                vocab,
		Brain:                brain,
		ConfidenceProximity:  cfg.BrocaConfidenceProximity,
		TopNCandidates:       cfg.BrocaTopNCandidates,
		SequentialMultiplier: cfg.BrocaSequentialMultiplier,
	}
}

// isPunctuation returns true if the word is a single punctuation mark.
func isPunctuation(w string) bool {
	if len(w) == 1 {
		r := w[0]
		return r == '.' || r == ',' || r == '!' || r == '?' || r == ':' || r == ';'
	}
	return false
}

// predictNextConstrained finds the next word, but restricts candidates to those in allowedIDs.
func (b *Broca) predictNextConstrained(currentID uint32, recentlyUsed map[uint32]int, allowedIDs map[uint32]bool) (uint32, bool) {
	type candidate struct {
		id     uint32
		weight uint16
	}

	b.Brain.mu.RLock()
	defer b.Brain.mu.RUnlock()

	var candidates []candidate
	syns := b.Brain.GetMergedSynapses(currentID)
	for _, syn := range syns {
		if syn.Flags&SynFlagActive == 0 || syn.Weight == 0 {
			continue
		}
		// Constraint: Target must be in allowedIDs
		if !allowedIDs[syn.Target] {
			continue
		}

		score := uint32(syn.Weight)
		if syn.Flags&SynFlagSequential != 0 {
			score *= uint32(b.SequentialMultiplier)
			if score > 65535 {
				score = 65535
			}
		}
		w := uint16(score)

		if count, ok := recentlyUsed[syn.Target]; ok && count > 0 {
			w /= uint16(count + 1)
		}

		if w > 0 {
			candidates = append(candidates, candidate{syn.Target, w})
		}
	}

	if len(candidates) == 0 {
		return 0, false
	}

	// Sort by weight descending.
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].weight > candidates[j].weight
	})

	topN := len(candidates)
	if topN > b.TopNCandidates {
		topN = b.TopNCandidates
	}
	top := candidates[:topN]

	totalWeight := uint32(0)
	for _, c := range top {
		totalWeight += uint32(c.weight)
	}

	if totalWeight == 0 {
		return top[0].id, true
	}

	roll := uint32(b.Brain.Rng.Intn(int(totalWeight)))
	cumulative := uint32(0)
	for _, c := range top {
		cumulative += uint32(c.weight)
		if roll < cumulative {
			return c.id, true
		}
	}

	return top[0].id, true
}

// Generate produces text starting from the given SDR pattern.
//
// The input SDR is decoded to find the best-matching word, which
// then seeds the Brain's associative chain. The Brain predicts
// successive words by following its strongest learned connections.
//
// Returns at most maxWords of generated text (including the seed word).
// Generation stops early at sentence-ending punctuation.
func (b *Broca) Generate(inputSDR SDR, maxWords int) string {
	if maxWords <= 0 {
		return ""
	}

	// Decode the input SDR to a boolean spike pattern for the decoder.
	sdrSize := inputSDR.Size
	pattern := make([]bool, sdrSize)
	for _, idx := range inputSDR.ActiveIndices() {
		if idx < sdrSize {
			pattern[idx] = true
		}
	}

	// Find the top candidate words matching this pattern.
	// Sursă unică: Config.BrocaDecodeTopK (default 50 prin DefaultConfig).
	// Fallback-ul folosește DefaultConfig în loc de constantă duplicată ca
	// să evităm drift dacă defaults se schimbă.
	topK := b.Brain.Config.BrocaDecodeTopK
	if topK <= 0 {
		topK = DefaultConfig().BrocaDecodeTopK
	}
	candidates := b.Decoder.DecodeTopK(pattern, sdrSize, topK)
	if len(candidates) == 0 {
		return ""
	}

	// Filter candidates close to the maximum confidence (similarity).
	maxConf := candidates[0].Confidence
	var sentenceWords []string
	wordIDs := make(map[uint32]string)
	wordIDSet := make(map[uint32]bool)

	for _, cand := range candidates {
		if cand.Word == "<UNK>" {
			continue
		}
		if cand.Confidence >= maxConf-b.ConfidenceProximity {
			id := b.Vocab.Get(cand.Word)
			if id > 0 {
				sentenceWords = append(sentenceWords, cand.Word)
				wordIDs[id] = cand.Word
				wordIDSet[id] = true
			}
		}
	}

	if len(sentenceWords) == 0 {
		return ""
	}

	// Default seed is the best candidate (try to avoid starting with punctuation).
	seedWord := sentenceWords[0]
	for _, w := range sentenceWords {
		if !isPunctuation(w) {
			seedWord = w
			break
		}
	}

	// Use Brain synapses to find the topological root of the sentence sequence
	if len(sentenceWords) > 1 {
		incomingCount := make(map[uint32]int)
		outgoingCount := make(map[uint32]int)

		b.Brain.mu.RLock()
		for srcID, syns := range b.Brain.Synapses {
			for _, syn := range syns {
				if syn.Flags&SynFlagActive == 0 || syn.Flags&SynFlagSequential == 0 {
					continue
				}
				if wordIDSet[srcID] && wordIDSet[syn.Target] {
					incomingCount[syn.Target]++
					outgoingCount[srcID]++
				}
			}
		}
		b.Brain.mu.RUnlock()

		// The sequence root has the minimum incoming sequential synapses from other words in the candidate set.
		// If there is a tie, we pick the one with maximum outgoing connections to break it.
		bestID := uint32(0)
		minIncoming := math.MaxInt
		maxOutgoing := -1

		for id := range wordIDSet {
			// Avoid punctuation as seed word if possible
			wordStr := wordIDs[id]
			if isPunctuation(wordStr) {
				continue
			}

			in := incomingCount[id]
			out := outgoingCount[id]
			if in < minIncoming {
				minIncoming = in
				maxOutgoing = out
				bestID = id
			} else if in == minIncoming {
				if out > maxOutgoing {
					maxOutgoing = out
					bestID = id
				}
			}
		}

		if bestID > 0 {
			seedWord = wordIDs[bestID]
		}
	}

	// Constrained sequence generation
	output := make([]string, 0, maxWords)
	output = append(output, seedWord)

	currentID := b.Vocab.Get(seedWord)
	recentlyUsed := make(map[uint32]int)
	recentlyUsed[currentID] = 1

	contextIDs := []uint32{currentID}

	for i := 1; i < maxWords; i++ {
		nextID, found := b.predictNextConstrained(currentID, recentlyUsed, wordIDSet)
		if !found {
			// Fallback to unconstrained general prediction
			// 1. Try multi-context SequenceMemory first
			if b.Brain.SeqMem != nil {
				nextID, found = b.Brain.SeqMem.Predict(contextIDs, recentlyUsed)
			}
			// 2. Fall back to bigram associative synapses
			if !found {
				b.Brain.mu.RLock()
				nextID, found = b.Brain.predictNext(currentID, recentlyUsed)
				b.Brain.mu.RUnlock()
			}
			if !found {
				break
			}
		}

		word := b.Vocab.Decode(nextID)
		output = append(output, word)
		contextIDs = append(contextIDs, nextID)

		recentlyUsed[nextID]++
		currentID = nextID
	}

	return b.Brain.formatOutput(output)
}

// GenerateFromContext produces text using the given context words
// as the starting prompt.
//
// This is a convenience method that joins the context words into
// a prompt string and delegates to the Brain's generation engine.
// The Brain starts from the last word in the context and follows
// its strongest associative connections.
//
// Returns at most maxWords of newly generated text appended to
// the context. Generation stops early at sentence boundaries.
func (b *Broca) GenerateFromContext(context []string, maxWords int) string {
	if len(context) == 0 || maxWords <= 0 {
		return ""
	}

	prompt := strings.Join(context, " ")
	return b.Brain.Generate(prompt, maxWords)
}

// GenerateAutoregressive generates text by feeding tokens sequentially into the
// stateful FractalCortex, predicting the next token, and appending it to the context.
// This forms an autoregressive P(w_t | w_1...w_{t-1}) generation loop.
func (b *Broca) GenerateAutoregressive(fc *FractalCortex, contextWords []string, maxTokens int) string {
	if fc == nil || len(contextWords) == 0 || maxTokens <= 0 {
		return ""
	}

	// Reset cortex state for a clean generation pass
	if len(fc.Blocks) > 0 {
		for _, block := range fc.Blocks {
			block.Reset()
		}
	}

	var currentState SDR
	// 1. Feed the initial context into the cortex to build up the temporal state
	for _, word := range contextWords {
		wordSDR := b.Encoder.EncodeWord(word)
		currentState = fc.ProcessToken(wordSDR)
	}

	// 2. Autoregressive loop
	var generated []string
	recentWords := make(map[string]int) // track word frequency to avoid loops
	lastWord := ""
	consecutiveRepeats := 0

	for i := 0; i < maxTokens; i++ {
		// Decode the current state (which predicts the next token)
		pattern := make([]bool, currentState.Size)
		for _, idx := range currentState.ActiveIndices() {
			if idx < currentState.Size {
				pattern[idx] = true
			}
		}
		topK := b.Decoder.DecodeTopK(pattern, currentState.Size, 8)
		if len(topK) == 0 {
			break
		}

		// Pick the best word that isn't a loop
		var nextWord string
		for _, cand := range topK {
			if cand.Word == "<UNK>" {
				continue
			}
			// Anti-loop: skip words that have been used too many times
			if recentWords[cand.Word] >= 2 {
				continue // don't use any word more than twice total
			}
			nextWord = cand.Word
			break
		}
		if nextWord == "" {
			break // all candidates are loops, stop
		}

		// Consecutive repeat detection
		if nextWord == lastWord {
			consecutiveRepeats++
			if consecutiveRepeats >= 2 {
				break
			}
		} else {
			consecutiveRepeats = 0
		}

		generated = append(generated, nextWord)
		recentWords[nextWord]++
		lastWord = nextWord

		// Stop condition: end of sentence
		if isPunctuation(nextWord) {
			break
		}

		// Feed the generated word back into the cortex to update state for the next prediction
		nextWordSDR := b.Encoder.EncodeWord(nextWord)
		currentState = fc.ProcessToken(nextWordSDR)
	}

	return b.Brain.formatOutput(generated)
}

// GenerateWithTransformer uses the MiniTransformer and BPETokenizer to
// produce fluent text via proper autoregressive language modeling.
//
// This is Broca 2.0's primary generation path. It:
//  1. Tokenizes context + memory text via BPE
//  2. Runs the transformer forward pass to get next-token probabilities
//  3. Samples with temperature modulated by the Prefrontal confidence
//  4. Detokenizes the output back to text
//
// Falls back to empty string if transformer or tokenizer is nil.
func (b *Broca) GenerateWithTransformer(
	transformer *MiniTransformer,
	tokenizer *BPETokenizer,
	contextWords []string,
	memoryContext string,
	confidence uint8,
	maxTokens int,
) string {
	return b.GenerateWithTransformerBiased(
		transformer, tokenizer, contextWords, memoryContext,
		confidence, maxTokens, nil,
	)
}

// GenerateWithTransformerBiased is GenerateWithTransformer plus an optional
// cognitive logit bias produced by CognitiveBridge.ComputeBias.
//
// The bias lets episodic memory influence WHICH tokens the transformer can
// reach, which is what makes a one-shot learned fact usable at generation
// time by a model whose weights never saw it. A nil bias makes this
// behave identically to the unbiased path.
func (b *Broca) GenerateWithTransformerBiased(
	transformer *MiniTransformer,
	tokenizer *BPETokenizer,
	contextWords []string,
	memoryContext string,
	confidence uint8,
	maxTokens int,
	bias []float32,
) string {
	if transformer == nil || tokenizer == nil || len(contextWords) == 0 || maxTokens <= 0 {
		return ""
	}

	// A byte-level tokenizer means the transformer carries imported
	// GPT-2-family weights — those models answer QA prompts, not the
	// "memory | words" concatenation the from-scratch model trains on.
	// Route to the format that scored 96% on continual-bench.
	if tokenizer.ByteLevel {
		return b.generateQAStyle(transformer, tokenizer, contextWords, memoryContext, confidence, maxTokens, bias)
	}

	// Build prompt from context + memory
	var prompt strings.Builder
	if memoryContext != "" {
		prompt.WriteString(memoryContext)
		prompt.WriteString(" | ")
	}
	prompt.WriteString(strings.Join(contextWords, " "))

	// Tokenize with BPE (no special tokens — we add BOS manually)
	promptIDs := tokenizer.Encode(prompt.String())
	if len(promptIDs) == 0 {
		return ""
	}

	// Prepend BOS token
	input := make([]int, 0, len(promptIDs)+1)
	input = append(input, tokenizer.BosID())
	input = append(input, promptIDs...)

	// Temperature modulated by confidence:
	// High confidence → low temperature (more deterministic)
	// Low confidence → high temperature (more exploratory)
	temperature := float32(1.0)
	if confidence > 200 {
		temperature = 0.5
	} else if confidence > 150 {
		temperature = 0.7
	} else if confidence > 100 {
		temperature = 0.9
	} else if confidence < 50 {
		temperature = 1.3
	}

	// Generate. Use the KV-cached fast path which is numerically
	// equivalent to Generate() but O(N) per emitted token instead of
	// O(N^2). On CPU the speedup is the difference between a usable
	// dashboard and an unusable one.
	outputIDs := transformer.GenerateFastBiased(input, maxTokens, 0, temperature, 40, bias)

	// Extract only the generated part (remove prompt)
	if len(outputIDs) <= len(input) {
		return ""
	}
	generatedIDs := outputIDs[len(input):]

	// Decode back to text
	text := tokenizer.Decode(generatedIDs)
	text = strings.TrimSpace(text)

	if text == "" || text == "<UNK>" {
		return ""
	}

	return text
}

// generateQAStyle is the generation path for imported GPT-2-family
// models. It uses the exact prompt shape validated by
// cmd/continual-bench (96% strict accuracy): a fixed one-shot format
// example — GPT-2-class models echo the question without one — then
// the recalled memory as a Fact line, then the question.
//
// The one-shot example is a deliberately banal, benchmark-unrelated
// fact; it teaches FORM, not content, and is identical whether or not
// a memory was recalled, so it never advantages one path.
func (b *Broca) generateQAStyle(
	transformer *MiniTransformer,
	tokenizer *BPETokenizer,
	contextWords []string,
	memoryContext string,
	confidence uint8,
	maxTokens int,
	bias []float32,
) string {
	question := strings.TrimRight(strings.Join(contextWords, " "), "?!. ")

	var prompt strings.Builder
	if memoryContext != "" {
		prompt.WriteString("Fact: the sky is blue on clear days\n")
		prompt.WriteString("Question: what color is the sky on clear days?\n")
		prompt.WriteString("Answer: blue\n\n")
		prompt.WriteString("Fact: ")
		prompt.WriteString(memoryContext)
		prompt.WriteString("\n")
	} else {
		prompt.WriteString("Question: what color is the sky on clear days?\n")
		prompt.WriteString("Answer: blue\n\n")
	}
	prompt.WriteString("Question: ")
	prompt.WriteString(question)
	prompt.WriteString("?\nAnswer:")

	ids := tokenizer.Encode(prompt.String())
	if len(ids) == 0 {
		return ""
	}

	// Factual QA wants a cool temperature; confidence nudges it. The
	// repetition penalty is mild — enough to break question-echo loops,
	// low enough not to fight copying the answer out of the Fact line.
	temperature := float32(0.5)
	if confidence > 200 {
		temperature = 0.3
	} else if confidence < 50 {
		temperature = 0.8
	}

	out := transformer.GenerateSampled(ids, SampleConfig{
		MaxNewTokens:      maxTokens,
		MinNewTokens:      2,
		Temperature:       temperature,
		TopK:              40,
		TopP:              0.95,
		RepetitionPenalty: 1.1,
	}, bias)
	if len(out) <= len(ids) {
		return ""
	}

	text := strings.TrimSpace(tokenizer.Decode(out[len(ids):]))
	// The model often rambles into a new "Question:"/"Fact:" block —
	// everything after the first such marker is format noise, not answer.
	for _, stop := range []string{"\nQuestion:", "\nFact:", "\nAnswer:"} {
		if i := strings.Index(text, stop); i >= 0 {
			text = strings.TrimSpace(text[:i])
		}
	}
	return text
}
