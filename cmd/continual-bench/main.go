package main

// continual-bench — the "learn-once, answer-forever" benchmark (Ținta A).
//
// THE CLAIM UNDER TEST
//
// A frozen LLM cannot learn a new fact without fine-tuning. Nexus —
// hippocampus + cognitive bridge over a frozen transformer — learns
// from a SINGLE exposure, with zero gradient updates, and the fact
// survives a full restart because episodic memory persists to disk.
//
// PROTOCOL
//
//  1. TEACH  — each fact from the eval file is stored ONCE in a fresh
//     hippocampus (one Store call, no training), then persisted.
//  2. RESTART — all in-memory state is discarded; the eval phase
//     reloads the hippocampus from disk into a brand-new object graph
//     (different RNG seed, fresh encoder/vocab). Run the phases as two
//     separate process invocations (-phase teach / -phase eval) for
//     the strictest reading; -phase full does both through disk.
//  3. EVAL   — every question (paraphrased, never identical to the
//     stored sentence) is answered twice by the SAME frozen
//     transformer: once with the cognitive-bridge logit bias, once
//     without (the frozen-LLM ablation baseline).
//
// The transformer weights are checksummed before teach and after eval
// and the report asserts they never changed — the entire capability
// difference is attributable to episodic memory.
//
// SCORING (evalsuite v2 semantics)
//
//   - strict: any expected answer word appears with word boundaries in
//     the generated continuation (evalsuite.Grade, ModeContainsAny).
//   - token recall: fraction of the primary answer's BPE tokens that
//     appear anywhere in the generated ids — measures whether memory
//     content REACHED generation even when the surface form is broken.
//
// Honest reading: strict-with-bridge vs strict-frozen is the headline;
// token recall shows mechanism. No metric is derived from the stored
// fact string itself — only from generations.

import (
	"encoding/json"
	"flag"
	"fmt"
	"hash/fnv"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"time"

	cortex "nexus-cortex/cortex"
	"nexus-cortex/cortex/evalsuite"
)

// benchFact is one line of data/evals/continual.jsonl.
type benchFact struct {
	ID       string   `json:"id"`
	Category string   `json:"category"`
	Fact     string   `json:"fact"`
	Question string   `json:"question"`
	Expected []string `json:"expected"`
}

// factResult is the per-fact verdict across the three ablation arms:
//
//	full      — recalled memory in the CONTEXT + logit bias (the system)
//	bias-only — logit bias alone, prompt unchanged (mechanism probe)
//	frozen    — plain prompt, no memory at all (any frozen LLM)
type factResult struct {
	ID              string  `json:"id"`
	Category        string  `json:"category"`
	Recalled        bool    `json:"recalled"`       // bridge found a memory
	RecalledRight   bool    `json:"recalled_right"` // ...and it was THIS fact
	StrictFull      bool    `json:"strict_full"`
	StrictBiasOnly  bool    `json:"strict_bias_only"`
	StrictFrozen    bool    `json:"strict_frozen"`
	TokenRecFull    float64 `json:"token_recall_full"`
	TokenRecBias    float64 `json:"token_recall_bias_only"`
	TokenRecFrozen  float64 `json:"token_recall_frozen"`
	GenFull         string  `json:"gen_full"`
	GenBiasOnly     string  `json:"gen_bias_only"`
	GenFrozen       string  `json:"gen_frozen"`
	BridgeTokensHit int     `json:"bridge_tokens_biased"`
}

// benchReport is the JSON artifact written at the end.
type benchReport struct {
	Timestamp          string       `json:"timestamp"`
	ModelDir           string       `json:"model_dir"`
	ModelParams        int          `json:"model_params"`
	ScorerVersion      int          `json:"scorer_version"`
	Facts              int          `json:"facts"`
	TaughtExposures    int          `json:"taught_exposures_per_fact"`
	GradientUpdates    int          `json:"gradient_updates"`
	TransformerFrozen  bool         `json:"transformer_frozen"`
	WeightHashTeach    string       `json:"weight_hash_before"`
	WeightHashEval     string       `json:"weight_hash_after"`
	RecallRate         float64      `json:"recall_rate"`
	StrictAccFull      float64      `json:"strict_accuracy_full_system"`
	StrictAccBiasOnly  float64      `json:"strict_accuracy_bias_only"`
	StrictAccFrozen    float64      `json:"strict_accuracy_frozen_baseline"`
	TokenRecallFull    float64      `json:"token_recall_full_system"`
	TokenRecallBias    float64      `json:"token_recall_bias_only"`
	TokenRecallFrozen  float64      `json:"token_recall_frozen_baseline"`
	GenSettings        string       `json:"gen_settings"`
	GPU                bool         `json:"gpu"`
	EvalSeconds        float64      `json:"eval_seconds"`
	Results            []factResult `json:"results"`
}

