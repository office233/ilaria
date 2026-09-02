package cortex

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"sync"
)

// Keyword scoring constants for RecallByKeywords / RecallByKeywordsExpanded.
const (
	// kwScorePerHit is the score contribution per direct keyword hit.
	// Set to 130 so a single content-word match exceeds the confidence
	// threshold of 128 — safe because stop words and stems are filtered.
	kwScorePerHit = 130

	// kwScorePerSecondaryHit is the score contribution per association-
	// expanded (secondary) keyword hit in RecallByKeywordsExpanded.
	// Weighted lower than primary hits so direct matches are preferred.
	kwScorePerSecondaryHit = 60
)

// ─────────────────────────────────────────────────────────────────────
// hippocampus.go — Episodic Memory System
// ─────────────────────────────────────────────────────────────────────
//
// The hippocampus is the brain's primary structure for forming and
// retrieving episodic memories — specific experiences bound to a
// temporal context. In biology, the hippocampal formation (CA1, CA3,
// dentate gyrus) performs pattern separation on input and pattern
// completion on recall, enabling one-shot learning of novel associations.
//
// This implementation stores input→output SDR associations as discrete
// Memory records. Each memory has:
//   - Strength (0–255): reinforced on repeated encoding, decayed on
//     consolidation. Models synaptic long-term potentiation (LTP).
//   - Age: incremented every consolidation cycle. Old, weak memories
//     are pruned, mirroring synaptic homeostasis during sleep.
//   - Context: a string tag for associative cuing (e.g., conversation ID).
//
// Recall is performed by SDR overlap: the query is compared against
// every stored input pattern and the best match above threshold is
// returned. This is analogous to CA3 auto-associative recall.

// Memory represents a single episodic record stored in the hippocampus.
type Memory struct {
	Input    SDR    // Sparse pattern that was observed
	Output   SDR    // Associated response pattern
	Strength uint8  // Synaptic strength (0 = weakest, 255 = strongest)
	Age      uint32 // Number of consolidation cycles since encoding
	Context  string // Contextual tag for associative cuing
}

// Hippocampus is an episodic memory store with capacity limits and
// consolidation dynamics.
type Hippocampus struct {
	mu                    sync.RWMutex
	Memories              []Memory
	MaxMemories           int
	ReconsolidationThresh uint8
	InitialStrength       uint8
	LtpThreshold          uint8

	// keywordIndex maps lowercased content keywords to the indices of
	// memories whose Context contains that keyword. This provides
	// lexical recall that avoids the false-overlap problem of
	// union-based SDR encoding on long sentences.
	keywordIndex map[string][]int

	// bitIndex maps SDR bit position → indices of memories whose Input
	// SDR has that bit active. Fix pentru §8.5 (căutare O(N) liniară):
	// permite RecallScored să scaneze doar memoriile care împart bit-uri
	// cu query-ul, în loc să compute similarity cu fiecare memorie.
	//
	// Performance: SDR sparse @ 0.5% activity (50 bits / 10000) cu 10000
	// memorii  →  ~50 × ~50 = 2500 candidate-uri verificate
	// (vs. 10000 memorii × 10000 bit-uri full scan).
	//
	// Nil-safe: dacă lipsește (legacy state file), Recall* face fallback
	// la scanare liniară veche (corectă, doar lentă).
	bitIndex map[int][]int
}

// hippoStopWords contains common function words and punctuation that
// should be excluded from the keyword index. These carry little
// discriminative meaning for memory retrieval.
//
// Stop words are language-invariant high-frequency function words.
// They are hardcoded because they are universal linguistic constants,
// not application-specific configuration. Adding/removing entries
// here has minimal impact on retrieval quality.
var hippoStopWords = map[string]bool{
	"what": true, "is": true, "the": true, "a": true, "an": true,
	"of": true, "in": true, "to": true, "and": true, "or": true,
	"for": true, "that": true, "this": true, "it": true, "are": true,
	"was": true, "were": true, "be": true, "been": true, "how": true,
	"who": true, "which": true, "?": true, ".": true,
	"does": true, "do": true, "did": true, "has": true, "have": true,
	"had": true, "will": true, "would": true, "could": true, "should": true,
	"can": true, "may": true, "might": true, "shall": true, "must": true,
	"with": true, "from": true, "by": true, "on": true, "at": true,
	"as": true, "its": true, "their": true, "our": true, "your": true,
	"his": true, "her": true, "my": true, "not": true, "no": true,
	"but": true, "if": true, "then": true, "so": true, "than": true,
	"where": true, "when": true, "why": true, "all": true, "each": true,
	"every": true, "both": true, "few": true, "more": true, "most": true,
	"other": true, "some": true, "such": true, "only": true, "own": true,
	"same": true, "also": true, "about": true, "up": true, "out": true,
	"into": true, "over": true, "after": true, "before": true,
	"between": true, "under": true, "through": true, "during": true,
	"keeps": true, "keep": true, "kept": true,

	// Romanian Stop-Words
	"care": true, "este": true, "e": true, "ce": true, "cine": true,
	"la": true, "de": true, "un": true, "o": true,
	"si": true, "sau": true, "cu": true, "din": true, "pe": true,
	"ale": true, "ai": true, "al": true, "sunt": true,
	"era": true, "fi": true, "fost": true, "pentru": true, "ca": true,
	"sa": true, "cum": true, "unde": true, "cand": true, "dece": true,
	"prin": true, "despre": true, "intre": true, "sub": true, "peste": true,
	"dupa": true, "inainte": true,
}

