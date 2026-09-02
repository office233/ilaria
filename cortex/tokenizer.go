package cortex

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ─────────────────────────────────────────────────────────────────────
// BPE Tokenizer — Byte-Pair Encoding for Nexus Cortex
// ─────────────────────────────────────────────────────────────────────
//
// A character-level BPE tokenizer that learns subword units from text.
// Supports UTF-8 natively, handles Romanian diacritics, English, and
// code. Can be trained on any corpus from zero.
//
// Design:
//   - Character-level initial tokens (not byte-level) for readability
//   - Space prefix marker (Ġ, U+0120) following GPT-2 convention
//   - 5 reserved special tokens: <PAD>, <UNK>, <BOS>, <EOS>, <SEP>
//   - Zero external dependencies — pure Go

const (
	// SpaceMarker is prefixed to tokens that follow a whitespace boundary,
	// allowing the tokenizer to reconstruct spaces during decoding.
	SpaceMarker = "Ġ"

	// Special tokens
	TokenPAD = "<PAD>"
	TokenUNK = "<UNK>"
	TokenBOS = "<BOS>"
	TokenEOS = "<EOS>"
	TokenSEP = "<SEP>"

	numSpecialTokens = 5
)

// MergePair represents a single BPE merge rule: tokens A and B are
// merged into AB whenever they appear adjacent.
type MergePair struct {
	A string `json:"a"`
	B string `json:"b"`
}

// BPETokenizer performs subword tokenization using Byte-Pair Encoding.
//
// After training, the tokenizer can encode arbitrary text into a
// sequence of integer token IDs, and decode IDs back to text.
type BPETokenizer struct {
	Merges    []MergePair    `json:"merges"`
	TokenToID map[string]int `json:"token_to_id"`
	IDToToken []string       `json:"id_to_token"`
	VocabSize int            `json:"vocab_size"`

	// ByteLevel marks a GPT-2-style byte-level vocabulary (loaded via
	// LoadGPT2Tokenizer). In this mode the base alphabet is the 256
	// mapped byte symbols, pre-tokenization follows GPT-2 semantics,
	// <UNK> cannot occur, and <|endoftext|> plays every special role.
	// See tokenizer_gpt2.go.
	ByteLevel bool `json:"byte_level,omitempty"`

	// mergeRank caches "A\x00B" → merge priority (lower = applied first).
	// Built from Merges on load/train.
	mergeRank map[string]int
}

// NewBPETokenizer creates an untrained tokenizer targeting the given vocab size.
// Minimum vocab size is numSpecialTokens + 256 (to cover ASCII base chars).
func NewBPETokenizer(vocabSize int) *BPETokenizer {
	minSize := numSpecialTokens + 256
	if vocabSize < minSize {
		vocabSize = minSize
	}
	return &BPETokenizer{
		VocabSize: vocabSize,
		TokenToID: make(map[string]int),
		mergeRank: make(map[string]int),
	}
}

// ─────────────────────────────────────────────────────────────────────
// Pre-Tokenization
// ─────────────────────────────────────────────────────────────────────

// PreTokenize splits text into pre-tokens at word boundaries.
// Tokens that follow whitespace receive the Ġ prefix so the
// tokenizer can reconstruct spaces during decoding.
//
// Example: "Hello world!" → ["Hello", "Ġworld", "Ġ!"]
func PreTokenize(text string) []string {
	if text == "" {
		return nil
	}

	var result []string
	var current strings.Builder
	isFirst := true

	for i := 0; i < len(text); {
		r, size := utf8.DecodeRuneInString(text[i:])
		if r == utf8.RuneError && size <= 1 {
			i++
			continue
		}

		if unicode.IsSpace(r) {
			// Flush current token
			if current.Len() > 0 {
				result = append(result, current.String())
				current.Reset()
			}
			isFirst = false
			i += size
			continue
		}

		// Start a new pre-token with space marker if not first word
		if current.Len() == 0 && !isFirst {
			current.WriteString(SpaceMarker)
		}

		// Split punctuation/symbols into their own pre-tokens
		if unicode.IsPunct(r) || unicode.IsSymbol(r) {
			// Determine if this punct directly follows whitespace
			// (current buffer is empty or only has SpaceMarker)
			punctAfterSpace := false
			if current.Len() == 0 && !isFirst {
				punctAfterSpace = true
			}

			if current.Len() > 0 {
				cs := current.String()
				if cs == SpaceMarker {
					// SpaceMarker + punct → emit as Ġ + punct
					current.WriteRune(r)
					result = append(result, current.String())
					current.Reset()
					i += size
					continue
				}
				// Flush the word before this punct
				result = append(result, cs)
				current.Reset()
			}

			// Emit punctuation as its own token
			if punctAfterSpace {
				result = append(result, SpaceMarker+string(r))
			} else {
				result = append(result, string(r))
			}
			isFirst = false
			i += size
			continue
		}

		current.WriteRune(r)
		isFirst = false
		i += size
	}

	if current.Len() > 0 {
		result = append(result, current.String())
	}

	return result
}

