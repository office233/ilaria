package cortex

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// ─────────────────────────────────────────────────────────────────────
// semantic_memory.go — Concept Generalization and Neocortical Abstraction
// ─────────────────────────────────────────────────────────────────────
//
// In biological brains, episodic memories are temporarily stored in the
// hippocampus. During sleep/consolidation, these memories are transferred
// to the neocortex. In this process, specific temporal details are decayed,
// and overlapping features are extracted to form invariant, generalized
// semantic concepts (e.g. abstract categories rather than specific events).
//
// This module implements this abstraction layer. It scans the Hippocampus
// episodic records, identifies memories with highly similar input SDRs,
// and performs bitwise intersections. The common active bits that remain
// represent the core invariant features — the generalized "Concept".
//
// Concepts are persistent and grow stronger/more generalized as the
// organism encounters more overlapping episodes.

// Concept represents an abstracted category or invariant prototype.
type Concept struct {
	Prototype   SDR      `json:"-"`        // Invariant active bits (excluded from default JSON; Save/Load use custom binary encoding)
	Count       int      `json:"count"`    // Number of episodic memories that formed this concept
	Contexts    []string `json:"contexts"` // List of unique contextual prompts/words associated with it
}

// SemanticMemory holds the collection of generalized neocortical concepts.
type SemanticMemory struct {
	mu           sync.Mutex
	Concepts     []Concept `json:"concepts"`
	SDRSize      int       `json:"sdr_size"`
	SimThreshold uint8     `json:"sim_threshold"` // Similarity threshold for concept match (default 80)
	Config       Config    `json:"-"`
}

// NewSemanticMemory instantiates a new empty semantic memory.
// Accepts an optional Config to set the similarity threshold.
func NewSemanticMemory(sdrSize int, cfgs ...Config) *SemanticMemory {
	var simThresh uint8 = 80
	var cfg Config
	if len(cfgs) > 0 {
		cfg = cfgs[0]
		if cfg.SemanticMemorySimThreshold > 0 {
			simThresh = cfg.SemanticMemorySimThreshold
		}
	} else {
		cfg = DefaultConfig()
	}
	return &SemanticMemory{
		Concepts:     make([]Concept, 0),
		SDRSize:      sdrSize,
		SimThreshold: simThresh,
		Config:       cfg,
	}
}

// ─────────────────────────────────────────────────────────────────────
// Generalize — Extract semantic concepts from episodic records
// ─────────────────────────────────────────────────────────────────────