// stemSuffixes lists suffixes to strip, ordered longest-first
// so we greedily remove the longest applicable suffix. Supports both
// English and Romanian inflections.
//
// Suffixes for a simple Romanian+English stemmer.
// Hardcoded as they represent stable linguistic morphology rules.
// A full stemmer (Snowball) would add dependency overhead for marginal gain.
var stemSuffixes = []string{
	"isation", "ization",
	"ation", "tion", "sion",
	"ment", "ness", "able", "ible",
	"ical", "ious", "eous", "ance", "ence",
	"ului", "elor", "ilor",
	"ful", "ous", "ive", "ing", "ity",
	"est", "ism", "lor", "ele",
	"ly", "ed", "er", "es", "al", "le", "ei", "ui", "ii", "ea", "a",
}

// stemWord applies basic suffix-stripping to normalise word forms.
// It strips common English suffixes so that related word forms
// ("memories"/"memory", "consolidation"/"consolid") map to the same
// stem. The minimum stem length is 3 characters to avoid over-stemming.
func stemWord(word string) string {
	word = strings.ToLower(word)
	if len(word) <= 3 {
		return word
	}
	stem := word
	stemmed := false
	// Handle irregular plurals before suffix stripping.
	if strings.HasSuffix(word, "ies") && len(word) > 4 {
		if s := word[:len(word)-3] + "i"; len(s) >= 2 { // memories → memori
			stem, stemmed = s, true
		}
	}
	if !stemmed {
		for _, suffix := range stemSuffixes {
			if strings.HasSuffix(word, suffix) {
				if s := word[:len(word)-len(suffix)]; len(s) >= 3 {
					stem, stemmed = s, true
					break
				}
			}
		}
	}
	// Strip trailing 's' for simple plurals (but not if stem < 3).
	if !stemmed && strings.HasSuffix(stem, "s") && len(stem) > 3 {
		stem = stem[:len(stem)-1]
	}
	// Final normalisation: drop a trailing 'e' so base forms meet their
	// suffix-stripped inflections on the same stem — without this,
	// "dances" stems to "danc" ("es" rule) while "dance" keeps its 'e',
	// and a question about dancing never recalls the dancing memory.
	// (Root cause of the 3 recall misses in the first continual-bench.)
	if strings.HasSuffix(stem, "e") && len(stem) > 3 {
		stem = stem[:len(stem)-1]
	}
	// Same idea for 'y': "memory" must meet "memories", whose "ies"
	// rule already lands on "memori".
	if strings.HasSuffix(stem, "y") && len(stem) > 3 {
		stem = stem[:len(stem)-1] + "i"
	}
	return stem
}

// extractKeywords tokenises a context string and returns the unique,
// stemmed, lowercased content words (stop words removed).
func extractKeywords(context string) []string {
	tokens := Tokenize(context)
	seen := make(map[string]bool, len(tokens))
	var kw []string
	for _, t := range tokens {
		t = strings.ToLower(t)
		if hippoStopWords[t] || t == "" {
			continue
		}
		stem := stemWord(t)
		if seen[stem] {
			continue
		}
		seen[stem] = true
		kw = append(kw, stem)
	}
	return kw
}

// NewHippocampus creates a hippocampus with the given config.
func NewHippocampus(cfg Config) *Hippocampus {
	return &Hippocampus{
		Memories:              make([]Memory, 0, cfg.MaxMemories),
		MaxMemories:           cfg.MaxMemories,
		ReconsolidationThresh: cfg.HippoReconsolidationThresh,
		InitialStrength:       cfg.HippoInitialStrength,
		LtpThreshold:          cfg.HippoLtpThreshold,
		keywordIndex:          make(map[string][]int),
	}
}

// ─────────────────────────────────────────────────────────────────────
// Store — Encode a new episodic memory
// ─────────────────────────────────────────────────────────────────────