// splitToChars splits a pre-token into individual characters (runes).
// The Ġ prefix, if present, becomes its own character token.
func splitToChars(preToken string) []string {
	var chars []string
	for i := 0; i < len(preToken); {
		r, size := utf8.DecodeRuneInString(preToken[i:])
		chars = append(chars, string(r))
		i += size
	}
	return chars
}

// ─────────────────────────────────────────────────────────────────────
// Training
// ─────────────────────────────────────────────────────────────────────

// wordFreq tracks a pre-tokenized word and how often it appears.
type wordFreq struct {
	symbols []string // current split state (starts as chars, merges over time)
	count   int      // frequency in corpus
}

// mergeKey creates a lookup key for a pair of tokens.
func mergeKey(a, b string) string {
	return a + "\x00" + b
}

// Train learns BPE merge rules from the given corpus lines.
// Each line is treated as a separate document/sentence.
//
// The algorithm:
//  1. Pre-tokenize all lines into words
//  2. Count word frequencies
//  3. Split each word into characters (initial vocabulary)
//  4. Iteratively merge the most frequent adjacent pair
//  5. Stop when VocabSize is reached
func (t *BPETokenizer) Train(lines []string) {
	// Step 1-2: Pre-tokenize and count word frequencies
	wordCounts := make(map[string]int)
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		preTokens := PreTokenize(line)
		for _, pt := range preTokens {
			wordCounts[pt]++
		}
	}

	// Step 3: Initialize each word as character sequence
	words := make([]wordFreq, 0, len(wordCounts))
	charSet := make(map[string]bool)

	for word, count := range wordCounts {
		chars := splitToChars(word)
		if len(chars) == 0 {
			continue
		}
		words = append(words, wordFreq{symbols: chars, count: count})
		for _, ch := range chars {
			charSet[ch] = true
		}
	}

	// Build initial vocabulary: special tokens + all unique characters
	t.TokenToID = make(map[string]int)
	t.IDToToken = nil

	// Special tokens first (IDs 0-4)
	specials := []string{TokenPAD, TokenUNK, TokenBOS, TokenEOS, TokenSEP}
	for _, sp := range specials {
		id := len(t.IDToToken)
		t.IDToToken = append(t.IDToToken, sp)
		t.TokenToID[sp] = id
	}

	// Sort character tokens for deterministic ordering
	charList := make([]string, 0, len(charSet))
	for ch := range charSet {
		charList = append(charList, ch)
	}
	sort.Strings(charList)

	for _, ch := range charList {
		if _, exists := t.TokenToID[ch]; !exists {
			id := len(t.IDToToken)
			t.IDToToken = append(t.IDToToken, ch)
			t.TokenToID[ch] = id
		}
	}

	// Step 4: Iterative merging
	t.Merges = nil
	t.mergeRank = make(map[string]int)

	numMerges := t.VocabSize - len(t.IDToToken)
	if numMerges < 0 {
		numMerges = 0
	}

	for mi := 0; mi < numMerges; mi++ {
		// Count all adjacent pairs across the corpus
		pairCounts := make(map[string]int)
		for wi := range words {
			syms := words[wi].symbols
			cnt := words[wi].count
			for i := 0; i < len(syms)-1; i++ {
				key := mergeKey(syms[i], syms[i+1])
				pairCounts[key] += cnt
			}
		}

		if len(pairCounts) == 0 {
			break
		}

		// Find the most frequent pair
		bestKey := ""
		bestCount := 0
		for key, count := range pairCounts {
			if count > bestCount || (count == bestCount && key < bestKey) {
				bestCount = count
				bestKey = key
			}
		}

		if bestCount < 2 {
			break // No pair appears more than once — stop
		}

		// Parse the best pair
		parts := strings.SplitN(bestKey, "\x00", 2)
		a, b := parts[0], parts[1]
		merged := a + b

		// Record the merge rule
		t.Merges = append(t.Merges, MergePair{A: a, B: b})
		t.mergeRank[mergeKey(a, b)] = mi

		// Add merged token to vocabulary
		if _, exists := t.TokenToID[merged]; !exists {
			id := len(t.IDToToken)
			t.IDToToken = append(t.IDToToken, merged)
			t.TokenToID[merged] = id
		}

		// Apply merge to all words
		for wi := range words {
			words[wi].symbols = applyMerge(words[wi].symbols, a, b, merged)
		}

		// Progress logging every 1000 merges
		if (mi+1)%1000 == 0 {
			fmt.Printf("[BPE Train] %d / %d merges completed (vocab: %d)\n",
				mi+1, numMerges, len(t.IDToToken))
		}
	}

	fmt.Printf("[BPE Train] Complete. Final vocab size: %d, merges: %d\n",
		len(t.IDToToken), len(t.Merges))
}