// Generalize scans the episodic memories currently stored in the hippocampus
// and abstracts concepts from highly similar patterns.
//
// 1. Matches episodes with existing concepts (similarity >= SimThreshold).
//    If matched, it intersects the existing prototype with the episode to
//    refine the invariant features.
// 2. Finds remaining unmatched episodes that are highly similar to each other
//    and creates new concepts from their intersection.
func (sm *SemanticMemory) Generalize(hip *Hippocampus) {
	if hip == nil || len(hip.Memories) == 0 {
		return
	}

	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Use configurable similarity threshold (set by constructor or loader).
	simThreshold := sm.SimThreshold

	mergedMemories := make(map[int]bool)

	// Phase 1: Try to merge episodic memories into existing concepts.
	for mIdx, m := range hip.Memories {
		bestConceptIdx := -1
		var bestSim uint8 = 0

		for cIdx, c := range sm.Concepts {
			sim := m.Input.Similarity(c.Prototype)
			if sim >= simThreshold && sim > bestSim {
				bestSim = sim
				bestConceptIdx = cIdx
			}
		}

		if bestConceptIdx != -1 {
			c := &sm.Concepts[bestConceptIdx]
			// CONFIDENCE-WEIGHTED MERGE (fix pentru bug-ul de identitate
			// matematică documentat în HARDCODING_AND_LIMITATIONS.md §8.1):
			//
			// Istoric:
			//   v1 (broken): c.Prototype = Prototype ∩ Input
			//                → Prototype ∪ (Prototype ∩ Input) ≡ Prototype
			//                  matematic identitate: conceptul nu învață NICI
			//                  un bit nou; în plus, șterge bit-uri istorice
			//                  pe care episodul nu le are → SDR-uri vide.
			//   v2 (overcorrected): c.Prototype = Prototype ∪ Input
			//                → Conceptul tânăr absoarbe ORICE bit din orice
			//                  episod peste prag → prototype gonflat cu zgomot.
			//                  Densitate crește necontrolat (până la ~ActiveCount
			//                  total al SDR-ului), distrugând discriminarea.
			//
			// v3 (acum): merge stratificat în funcție de încredere.
			//   - Bit-uri în AMBELE (intersect) → reinforcement, păstrate.
			//   - Bit-uri doar în prototip → păstrate (decay lent biologic;
			//     neocortexul nu uită brusc ce a învățat odată).
			//   - Bit-uri doar în episod → ABSORBITE NUMAI dacă:
			//       (a) conceptul e tânăr (Count < maturityThresh) ȘI
			//       (b) similaritatea episode↔prototype e high-confidence
			//           (cu un buffer peste pragul de merge minim).
			//     Altfel sunt ignorate ca zgomot.
			//   - Concepte mature: prototype-ul este IMUTABIL, episodul doar
			//     incrementează Count (validare statistică, nu modificare).
			//
			// Acest design garantează:
			//   - Conceptele POT crește (învață noi invarianți) — fix v1.
			//   - Conceptele NU pot crește necontrolat — fix v2.
			//   - Conceptele mature converg la prototip stabil — biologic.
			maturityThresh := sm.Config.SemanticMemoryConceptMaturity
			if maturityThresh <= 0 {
				maturityThresh = 10
			}
			if c.Count < maturityThresh {
				// Buffer de încredere peste pragul minim de merge. Doar
				// episoadele cu similaritate notabil peste prag (nu doar
				// "abia trec") au voie să adauge bit-uri noi în prototip.
				// 0.5 * (255 - simThreshold) e centrul intervalului dintre
				// pragul minim și matchul perfect.
				confidenceBuffer := uint8((255 - uint16(simThreshold)) / 2)
				highConfidenceThresh := simThreshold
				if uint16(simThreshold)+uint16(confidenceBuffer) < 255 {
					highConfidenceThresh = simThreshold + confidenceBuffer
				}
				if bestSim >= highConfidenceThresh {
					// High-confidence match: absorbim bit-uri noi (creștere
					// controlată a prototipului).
					c.Prototype = c.Prototype.Union(m.Input)
				}
				// Moderate-confidence match (simThreshold <= sim < highConf):
				// validăm conceptul (Count++ mai jos) dar NU atingem prototype.
				// Bit-urile prototype existente rămân; bit-urile zgomotoase
				// din episod sunt respinse.
			}
			// Pentru concepte mature (Count >= maturityThresh): prototype
			// imutabil. Doar Count++ ca validare statistică.
			c.Count++

			// Append context if it's unique.
			foundCtx := false
			for _, ctx := range c.Contexts {
				if ctx == m.Context {
					foundCtx = true
					break
				}
			}
			if !foundCtx && m.Context != "" {
				c.Contexts = append(c.Contexts, m.Context)
			}
			mergedMemories[mIdx] = true
		}
	}

	// Phase 1b: Prune degenerate concepts whose prototypes have shrunk too much.
	minViableBits := sm.Config.SemanticMemoryMinViableBits
	if minViableBits <= 0 {
		minViableBits = 5
	}
	alive := make([]Concept, 0, len(sm.Concepts))
	for _, c := range sm.Concepts {
		if c.Prototype.ActiveCount >= minViableBits {
			alive = append(alive, c)
		}
	}
	sm.Concepts = alive

	// Phase 2: Form new concepts from overlapping, unmerged episodic memories.
	for i := 0; i < len(hip.Memories); i++ {
		if mergedMemories[i] {
			continue
		}
		m1 := hip.Memories[i]

		for j := i + 1; j < len(hip.Memories); j++ {
			if mergedMemories[j] {
				continue
			}
			m2 := hip.Memories[j]

			sim := m1.Input.Similarity(m2.Input)
			if sim >= simThreshold {
				// Overlapping memory traces found. Generalize via intersection!
				proto := m1.Input.Intersect(m2.Input)

				// Ensure the intersection yields a coherent pattern.
				// minViableBits: minimum active bits for a concept to be useful.
				// Default = Config.SemanticMemoryMinViableBits (currently 2).
				minViableBits := sm.SimThreshold / 40 // scales with threshold
				if minViableBits < 2 {
					minViableBits = 2
				}
				if proto.ActiveCount >= int(minViableBits) {
					var contexts []string
					if m1.Context != "" {
						contexts = append(contexts, m1.Context)
					}
					if m2.Context != "" && m2.Context != m1.Context {
						contexts = append(contexts, m2.Context)
					}

					sm.Concepts = append(sm.Concepts, Concept{
						Prototype: proto,
						Count:     2,
						Contexts:  contexts,
					})

					// Mark both as merged so they aren't processed repeatedly in this sleep cycle.
					mergedMemories[i] = true
					mergedMemories[j] = true
					break
				}
			}
		}
	}
}