// Store encodes an input→output association into episodic memory.
//
// If a highly similar memory already exists (overlap ≥ ReconconsolidationThresh),
// the existing memory is strengthened rather than creating a duplicate. This
// models reconsolidation — the biological process where retrieving a memory
// makes it labile and allows it to be updated.
//
// When the store is full, the weakest (lowest-strength) memory is
// evicted to make room, modeling synaptic homeostasis.
//
// The similarity threshold, initial strength, and LTP threshold are dynamic.
func (h *Hippocampus) Store(input SDR, output SDR, context string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Ensure the keyword index map is initialised (may be nil after
	// deserialisation from an older file format).
	if h.keywordIndex == nil {
		h.keywordIndex = make(map[string][]int)
	}

	// Check for an existing similar memory to reconsolidate.
	// Scanare liniară — empiric mai rapidă decât bitIndex pentru
	// N ≤ 50k (vezi nota la RecallScored).
	for i := range h.Memories {
		sim := h.Memories[i].Input.Similarity(input)
		if sim >= h.ReconsolidationThresh {
			// Reconsolidate: strengthen and update.
			if h.Memories[i].Strength < 255 {
				h.Memories[i].Strength++
			}
			oldContext := h.Memories[i].Context
			h.Memories[i].Output = output.Clone()
			h.Memories[i].Context = context
			h.Memories[i].Age = 0

			// Update keyword index: remove old keywords, add new.
			if oldContext != context {
				h.removeKeywordsForIndex(i, oldContext)
				h.addKeywordsForIndex(i, context)
			}
			// Input nu se schimbă la reconsolidare → bitIndex rămâne valid.
			return
		}
	}

	// Evict weakest memory if at capacity.
	if len(h.Memories) >= h.MaxMemories && h.MaxMemories > 0 {
		weakest := 0
		for i := 1; i < len(h.Memories); i++ {
			if h.Memories[i].Strength < h.Memories[weakest].Strength {
				weakest = i
			}
		}
		// Remove evicted memory's keywords AND bit-uri (dacă indexul există).
		h.removeKeywordsForIndex(weakest, h.Memories[weakest].Context)
		if h.bitIndex != nil {
			h.removeBitsForIndex(weakest, h.Memories[weakest].Input)
		}

		// Replace the weakest entry in-place.
		h.Memories[weakest] = Memory{
			Input:    input.Clone(),
			Output:   output.Clone(),
			Strength: h.InitialStrength,
			Age:      0,
			Context:  context,
		}
		// Add new memory's keywords AND bit-uri (dacă indexul există).
		h.addKeywordsForIndex(weakest, context)
		if h.bitIndex != nil {
			h.addBitsForIndex(weakest, h.Memories[weakest].Input)
		}
		// Eviction may leave stale entries in the keyword index;
		// rebuild to keep it consistent.
		h.rebuildKeywordIndexLocked()
		return
	}

	idx := len(h.Memories)
	h.Memories = append(h.Memories, Memory{
		Input:    input.Clone(),
		Output:   output.Clone(),
		Strength: h.InitialStrength,
		Age:      0,
		Context:  context,
	})
	h.addKeywordsForIndex(idx, context)
	// bitIndex e opt-in: dacă există (a fost construit explicit via
	// EnableBitIndex sau prin Load), îl actualizăm. Altfel rămâne nil
	// pentru a evita overhead-ul map allocations pentru workload-uri tipice.
	if h.bitIndex != nil {
		h.addBitsForIndex(idx, h.Memories[idx].Input)
	}
}

// EnableBitIndex construiește bitIndex-ul pentru toate memoriile existente.
// Caller-ul îl folosește când vrea să rute reorientările prin RecallScoredIndexed
// (workload-uri cu N foarte mare sau SDR-uri foarte mari).
func (h *Hippocampus) EnableBitIndex() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.rebuildBitIndexLocked()
}

// ─────────────────────────────────────────────────────────────────────
// Recall — Pattern-completion retrieval
// ─────────────────────────────────────────────────────────────────────

// Recall finds the single best-matching memory whose similarity to
// the query is at or above the given threshold. Returns the memory
// and true if found, or a zero Memory and false otherwise.
//
// This models CA3 auto-associative recall: a partial cue is completed
// by the stored attractor pattern with the highest overlap.
func (h *Hippocampus) Recall(query SDR, threshold uint8) (Memory, bool) {
	mem, _, ok := h.RecallScored(query, threshold)
	return mem, ok
}

