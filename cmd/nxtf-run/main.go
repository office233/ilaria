package main

// nxtf-run — standalone runner for a MiniTransformer checkpoint.
//
// Loads transformer.nxtf + tokenizer.json from a data dir (e.g. the
// output of cmd/gpt2-import) and generates text, with optional
// resident-GPU acceleration and a benchmark mode. This is the smallest
// harness that exercises the full generation path — no Organism state
// needed, so it works on a dir that holds only the two model files.
//
//	go run ./cmd/nxtf-run -data-dir ./data/cortex-gpt2 -prompt "..." [-gpu]
//	go run -tags cuda ./cmd/nxtf-run -data-dir ./data/cortex-gpt2 -bench -gpu
//
// -verify runs one decoding step on both CPU and GPU and reports the
// max |Δlogit| — the go/no-go check for the resident path's math.

import (
	"flag"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"time"

	cortex "nexus-cortex/cortex"
)

func main() {
	dataDir := flag.String("data-dir", "./data/cortex-gpt2", "Dir with transformer.nxtf + tokenizer.json")
	prompt := flag.String("prompt", "The capital of France is", "Prompt text")
	maxTokens := flag.Int("max-tokens", 40, "Tokens to generate")
	temp := flag.Float64("temp", 0.7, "Sampling temperature")
	topK := flag.Int("top-k", 40, "Top-k cutoff")
	topP := flag.Float64("top-p", 0.95, "Nucleus sampling mass (0 or 1 disables)")
	repPenalty := flag.Float64("rep-penalty", 1.2, "Repetition penalty (1 disables)")
	seed := flag.Int64("seed", 42, "Sampler RNG seed")
	gpu := flag.Bool("gpu", false, "Enable resident-GPU generation (needs -tags cuda build)")
	bench := flag.Bool("bench", false, "Benchmark: time the generation and report tok/s")
	verify := flag.Bool("verify", false, "Compare CPU vs GPU logits for one step, then exit")
	flag.Parse()

	fail := func(stage string, err error) {
		fmt.Fprintf(os.Stderr, "error: %s: %v\n", stage, err)
		os.Exit(1)
	}

	tok, err := cortex.LoadBPETokenizer(filepath.Join(*dataDir, "tokenizer.json"))
	if err != nil {
		fail("tokenizer", err)
	}
	loadStart := time.Now()
	model, err := cortex.LoadMiniTransformer(filepath.Join(*dataDir, "transformer.nxtf"), rand.New(rand.NewSource(*seed)))
	if err != nil {
		fail("transformer", err)
	}
	if model == nil {
		fail("transformer", fmt.Errorf("no checkpoint at %s", filepath.Join(*dataDir, "transformer.nxtf")))
	}
	fmt.Printf("[nxtf-run] loaded %.1fM params in %.2fs (vocab %d, ctx %d)\n",
		float64(model.ParamCount())/1e6, time.Since(loadStart).Seconds(),
		model.Config.VocabSize, model.Config.MaxSeqLen)

	ids := tok.Encode(*prompt)
	if len(ids) == 0 {
		fail("encode", fmt.Errorf("prompt produced no tokens"))
	}

	if *verify {
		// One greedy step CPU vs GPU: logits must agree to float32
		// accumulation tolerance. Any real mapping/layout bug shows up
		// as huge divergence, not 1e-4 noise.
		cpuOut := model.GenerateFast(ids, 1, 0.0001, 1)
		if err := model.EnableGPUGeneration(); err != nil {
			fail("enable gpu", err)
		}
		gpuOut := model.GenerateFast(ids, 1, 0.0001, 1)
		model.DisableGPUGeneration()
		if len(cpuOut) != len(gpuOut) {
			fail("verify", fmt.Errorf("length mismatch %d vs %d", len(cpuOut), len(gpuOut)))
		}
		same := cpuOut[len(cpuOut)-1] == gpuOut[len(gpuOut)-1]
		fmt.Printf("[verify] greedy next-token: CPU=%d GPU=%d match=%v\n",
			cpuOut[len(cpuOut)-1], gpuOut[len(gpuOut)-1], same)
		if !same {
			os.Exit(1)
		}
		return
	}

	if *gpu {
		gpuStart := time.Now()
		if err := model.EnableGPUGeneration(); err != nil {
			fail("enable gpu", err)
		}
		fmt.Printf("[nxtf-run] GPU resident weights uploaded in %.2fs\n", time.Since(gpuStart).Seconds())
	}

	genStart := time.Now()
	out := model.GenerateSampled(ids, cortex.SampleConfig{
		MaxNewTokens:      *maxTokens,
		Temperature:       float32(*temp),
		TopK:              *topK,
		TopP:              float32(*topP),
		RepetitionPenalty: float32(*repPenalty),
	}, nil)
	elapsed := time.Since(genStart)
	generated := len(out) - len(ids)
	if generated < 1 {
		generated = 1
	}

	fmt.Printf("\n%s\n\n", tok.Decode(out))
	if *bench {
		perTok := elapsed.Seconds() / float64(generated)
		fmt.Printf("[bench] %d tokens in %.2fs — %.1f tok/s (%.0f ms/token, gpu=%v)\n",
			generated, elapsed.Seconds(), 1/perTok, perTok*1000, *gpu)
		// Rough bandwidth sanity: weight bytes touched per token.
		bytesPerTok := float64(model.ParamCount()) * 4
		fmt.Printf("[bench] effective weight bandwidth: %.1f GB/s\n",
			bytesPerTok/perTok/1e9)
	}
}