// ─────────────────────────────────────────────────────────────────────
// Query — Reading concepts back (the missing half)
// ─────────────────────────────────────────────────────────────────────
//
// Until 2026-09 this module was WRITE-ONLY: Generalize() produced
// concepts that nothing ever read (documented as the biggest structural
// gap in docs/plans/2026-05-26-integration-audit.md). These two entry
// points close that gap; CognitiveBridge uses them as a second bias
// source so generalized knowledge — not just verbatim episodes — can
// steer generation.

// Query returns the concept whose prototype best matches the query SDR
// with similarity ≥ SimThreshold. Prototype similarity requires the
// SAME encoder instance/state that built the episodes — across process
// restarts that means a persisted encoder. For encoder-independent
// lookup use QueryByKeywords.
func (sm *SemanticMemory) Query(query SDR) (Concept, uint8, bool) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	bestIdx := -1
	var bestSim uint8
	for i := range sm.Concepts {
		if sm.Concepts[i].Prototype.ActiveCount == 0 {
			continue
		}
		sim := query.Similarity(sm.Concepts[i].Prototype)
		if sim >= sm.SimThreshold && sim > bestSim {
			bestSim = sim
			bestIdx = i
		}
	}
	if bestIdx < 0 {
		return Concept{}, 0, false
	}
	return sm.Concepts[bestIdx], bestSim, true
}

// QueryByKeywords returns the concept whose stored Contexts share the
// most stemmed content words with the given keywords (min. minOverlap).
// This mirrors hippocampal keyword recall and survives encoder resets,
// because it reads the concept's own text — the concept is found by
// what it MEANS, not by which random SDR bits encoded it.
func (sm *SemanticMemory) QueryByKeywords(keywords []string, minOverlap int) (Concept, int, bool) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if len(keywords) == 0 || minOverlap < 1 {
		return Concept{}, 0, false
	}
	want := make(map[string]bool, len(keywords))
	for _, kw := range keywords {
		want[stemWord(kw)] = true
	}

	bestIdx, bestOverlap := -1, 0
	for i := range sm.Concepts {
		seen := map[string]bool{}
		overlap := 0
		for _, ctx := range sm.Concepts[i].Contexts {
			for _, ckw := range extractKeywords(ctx) {
				if want[ckw] && !seen[ckw] {
					seen[ckw] = true
					overlap++
				}
			}
		}
		if overlap >= minOverlap && overlap > bestOverlap {
			bestOverlap = overlap
			bestIdx = i
		}
	}
	if bestIdx < 0 {
		return Concept{}, 0, false
	}
	return sm.Concepts[bestIdx], bestOverlap, true
}

// ─────────────────────────────────────────────────────────────────────
// Persistence — JSON Serialization (SDR packed as sparse index list)
// ─────────────────────────────────────────────────────────────────────