// RecallScored returns the best matching memory together with its similarity
// score. Callers that expose confidence should use this score instead of
// treating any recall above threshold as perfect certainty.
//
// Notă despre §8.5 din auditul HARDCODING_AND_LIMITATIONS.md:
//
// Auditul a marcat această scanare ca problemă de scalabilitate O(N).
// Empiric (vezi BenchmarkHippocampusRecall), pentru N ≤ ~50.000 memorii
// scanarea liniară este DE FAPT MAI RAPIDĂ decât orice inverted index
// pe bit-uri SDR, deoarece SDR.Similarity este bitwise pe uint64 (extrem
// de cache-friendly, ~ns per memorie). Map allocation/iteration peste
// candidate dominează costul pentru N tipic (MaxMemories default = 10k).
//
// bitIndex EXISTĂ (vezi câmpul Hippocampus.bitIndex) și e menținut în
// Store/eviction, dar NU este folosit aici. Rămâne disponibil pentru:
//   - Reconsolidation lookup în Store (unde plata one-time merită)
//   - Future-proof: dacă MaxMemories crește >> 50k sau SDR-urile devin
//     mult mai dense, putem activa fast-path-ul (există RecallScoredIndexed).
//
// Pentru workload-uri actuale: scanarea liniară pe uint64-uri este
// alegerea optimă. "O(N) liniar" e adevărat asimptotic, dar pe constante
// hardware moderne înseamnă < 1 ms pentru 10k memorii × 1000 bit-uri.
func (h *Hippocampus) RecallScored(query SDR, threshold uint8) (Memory, uint8, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	var bestSim uint8
	bestIdx := -1

	for i := range h.Memories {
		sim := h.Memories[i].Input.Similarity(query)
		if sim >= threshold && sim > bestSim {
			bestSim = sim
			bestIdx = i
		}
	}

	if bestIdx < 0 {
		return Memory{}, 0, false
	}
	return h.Memories[bestIdx], bestSim, true
}

// RecallScoredIndexed este varianta care folosește bitIndex pentru a
// restrânge scanarea la memoriile care împart cel puțin un bit activ cu
// query-ul. Pe workload-uri tipice (N ≤ 50k, sparsity 0.5%) este MAI
// LENTĂ decât RecallScored din cauza map overhead — vezi benchmark.
//
// Devine câștigătoare doar pentru:
//   - N foarte mare (≥ 100k memorii)
//   - SDR-uri mari (≥ 100k biți)
//   - Sparsity foarte joasă (< 0.1%)
//
// Threshold == 0 forțează scanare liniară (orice memorie poate fi best
// match indiferent de overlap). Returnează același rezultat ca
// RecallScored — testul TestHippocampus_BitIndexCorrectness validează.
func (h *Hippocampus) RecallScoredIndexed(query SDR, threshold uint8) (Memory, uint8, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if threshold == 0 || h.bitIndex == nil {
		// Fallback la scanare liniară — nu putem restrânge fără pierdere.
		var bestSim uint8
		bestIdx := -1
		for i := range h.Memories {
			sim := h.Memories[i].Input.Similarity(query)
			if sim >= threshold && sim > bestSim {
				bestSim = sim
				bestIdx = i
			}
		}
		if bestIdx < 0 {
			return Memory{}, 0, false
		}
		return h.Memories[bestIdx], bestSim, true
	}

	candidates := h.recallCandidatesLocked(query)
	var bestSim uint8
	bestIdx := -1
	for memIdx := range candidates {
		sim := h.Memories[memIdx].Input.Similarity(query)
		if sim >= threshold && sim > bestSim {
			bestSim = sim
			bestIdx = memIdx
		}
	}
	if bestIdx < 0 {
		return Memory{}, 0, false
	}
	return h.Memories[bestIdx], bestSim, true
}

// RecallByKeywords performs keyword-based retrieval as a complement to
// SDR similarity matching. It finds memories whose Context shares the
// most keywords with the query, and among ties picks the one with the
// highest SDR similarity to the query.
//
// threshold is the minimum number of shared keywords required for a
// match. Returns the best memory, a combined score (0-255), and
// whether a match was found.
func (h *Hippocampus) RecallByKeywords(keywords []string, threshold int, query SDR) (Memory, uint8, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if len(keywords) == 0 || len(h.Memories) == 0 {
		return Memory{}, 0, false
	}
	if h.keywordIndex == nil {
		return Memory{}, 0, false
	}

	// Count how many query keywords each memory matches.
	// Keywords are stemmed to match the stemmed index.
	hits := make(map[int]int) // memoryIndex → keyword overlap count
	queryKeywords := 0
	for _, kw := range keywords {
		kw = strings.ToLower(kw)
		if hippoStopWords[kw] {
			continue
		}
		queryKeywords++
		stem := stemWord(kw)
		for _, idx := range h.keywordIndex[stem] {
			hits[idx]++
		}
	}

	bestIdx := -1
	bestHits := 0
	var bestSim uint8

	for idx, count := range hits {
		if count < threshold {
			continue
		}
		sim := h.Memories[idx].Input.Similarity(query)
		if count > bestHits || (count == bestHits && sim > bestSim) {
			bestIdx = idx
			bestHits = count
			bestSim = sim
		}
	}

	if bestIdx < 0 {
		return Memory{}, 0, false
	}

	// Compute a combined score using distinct hit count.
	// 1 hit → kwScorePerHit, 2 hits → 200+, ensuring even a single
	// content-word match can pass the confidence threshold (128).
	// This is safe because stop words are filtered and words are stemmed.
	kwScore := bestHits * kwScorePerHit
	if kwScore > 200 {
		kwScore = 200
	}
	sdrPart := int(bestSim) * 55 / 255
	combined := kwScore + sdrPart
	if combined > 255 {
		combined = 255
	}

	return h.Memories[bestIdx], uint8(combined), true
}