// applyMerge replaces all occurrences of (a, b) in symbols with merged.
func applyMerge(symbols []string, a, b, merged string) []string {
	if len(symbols) < 2 {
		return symbols
	}
	result := make([]string, 0, len(symbols))
	i := 0
	for i < len(symbols) {
		if i < len(symbols)-1 && symbols[i] == a && symbols[i+1] == b {
			result = append(result, merged)
			i += 2
		} else {
			result = append(result, symbols[i])
			i++
		}
	}
	return result
}

// ─────────────────────────────────────────────────────────────────────
// Encoding
// ─────────────────────────────────────────────────────────────────────

// Encode converts text into a sequence of token IDs.
// Unknown characters that weren't seen during training map to <UNK>
// (char-level mode only — byte-level coverage is total by construction).
func (t *BPETokenizer) Encode(text string) []int {
	var preTokens []string
	if t.ByteLevel {
		// GPT-2 semantics: split first, then rewrite each piece into
		// the byte-unicode alphabet so every symbol is in-vocabulary.
		for _, piece := range gpt2PreTokenize(text) {
			preTokens = append(preTokens, gpt2EncodeBytes(piece))
		}
	} else {
		preTokens = PreTokenize(text)
	}
	var ids []int

	for _, pt := range preTokens {
		chars := splitToChars(pt)
		if len(chars) == 0 {
			continue
		}

		// Apply BPE merges greedily by priority
		symbols := make([]string, len(chars))
		copy(symbols, chars)
		symbols = t.applyBPEMerges(symbols)

		// Map tokens to IDs
		for _, sym := range symbols {
			if id, ok := t.TokenToID[sym]; ok {
				ids = append(ids, id)
			} else {
				ids = append(ids, t.UnkID())
			}
		}
	}

	return ids
}

// EncodeWithSpecial wraps the encoded text with <BOS> and <EOS> tokens.
// In byte-level (GPT-2) mode both roles are <|endoftext|>, matching how
// GPT-2 delimits documents.
func (t *BPETokenizer) EncodeWithSpecial(text string) []int {
	ids := t.Encode(text)
	result := make([]int, 0, len(ids)+2)
	result = append(result, t.BosID())
	result = append(result, ids...)
	result = append(result, t.EosID())
	return result
}

// applyBPEMerges applies all learned merge rules to a symbol sequence.
// Uses the priority-based approach: iteratively find the highest-priority
// (lowest rank) merge that exists in the current symbols, apply it, repeat.
func (t *BPETokenizer) applyBPEMerges(symbols []string) []string {
	for {
		if len(symbols) < 2 {
			break
		}

		// Find the pair with the lowest merge rank (highest priority)
		bestIdx := -1
		bestRank := len(t.Merges) // sentinel: worse than any real rank

		for i := 0; i < len(symbols)-1; i++ {
			key := mergeKey(symbols[i], symbols[i+1])
			if rank, ok := t.mergeRank[key]; ok && rank < bestRank {
				bestRank = rank
				bestIdx = i
			}
		}

		if bestIdx < 0 {
			break // No applicable merge found
		}

		// Apply the merge at bestIdx
		merged := symbols[bestIdx] + symbols[bestIdx+1]
		newSymbols := make([]string, 0, len(symbols)-1)
		newSymbols = append(newSymbols, symbols[:bestIdx]...)
		newSymbols = append(newSymbols, merged)
		if bestIdx+2 < len(symbols) {
			newSymbols = append(newSymbols, symbols[bestIdx+2:]...)
		}
		symbols = newSymbols
	}

	return symbols
}

// ─────────────────────────────────────────────────────────────────────
// Decoding
// ─────────────────────────────────────────────────────────────────────