func fail(stage string, err error) {
	fmt.Fprintf(os.Stderr, "error: %s: %v\n", stage, err)
	os.Exit(1)
}

func loadFacts(path string) []benchFact {
	raw, err := os.ReadFile(path)
	if err != nil {
		fail("read facts", err)
	}
	var facts []benchFact
	for i, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var f benchFact
		if err := json.Unmarshal([]byte(line), &f); err != nil {
			fail(fmt.Sprintf("facts line %d", i+1), err)
		}
		facts = append(facts, f)
	}
	return facts
}

// weightHash fingerprints the tensors that would change first under any
// accidental training: token embeddings and block-0 attention.
func weightHash(m *cortex.MiniTransformer) string {
	h := fnv.New64a()
	sum := func(data []float32) {
		buf := make([]byte, 4)
		for _, v := range data {
			u := uint32(int32(v * 1e4)) // quantised; bit-identity via math bits would be fine too
			buf[0], buf[1], buf[2], buf[3] = byte(u), byte(u>>8), byte(u>>16), byte(u>>24)
			h.Write(buf)
		}
	}
	sum(m.Embedding.TokenEmb.Data)
	sum(m.Blocks[0].Attn.WQ.Data)
	sum(m.LNFGamma.Data)
	return fmt.Sprintf("%016x", h.Sum64())
}

// answerTokens returns the distinct BPE ids of the primary expected
// answer, with and without a leading space (both surface forms occur
// mid-sentence).
func answerTokens(tok *cortex.BPETokenizer, answer string) map[int]bool {
	ids := map[int]bool{}
	for _, form := range []string{answer, " " + answer} {
		for _, id := range tok.Encode(form) {
			ids[id] = true
		}
	}
	return ids
}