// RecallByKeywordsExpanded performs keyword-based retrieval with
// semantic expansion via Brain word associations. For each query
// keyword, it looks up the Brain's top associations and adds them as
// secondary keywords with fractional weight. This enables matching
// rephrased queries like "personal event memories" against stored
// memories about "episodic memories".
//
// The expansion weights secondary (associated) keyword hits at 0.5×
// compared to direct keyword hits, so direct matches are always
// preferred.
func (h *Hippocampus) RecallByKeywordsExpanded(keywords []string, threshold int, query SDR, brain *Brain) (Memory, uint8, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if len(keywords) == 0 || len(h.Memories) == 0 {
		return Memory{}, 0, false
	}
	if h.keywordIndex == nil {
		return Memory{}, 0, false
	}

	// Phase 1: Expand query keywords using Brain associations.
	// Each keyword is stemmed and looked up; associated words are
	// added as secondary terms with lower weight.
	type weightedKeyword struct {
		stem   string
		weight int // 2 = primary, 1 = secondary (from association)
	}

	seen := make(map[string]bool)
	var expanded []weightedKeyword

	for _, kw := range keywords {
		kw = strings.ToLower(kw)
		if hippoStopWords[kw] {
			continue
		}
		stem := stemWord(kw)
		if !seen[stem] {
			seen[stem] = true
			expanded = append(expanded, weightedKeyword{stem: stem, weight: 2})
		}

		// Look up Brain associations for this keyword.
		if brain != nil {
			assocWords := getTopAssociations(brain, kw, 5)
			for _, aw := range assocWords {
				awStem := stemWord(aw)
				if !seen[awStem] && !hippoStopWords[aw] {
					seen[awStem] = true
					expanded = append(expanded, weightedKeyword{stem: awStem, weight: 1})
				}
			}
		}
	}

	if len(expanded) == 0 {
		return Memory{}, 0, false
	}

	// Phase 2: Score each memory by weighted keyword overlap.
	hits := make(map[int]int) // memoryIndex → weighted hit count
	for _, wk := range expanded {
		for _, idx := range h.keywordIndex[wk.stem] {
			hits[idx] += wk.weight
		}
	}

	// The effective threshold is doubled because primary keywords have weight 2.
	effectiveThreshold := threshold * 2

	bestIdx := -1
	bestHits := 0
	var bestSim uint8

	for idx, count := range hits {
		if count < effectiveThreshold {
			continue
		}
		sim := h.Memories[idx].Input.Similarity(query)
		if count > bestHits || (count == bestHits && sim > bestSim) {
			bestIdx = idx
			bestHits = count
			bestSim = sim
		}
	}

	if bestIdx < 0 {
		return Memory{}, 0, false
	}

	// Compute combined score. Primary keyword hits contribute 80 points
	// each, secondary (association-expanded) hits contribute 40 points.
	// This rewards the absolute number of matches rather than ratio.
	primaryHits := 0
	secondaryHits := 0
	for _, wk := range expanded {
		if wk.weight == 2 {
			for _, idx := range h.keywordIndex[wk.stem] {
				if idx == bestIdx {
					primaryHits++
					break
				}
			}
		} else {
			for _, idx := range h.keywordIndex[wk.stem] {
				if idx == bestIdx {
					secondaryHits++
					break
				}
			}
		}
	}
	kwScore := primaryHits*kwScorePerHit + secondaryHits*kwScorePerSecondaryHit
	if kwScore > 200 {
		kwScore = 200
	}
	sdrPart := int(bestSim) * 55 / 255
	combined := kwScore + sdrPart
	if combined > 255 {
		combined = 255
	}

	return h.Memories[bestIdx], uint8(combined), true
}

// getTopAssociations returns the top-N associated words for a given
// keyword from the Brain's synapse map. It sorts by synapse weight
// and returns the decoded word strings.
func getTopAssociations(brain *Brain, word string, topN int) []string {
	if brain == nil || brain.Vocab == nil {
		return nil
	}

	brain.mu.RLock()
	defer brain.mu.RUnlock()

	wordID := brain.Vocab.Get(word)
	if wordID == 0 {
		return nil
	}

	synapses := brain.Synapses[wordID]
	if len(synapses) == 0 {
		return nil
	}

	// Sort by weight descending.
	type scoredSyn struct {
		target uint32
		weight uint16
	}
	scored := make([]scoredSyn, 0, len(synapses))
	for _, s := range synapses {
		if s.Flags&SynFlagActive != 0 && s.Weight > 0 {
			scored = append(scored, scoredSyn{s.Target, s.Weight})
		}
	}
	sort.Slice(scored, func(i, j int) bool {
		return scored[i].weight > scored[j].weight
	})

	if len(scored) > topN {
		scored = scored[:topN]
	}

	result := make([]string, 0, len(scored))
	for _, s := range scored {
		w := brain.Vocab.Decode(s.target)
		if w != "<UNK>" && w != word {
			result = append(result, w)
		}
	}
	return result
}