type conceptJSON struct {
	ActiveIndices []int    `json:"active_indices"`
	Count         int      `json:"count"`
	Contexts      []string `json:"contexts"`
}

type semanticMemoryJSON struct {
	Concepts     []conceptJSON `json:"concepts"`
	SDRSize      int           `json:"sdr_size"`
	SimThreshold uint8         `json:"sim_threshold,omitempty"` // Persisted since v2
}

// Save serializes the semantic memory concepts to a JSON file.
// Prototype SDRs are stored as space-efficient active indices arrays.
func (sm *SemanticMemory) Save(path string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	aux := semanticMemoryJSON{
		Concepts:     make([]conceptJSON, len(sm.Concepts)),
		SDRSize:      sm.SDRSize,
		SimThreshold: sm.SimThreshold,
	}

	for i, c := range sm.Concepts {
		aux.Concepts[i] = conceptJSON{
			ActiveIndices: c.Prototype.ActiveIndices(),
			Count:         c.Count,
			Contexts:      c.Contexts,
		}
	}

	data, err := json.MarshalIndent(aux, "", "  ")
	if err != nil {
		return fmt.Errorf("semantic memory marshal: %w", err)
	}

	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("semantic memory write: %w", err)
	}

	return nil
}

// LoadSemanticMemory restores a semantic memory instance from a JSON file.
// Accepts optional Config to restore SimThreshold from configuration
// (matching the NewSemanticMemory pattern).
func LoadSemanticMemory(path string, sdrSize int, cfgs ...Config) (*SemanticMemory, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("semantic memory read: %w", err)
	}

	var aux semanticMemoryJSON
	if err := json.Unmarshal(data, &aux); err != nil {
		return nil, fmt.Errorf("semantic memory unmarshal: %w", err)
	}

	// Defensive safety limits — intentionally hardcoded, NOT configurable.
	// These prevent out-of-memory panics from corrupted or malicious JSON files.
	// They are far above any reasonable operational size.
	const maxSemanticSDRSize = 100_000
	const maxSemanticConcepts = 100_000
	const maxConceptActiveIndices = 10_000
	const maxContextLen = 10_000

	if aux.SDRSize < 0 || aux.SDRSize > maxSemanticSDRSize {
		return nil, fmt.Errorf("semantic memory invalid SDRSize: %d", aux.SDRSize)
	}
	if len(aux.Concepts) > maxSemanticConcepts {
		return nil, fmt.Errorf("semantic memory too many concepts: %d (max %d)", len(aux.Concepts), maxSemanticConcepts)
	}

	// Restore SimThreshold: prefer persisted value, fall back to Config, then default 80.
	var cfg Config
	if len(cfgs) > 0 {
		cfg = cfgs[0]
	} else {
		cfg = DefaultConfig()
	}
	simThresh := aux.SimThreshold
	if simThresh == 0 && cfg.SemanticMemorySimThreshold > 0 {
		simThresh = cfg.SemanticMemorySimThreshold
	}

	sm := &SemanticMemory{
		Concepts:     make([]Concept, len(aux.Concepts)),
		SDRSize:      aux.SDRSize,
		SimThreshold: simThresh,
		Config:       cfg,
	}

	if sm.SDRSize <= 0 {
		sm.SDRSize = sdrSize
	}

	for i, cJSON := range aux.Concepts {
		if len(cJSON.ActiveIndices) > maxConceptActiveIndices {
			return nil, fmt.Errorf("semantic memory concept %d has too many active indices: %d", i, len(cJSON.ActiveIndices))
		}
		if len(cJSON.Contexts) > maxContextLen {
			return nil, fmt.Errorf("semantic memory concept %d has too many contexts: %d", i, len(cJSON.Contexts))
		}
		sdr := NewSDR(sm.SDRSize)
		for _, idx := range cJSON.ActiveIndices {
			sdr.Set(idx)
		}
		sm.Concepts[i] = Concept{
			Prototype: sdr,
			Count:     cJSON.Count,
			Contexts:  cJSON.Contexts,
		}
	}

	return sm, nil
}