// Decode converts a sequence of token IDs back into text.
// SpaceMarker (Ġ) characters are replaced with actual spaces; in
// byte-level mode the full byte alphabet is reversed instead.
func (t *BPETokenizer) Decode(ids []int) string {
	var b strings.Builder
	for _, id := range ids {
		if id < 0 || id >= len(t.IDToToken) {
			continue
		}
		token := t.IDToToken[id]
		// Skip special tokens during decode
		if token == TokenPAD || token == TokenBOS || token == TokenEOS ||
			token == TokenUNK || token == TokenSEP || token == GPT2EndOfText {
			continue
		}
		b.WriteString(token)
	}

	if t.ByteLevel {
		// Reverse the byte-unicode alphabet: Ġ→' ', Ċ→'\n', multi-byte
		// UTF-8 sequences (diacritics) reassemble byte by byte.
		return gpt2DecodeBytes(b.String())
	}

	// Replace Ġ with space
	text := b.String()
	text = strings.ReplaceAll(text, SpaceMarker, " ")

	// Trim leading space (first word doesn't have Ġ prefix)
	text = strings.TrimLeft(text, " ")

	return text
}

// DecodeTokens returns the string representation of each token ID
// without joining them — useful for debugging/inspection.
func (t *BPETokenizer) DecodeTokens(ids []int) []string {
	tokens := make([]string, 0, len(ids))
	for _, id := range ids {
		if id >= 0 && id < len(t.IDToToken) {
			tokens = append(tokens, t.IDToToken[id])
		} else {
			tokens = append(tokens, TokenUNK)
		}
	}
	return tokens
}

// ─────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────

// tokenizerJSON is the on-disk format for the tokenizer.
type tokenizerJSON struct {
	VocabSize int            `json:"vocab_size"`
	Merges    []MergePair    `json:"merges"`
	Vocab     map[string]int `json:"vocab"`
	ByteLevel bool           `json:"byte_level,omitempty"`
}

// Save writes the tokenizer to a JSON file.
func (t *BPETokenizer) Save(path string) error {
	data := tokenizerJSON{
		VocabSize: t.VocabSize,
		Merges:    t.Merges,
		Vocab:     t.TokenToID,
		ByteLevel: t.ByteLevel,
	}

	buf, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("tokenizer marshal: %w", err)
	}

	return os.WriteFile(path, buf, 0644)
}

// LoadBPETokenizer reads a tokenizer from a JSON file.
func LoadBPETokenizer(path string) (*BPETokenizer, error) {
	buf, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("tokenizer read: %w", err)
	}

	var data tokenizerJSON
	if err := json.Unmarshal(buf, &data); err != nil {
		return nil, fmt.Errorf("tokenizer unmarshal: %w", err)
	}

	// Rebuild IDToToken from Vocab — allocate based on max ID, not map length,
	// to prevent silent data loss when IDs have gaps or exceed the map size.
	maxID := 0
	for _, id := range data.Vocab {
		if id > maxID {
			maxID = id
		}
	}
	idToToken := make([]string, maxID+1)
	for token, id := range data.Vocab {
		if id >= 0 && id < len(idToToken) {
			idToToken[id] = token
		}
	}

	// Rebuild merge rank cache
	mergeRank := make(map[string]int, len(data.Merges))
	for i, m := range data.Merges {
		mergeRank[mergeKey(m.A, m.B)] = i
	}

	return &BPETokenizer{
		VocabSize: data.VocabSize,
		Merges:    data.Merges,
		TokenToID: data.Vocab,
		IDToToken: idToToken,
		mergeRank: mergeRank,
		ByteLevel: data.ByteLevel,
	}, nil
}

// ─────────────────────────────────────────────────────────────────────
// Utility Methods
// ─────────────────────────────────────────────────────────────────────

// ActualVocabSize returns the number of tokens currently in the vocabulary.
func (t *BPETokenizer) ActualVocabSize() int {
	return len(t.IDToToken)
}

// The special-role accessors below all collapse onto <|endoftext|> in
// byte-level (GPT-2) mode — that vocabulary defines no other specials,
// and GPT-2 itself uses endoftext as BOS, EOS and padding alike.

// PadID returns the ID for the <PAD> token.
func (t *BPETokenizer) PadID() int {
	if t.ByteLevel {
		return t.gpt2SpecialID()
	}
	return t.TokenToID[TokenPAD]
}

// UnkID returns the ID for the <UNK> token.
func (t *BPETokenizer) UnkID() int {
	if t.ByteLevel {
		return t.gpt2SpecialID()
	}
	return t.TokenToID[TokenUNK]
}

// BosID returns the ID for the <BOS> token.
func (t *BPETokenizer) BosID() int {
	if t.ByteLevel {
		return t.gpt2SpecialID()
	}
	return t.TokenToID[TokenBOS]
}

// EosID returns the ID for the <EOS> token.
func (t *BPETokenizer) EosID() int {
	if t.ByteLevel {
		return t.gpt2SpecialID()
	}
	return t.TokenToID[TokenEOS]
}

// SepID returns the ID for the <SEP> token.
func (t *BPETokenizer) SepID() int {
	if t.ByteLevel {
		return t.gpt2SpecialID()
	}
	return t.TokenToID[TokenSEP]
}