// addKeywordsForIndex adds the keywords extracted from context to the
// keyword index, pointing at the given memory index.
func (h *Hippocampus) addKeywordsForIndex(idx int, context string) {
	for _, kw := range extractKeywords(context) {
		h.keywordIndex[kw] = append(h.keywordIndex[kw], idx)
	}
}

// removeKeywordsForIndex removes entries for the given memory index
// from the keyword index based on the old context string.
func (h *Hippocampus) removeKeywordsForIndex(idx int, context string) {
	for _, kw := range extractKeywords(context) {
		indices := h.keywordIndex[kw]
		for j := 0; j < len(indices); j++ {
			if indices[j] == idx {
				indices[j] = indices[len(indices)-1]
				indices = indices[:len(indices)-1]
				break
			}
		}
		if len(indices) == 0 {
			delete(h.keywordIndex, kw)
		} else {
			h.keywordIndex[kw] = indices
		}
	}
}

// RebuildKeywordIndex reconstructs the keyword index from all stored
// memories. Called after loading from disk or after consolidation
// (which may delete and reorder memories).
func (h *Hippocampus) RebuildKeywordIndex() {
	// Note: callers that already hold the lock (e.g. Consolidate) call
	// rebuildKeywordIndexLocked instead.
	h.mu.Lock()
	defer h.mu.Unlock()
	h.rebuildKeywordIndexLocked()
}

func (h *Hippocampus) rebuildKeywordIndexLocked() {
	h.keywordIndex = make(map[string][]int, len(h.Memories))
	for i := range h.Memories {
		h.addKeywordsForIndex(i, h.Memories[i].Context)
	}
}

// ─────────────────────────────────────────────────────────────────────
// Consolidate — Sleep-like memory maintenance
// ─────────────────────────────────────────────────────────────────────

// Consolidate performs one cycle of memory maintenance, analogous to
// the memory consolidation that occurs during slow-wave sleep:
//
//  1. Age: every memory's age counter is incremented.
//  2. Strengthen: memories with strength ≥ LtpThreshold are further reinforced
//     (capped at 255), modeling LTP stabilization of strong traces.
//  3. Prune: memories with strength ≤ 1 are removed, modeling synaptic
//     homeostatic downscaling of insignificant traces.
//  4. Decay: all remaining memories lose 1 point of strength, modeling
//     the natural forgetting curve.
func (h *Hippocampus) Consolidate() {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Track which memories were strengthened this cycle to avoid
	// canceling LTP with decay in the same tick (was net-zero before).
	strengthened := make([]bool, len(h.Memories))

	// Phase 1 & 2: age and strengthen strong memories.
	for i := range h.Memories {
		h.Memories[i].Age++

		// Reinforce strong memories (LTP stabilization).
		if h.Memories[i].Strength >= h.LtpThreshold && h.Memories[i].Strength < 255 {
			h.Memories[i].Strength++
			strengthened[i] = true
		}
	}

	// Phase 3: prune weak memories.
	// Use fresh allocation to avoid slice aliasing (old pattern
	// h.Memories[:0] reused the backing array, leaking SDR []uint64 fields).
	alive := make([]Memory, 0, len(h.Memories))
	aliveStrengthened := make([]bool, 0, len(h.Memories))
	for i := range h.Memories {
		if h.Memories[i].Strength > 1 {
			alive = append(alive, h.Memories[i])
			aliveStrengthened = append(aliveStrengthened, strengthened[i])
		}
	}
	h.Memories = alive

	// Phase 4: decay all remaining memories (skip those just strengthened).
	for i := range h.Memories {
		if !aliveStrengthened[i] && h.Memories[i].Strength > 0 {
			h.Memories[i].Strength--
		}
	}

	// Rebuild the keyword index because pruning changed memory indices.
	h.rebuildKeywordIndexLocked()
}

// Size returns the number of memories currently stored.
func (h *Hippocampus) Size() int {
	return len(h.Memories)
}

// KeywordFrequency returns how many memories contain the given stem
// in the keyword index. Used by the fast-path-veto collapse detector
// in organism.go to identify SDR-collapse fingerprints by rare-token
// absence. Returns 0 when the keyword index has no entry for the
// stem (treat as "unseen" — caller decides what to do).
//
// Read-locked. Caller passes the already-stemmed form to avoid
// re-doing work and to stay consistent with how the index was built.
func (h *Hippocampus) KeywordFrequency(stem string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.keywordIndex == nil {
		return 0
	}
	return len(h.keywordIndex[stem])
}