func main() {
	modelDir := flag.String("model-dir", "./data/cortex-gpt2", "Dir with transformer.nxtf + tokenizer.json (frozen model)")
	factsPath := flag.String("facts", "./data/evals/continual.jsonl", "Benchmark facts JSONL")
	stateDir := flag.String("state-dir", "./data/continual-bench", "Where the taught hippocampus persists between phases")
	outPath := flag.String("out", "", "Report JSON path (default <state-dir>/report.json)")
	phase := flag.String("phase", "full", "teach | eval | full (teach then eval through disk)")
	gpu := flag.Bool("gpu", false, "Resident-GPU generation (needs -tags gpu build)")
	maxTokens := flag.Int("max-tokens", 24, "Tokens generated per answer")
	temp := flag.Float64("temp", 0.6, "Sampling temperature")
	topK := flag.Int("top-k", 40, "Top-k")
	topP := flag.Float64("top-p", 0.95, "Top-p")
	repPen := flag.Float64("rep-penalty", 1.15, "Repetition penalty")
	maxBias := flag.Float64("max-bias", 8.0, "Bridge MaxBias (logit boost ceiling for recalled tokens)")
	seed := flag.Int64("seed", 42, "Sampler seed (eval phase uses seed+1 to prove restart independence)")
	flag.Parse()

	if *outPath == "" {
		*outPath = filepath.Join(*stateDir, "report.json")
	}
	facts := loadFacts(*factsPath)
	cfg := cortex.DefaultConfig()
	hippoPath := filepath.Join(*stateDir, "hippocampus.nxhip")

	tok, err := cortex.LoadBPETokenizer(filepath.Join(*modelDir, "tokenizer.json"))
	if err != nil {
		fail("tokenizer", err)
	}
	model, err := cortex.LoadMiniTransformer(filepath.Join(*modelDir, "transformer.nxtf"), rand.New(rand.NewSource(*seed)))
	if err != nil || model == nil {
		fail("transformer", fmt.Errorf("%v (nil=%v)", err, model == nil))
	}
	hashBefore := weightHash(model)
	fmt.Printf("[bench] frozen model: %.1fM params, weight hash %s\n",
		float64(model.ParamCount())/1e6, hashBefore)

	// ── TEACH ─────────────────────────────────────────────────────────
	if *phase == "teach" || *phase == "full" {
		if err := os.MkdirAll(*stateDir, 0700); err != nil {
			fail("mkdir", err)
		}
		rng := rand.New(rand.NewSource(*seed))
		enc := cortex.NewEncoder(cortex.NewVocab(), cfg.SDRSize, cfg.ActiveCount, rng, cfg)
		hippo := cortex.NewHippocampus(cfg)

		teachStart := time.Now()
		for _, f := range facts {
			sdr := enc.EncodeSentence(f.Fact)
			hippo.Store(sdr, sdr, f.Fact) // ONE exposure. No gradients. Nothing else.
		}
		if err := hippo.Save(hippoPath); err != nil {
			fail("save hippocampus", err)
		}
		fmt.Printf("[teach] %d facts stored once each in %.2fs → %s\n",
			len(facts), time.Since(teachStart).Seconds(), hippoPath)
		if *phase == "teach" {
			return
		}
	}

	// ── RESTART + EVAL ────────────────────────────────────────────────
	// Fresh object graph: new RNG lineage, new vocab, new encoder. The
	// ONLY carrier of the taught knowledge is the file on disk.
	rng2 := rand.New(rand.NewSource(*seed + 1))
	enc2 := cortex.NewEncoder(cortex.NewVocab(), cfg.SDRSize, cfg.ActiveCount, rng2, cfg)
	hippo2, err := cortex.LoadHippocampus(hippoPath, cfg)
	if err != nil {
		fail("reload hippocampus (did the teach phase run?)", err)
	}
	fmt.Printf("[eval] hippocampus reloaded from disk: %d memories\n", hippo2.Size())

	bridge := cortex.NewCognitiveBridge(hippo2, enc2, tok, model.Config.VocabSize)
	bridge.MaxBias = float32(*maxBias)

	if *gpu {
		if err := model.EnableGPUGeneration(); err != nil {
			fail("enable gpu", err)
		}
		fmt.Println("[eval] resident-GPU generation enabled")
	}

	sample := cortex.SampleConfig{
		MaxNewTokens:      *maxTokens,
		MinNewTokens:      3,
		Temperature:       float32(*temp),
		TopK:              *topK,
		TopP:              float32(*topP),
		RepetitionPenalty: float32(*repPen),
	}

	// generate answers one question. When memoryCtx is non-empty the
	// recalled fact is put INTO THE PROMPT — retrieval-augmented
	// generation, exactly what Organism.Process does with its
	// memoryContext parameter. A frozen model can copy from context but
	// can never produce this context on its own; that asymmetry IS the
	// capability being measured.
	//
	// Both arms carry the SAME fixed one-shot example (a banal fact
	// that appears nowhere in the benchmark): GPT-2-class models are
	// not instruction-tuned, and without a format demonstration they
	// echo the question instead of answering — a formatting artifact,
	// not a memory difference. The frozen arm gets the identical
	// example minus the Fact lines, so the comparison stays fair.
	generate := func(question, memoryCtx string, bias []float32) string {
		var prompt string
		if memoryCtx != "" {
			prompt = "Fact: the sky is blue on clear days\n" +
				"Question: what color is the sky on clear days?\n" +
				"Answer: blue\n\n" +
				"Fact: " + memoryCtx + "\n" +
				"Question: " + question + "?\nAnswer:"
		} else {
			prompt = "Question: what color is the sky on clear days?\n" +
				"Answer: blue\n\n" +
				"Question: " + question + "?\nAnswer:"
		}
		ids := tok.Encode(prompt)
		out := model.GenerateSampled(ids, sample, bias)
		return strings.TrimSpace(tok.Decode(out[len(ids):]))
	}

	evalStart := time.Now()
	var results []factResult
	var nRecall, nRight, nFull, nBias, nFrozen int
	var tokFull, tokBias, tokFrozen float64

	for i, f := range facts {
		bias, bres := bridge.ComputeBias(f.Question)

		genFull := generate(f.Question, bres.Context, bias)
		genBias := generate(f.Question, "", bias)
		genFrozen := generate(f.Question, "", nil)

		task := evalsuite.Task{
			ID: f.ID, Category: f.Category, Prompt: f.Question,
			Expected: f.Expected, Mode: evalsuite.ModeContainsAny,
		}
		sFull := evalsuite.Grade(task, genFull, 0).Correct
		sBias := evalsuite.Grade(task, genBias, 0).Correct
		sFrozen := evalsuite.Grade(task, genFrozen, 0).Correct

		ansIDs := answerTokens(tok, f.Expected[0])
		hit := func(gen string) float64 {
			if len(ansIDs) == 0 {
				return 0
			}
			present := map[int]bool{}
			for _, id := range tok.Encode(gen) {
				if ansIDs[id] {
					present[id] = true
				}
			}
			return float64(len(present)) / float64(len(ansIDs))
		}
		trFull, trBias, trFrozen := hit(genFull), hit(genBias), hit(genFrozen)

		r := factResult{
			ID: f.ID, Category: f.Category,
			Recalled: bres.Applied, RecalledRight: bres.Applied && bres.Context == f.Fact,
			StrictFull: sFull, StrictBiasOnly: sBias, StrictFrozen: sFrozen,
			TokenRecFull: trFull, TokenRecBias: trBias, TokenRecFrozen: trFrozen,
			GenFull: genFull, GenBiasOnly: genBias, GenFrozen: genFrozen,
			BridgeTokensHit: bres.TokensBiased,
		}
		results = append(results, r)
		if r.Recalled {
			nRecall++
		}
		if r.RecalledRight {
			nRight++
		}
		if sFull {
			nFull++
		}
		if sBias {
			nBias++
		}
		if sFrozen {
			nFrozen++
		}
		tokFull += trFull
		tokBias += trBias
		tokFrozen += trFrozen

		if (i+1)%20 == 0 {
			fmt.Printf("[eval] %d/%d — full %d, bias-only %d, frozen %d\n",
				i+1, len(facts), nFull, nBias, nFrozen)
		}
	}
	evalSecs := time.Since(evalStart).Seconds()

	if *gpu {
		model.DisableGPUGeneration()
	}
	hashAfter := weightHash(model)

	n := float64(len(facts))
	rep := benchReport{
		Timestamp:         time.Now().Format(time.RFC3339),
		ModelDir:          *modelDir,
		ModelParams:       model.ParamCount(),
		ScorerVersion:     evalsuite.ScorerVersion,
		Facts:             len(facts),
		TaughtExposures:   1,
		GradientUpdates:   0,
		TransformerFrozen: hashBefore == hashAfter,
		WeightHashTeach:   hashBefore,
		WeightHashEval:    hashAfter,
		RecallRate:        float64(nRight) / n,
		StrictAccFull:     float64(nFull) / n,
		StrictAccBiasOnly: float64(nBias) / n,
		StrictAccFrozen:   float64(nFrozen) / n,
		TokenRecallFull:   tokFull / n,
		TokenRecallBias:   tokBias / n,
		TokenRecallFrozen: tokFrozen / n,
		GenSettings: fmt.Sprintf("temp=%.2f top-k=%d top-p=%.2f rep=%.2f max-bias=%.1f max-tokens=%d",
			*temp, *topK, *topP, *repPen, *maxBias, *maxTokens),
		GPU:         *gpu,
		EvalSeconds: evalSecs,
		Results:     results,
	}

	buf, _ := json.MarshalIndent(rep, "", "  ")
	if err := os.WriteFile(*outPath, buf, 0644); err != nil {
		fail("write report", err)
	}

	fmt.Println()
	fmt.Println("════════════ LEARN-ONCE, ANSWER-FOREVER ════════════")
	fmt.Printf("facts taught once, gradient updates: 0, weights frozen: %v\n", rep.TransformerFrozen)
	fmt.Printf("memory recall (right fact):        %5.1f%%\n", 100*rep.RecallRate)
	fmt.Printf("strict acc FULL (context+bias):    %5.1f%%\n", 100*rep.StrictAccFull)
	fmt.Printf("strict acc bias-only:              %5.1f%%\n", 100*rep.StrictAccBiasOnly)
	fmt.Printf("strict acc frozen LLM baseline:    %5.1f%%\n", 100*rep.StrictAccFrozen)
	fmt.Printf("token recall full / bias / frozen: %5.1f%% / %5.1f%% / %5.1f%%\n",
		100*rep.TokenRecallFull, 100*rep.TokenRecallBias, 100*rep.TokenRecallFrozen)
	fmt.Printf("eval time: %.1fs (%s)\n", evalSecs, rep.GenSettings)
	fmt.Printf("report: %s\n", *outPath)
}