// GetAllContexts returns all stored memory context strings.
// Used by self-training to replay memories through the Transformer.
func (h *Hippocampus) GetAllContexts() []string {
	contexts := make([]string, 0, len(h.Memories))
	for i := range h.Memories {
		if h.Memories[i].Context != "" {
			contexts = append(contexts, h.Memories[i].Context)
		}
	}
	return contexts
}

// ─────────────────────────────────────────────────────────────────────
// Persistence — Save / Load
// ─────────────────────────────────────────────────────────────────────
//
// Binary format (little-endian):
//   [4B  MaxMemories]
//   [4B  MemoryCount]
//   For each memory:
//     [4B  Input.Size]
//     [4B  len(Input.Bits)*8  (byte count)]
//     [... Input packed bytes]
//     [4B  Output.Size]
//     [4B  len(Output.Bits)*8 (byte count)]
//     [... Output packed bytes]
//     [1B  Strength]
//     [4B  Age]
//     [4B  len(Context)]
//     [... Context bytes]

// Save serializes the hippocampus to a binary file at the given path.
func (h *Hippocampus) Save(path string) error {
	h.mu.RLock()
	defer h.mu.RUnlock()

	tmpPath := path + ".tmp"
	f, err := os.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("hippocampus save: %w", err)
	}

	// Header.
	if err := binary.Write(f, binary.LittleEndian, int32(h.MaxMemories)); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := binary.Write(f, binary.LittleEndian, int32(len(h.Memories))); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return err
	}

	for i := range h.Memories {
		m := &h.Memories[i]

		// Input SDR.
		if err := writeSDR(f, m.Input); err != nil {
			f.Close()
			os.Remove(tmpPath)
			return err
		}
		// Output SDR.
		if err := writeSDR(f, m.Output); err != nil {
			f.Close()
			os.Remove(tmpPath)
			return err
		}

		// Strength.
		if err := binary.Write(f, binary.LittleEndian, m.Strength); err != nil {
			f.Close()
			os.Remove(tmpPath)
			return err
		}
		// Age.
		if err := binary.Write(f, binary.LittleEndian, m.Age); err != nil {
			f.Close()
			os.Remove(tmpPath)
			return err
		}
		// Context string.
		ctx := []byte(m.Context)
		if err := binary.Write(f, binary.LittleEndian, int32(len(ctx))); err != nil {
			f.Close()
			os.Remove(tmpPath)
			return err
		}
		if _, err := f.Write(ctx); err != nil {
			f.Close()
			os.Remove(tmpPath)
			return err
		}
	}

	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("hippocampus sync: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("hippocampus close: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("hippocampus rename: %w", err)
	}
	return nil
}

// LoadHippocampus deserializes a hippocampus from a binary file.
// An optional Config can be passed to restore threshold fields that
// are not persisted in the binary format.
func LoadHippocampus(path string, cfgs ...Config) (*Hippocampus, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("hippocampus load: %w", err)
	}
	defer f.Close()

	var maxMem, count int32
	if err := binary.Read(f, binary.LittleEndian, &maxMem); err != nil {
		return nil, err
	}
	if err := binary.Read(f, binary.LittleEndian, &count); err != nil {
		return nil, err
	}

	// Safety: reject absurdly large counts to prevent OOM from corrupted files.
	const MaxMemoryCount int32 = 1_000_000
	if count > MaxMemoryCount || count < 0 {
		return nil, fmt.Errorf("memory count %d exceeds safety limit %d", count, MaxMemoryCount)
	}
	if maxMem < 0 {
		return nil, fmt.Errorf("invalid maxMemories: %d", maxMem)
	}

	h := &Hippocampus{
		Memories:    make([]Memory, count),
		MaxMemories: int(maxMem),
	}

	// Apply config thresholds if provided
	if len(cfgs) > 0 {
		cfg := cfgs[0]
		h.MaxMemories = cfg.MaxMemories
		h.ReconsolidationThresh = cfg.HippoReconsolidationThresh
		h.InitialStrength = cfg.HippoInitialStrength
		h.LtpThreshold = cfg.HippoLtpThreshold
	}

	for i := int32(0); i < count; i++ {
		m := &h.Memories[i]

		var err error
		m.Input, err = readSDR(f)
		if err != nil {
			return nil, err
		}
		m.Output, err = readSDR(f)
		if err != nil {
			return nil, err
		}

		if err := binary.Read(f, binary.LittleEndian, &m.Strength); err != nil {
			return nil, err
		}
		if err := binary.Read(f, binary.LittleEndian, &m.Age); err != nil {
			return nil, err
		}

		var ctxLen int32
		if err := binary.Read(f, binary.LittleEndian, &ctxLen); err != nil {
			return nil, err
		}
		const MaxContextLen int32 = 1_000_000
		if ctxLen < 0 || ctxLen > MaxContextLen {
			return nil, fmt.Errorf("context length %d exceeds safety limit %d", ctxLen, MaxContextLen)
		}
		ctxBuf := make([]byte, ctxLen)
		if _, err := io.ReadFull(f, ctxBuf); err != nil {
			return nil, err
		}
		m.Context = string(ctxBuf)
	}

	// Rebuild the keyword index from the loaded memories.
	h.RebuildKeywordIndex()

	return h, nil
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers for SDR binary I/O
// ─────────────────────────────────────────────────────────────────────

func writeSDR(w io.Writer, sdr SDR) error {
	packed := sdr.PackBytes()
	if err := binary.Write(w, binary.LittleEndian, int32(sdr.Size)); err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, int32(len(packed))); err != nil {
		return err
	}
	_, err := w.Write(packed)
	return err
}

func readSDR(r io.Reader) (SDR, error) {
	var size, byteLen int32
	if err := binary.Read(r, binary.LittleEndian, &size); err != nil {
		return SDR{}, err
	}
	if err := binary.Read(r, binary.LittleEndian, &byteLen); err != nil {
		return SDR{}, err
	}

	// Safety: reject absurdly large or negative dimensions to prevent OOM / panic.
	const MaxSDRSize int32 = 1_000_000
	const MaxSDRByteLen int32 = 200_000
	if size > MaxSDRSize || size < 0 || byteLen > MaxSDRByteLen || byteLen < 0 {
		return SDR{}, fmt.Errorf("SDR size %d or byte length %d exceeds safety limits", size, byteLen)
	}

	data := make([]byte, byteLen)
	if _, err := io.ReadFull(r, data); err != nil {
		return SDR{}, err
	}
	return UnpackBytes(data, int(size)), nil
}

// ─────────────────────────────────────────────────────────────────────
// bitIndex — inverted index pe bit-uri active pentru recall O(activeBits)
// ─────────────────────────────────────────────────────────────────────
//
// Vezi explicația în struct Hippocampus.bitIndex.
//
// Toate metodele de mai jos presupun că mutex-ul h.mu este DEJA HELD
// (Lock pentru add/remove, RLock pentru read). Caller-ul este responsabil.

// addBitsForIndex înregistrează memoria de la `memIdx` în bitIndex pentru
// fiecare bit activ din inputul ei.
func (h *Hippocampus) addBitsForIndex(memIdx int, input SDR) {
	if h.bitIndex == nil {
		h.bitIndex = make(map[int][]int)
	}
	for _, b := range input.ActiveIndices() {
		h.bitIndex[b] = append(h.bitIndex[b], memIdx)
	}
}

// removeBitsForIndex scoate memoria `memIdx` din toate listele bit-urilor
// pe care le ocupa în input. Folosit la reconsolidare (input se schimbă) și
// la eviction.
func (h *Hippocampus) removeBitsForIndex(memIdx int, input SDR) {
	if h.bitIndex == nil {
		return
	}
	for _, b := range input.ActiveIndices() {
		list := h.bitIndex[b]
		for i, idx := range list {
			if idx == memIdx {
				// Compact list: swap-with-last + truncate (ordinea nu contează).
				list[i] = list[len(list)-1]
				list = list[:len(list)-1]
				break
			}
		}
		if len(list) == 0 {
			delete(h.bitIndex, b)
		} else {
			h.bitIndex[b] = list
		}
	}
}

// rebuildBitIndexLocked reconstruiește bitIndex din scratch peste toate
// memoriile actuale. Folosit la load din disk și după operațiuni bulk
// (eviction + reinserare) care pot lăsa indexul inconsistent.
func (h *Hippocampus) rebuildBitIndexLocked() {
	h.bitIndex = make(map[int][]int, len(h.Memories)*8)
	for i := range h.Memories {
		for _, b := range h.Memories[i].Input.ActiveIndices() {
			h.bitIndex[b] = append(h.bitIndex[b], i)
		}
	}
}

// recallCandidatesLocked returnează lista candidaților probabili pentru
// query (memorii care împart cel puțin un bit activ cu query). Garantează
// că NICIO memorie cu similaritate ≥ threshold nu este omisă:
//
//	Similarity(a, b) = popcount(a AND b) * 255 / max(popcount(a), popcount(b))
//
// Dacă a AND b == 0 (zero bit-uri comune), similarity = 0, deci memoria
// nu poate trece de threshold > 0. Așadar restrângerea la "împart cel
// puțin un bit" este safe atâta timp cât threshold > 0.
//
// Returnează nil dacă bitIndex e nil (caller-ul face fallback la O(N)).
func (h *Hippocampus) recallCandidatesLocked(query SDR) map[int]struct{} {
	if h.bitIndex == nil {
		return nil
	}
	candidates := make(map[int]struct{})
	for _, b := range query.ActiveIndices() {
		for _, memIdx := range h.bitIndex[b] {
			candidates[memIdx] = struct{}{}
		}
	}
	return candidates
}

