package main

// bitnet-run — standalone generation runner for a BitNet b1.58 NXTF v3
// checkpoint (forge/import_bitnet.py's output, loaded via
// cortex.LoadBitNetModel), using cortex.BitNetDecoder for O(1)-per-token
// incremental (KV-cached) decoding instead of recomputing the whole
// sequence on every step.
//
//	go run ./cmd/bitnet-run -model data/forge/bitnet-2b4t/bitnet.nxtf \
//	    -tokenizer data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json \
//	    -prompt "The capital of France is" -max-tokens 32 -greedy
//
//	go run ./cmd/bitnet-run -model data/forge/bitnet-2b4t/bitnet.nxtf \
//	    -tokenizer data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json \
//	    -chat -system "You are terse." -prompt "What is BitNet?" \
//	    -max-tokens 64 -temp 0.7 -top-k 40 -top-p 0.95 -rep-penalty 1.2 -stream
//
//	go run ./cmd/bitnet-run -model forge/fixtures/bitnet_tiny.nxtf \
//	    -ids "5,10,15" -max-tokens 5   # no tokenizer.json needed — prints ids
//
// -tokenizer uses cortex.LoadHFTokenizerJSON (the raw HF tokenizer.json,
// e.g. data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json). When it's
// omitted, -ids takes a comma-separated list of token ids directly and
// the output is printed as ids instead of decoded text — useful for
// checkpoints (like the tiny test fixture) that have no real tokenizer.
//
// Decoding mode: greedy (argmax) when -greedy is passed OR -temp is
// approximately 0; otherwise temperature/top-k/top-p sampling with
// repetition penalty, seeded by -seed. Generation stops at the model's
// Cfg.EOSTokenID or at the tokenizer's <|eot_id|> (128009, BitNet-2B4T
// instruct's turn-end marker, tok.EotID()) — whichever comes first —
// or after -max-tokens tokens, whichever is sooner. With -stream, each
// generated token is decoded and printed as soon as it is produced
// instead of only once at the end.
//
// This CLI drives cortex.BitNetDecoder (Prefill once over the prompt, then
// one Step per emitted token) directly rather than going through
// BitNetModel.GenerateGreedy/GenerateSampled, so it can stream per-token
// output and stop at either of two distinct token ids — both needs the
// fixed Generate* signatures don't accommodate. It reuses the exact same
// sampling arithmetic those methods use via cortex.ApplyRepetitionPenalty
// and cortex.SampleTopKTopP (exported wrappers around the shared
// unexported helpers in cortex/transformer_sampling.go).

import (
	"flag"
	"fmt"
	"math/rand"
	"os"
	"strconv"
	"strings"
	"time"

	cortex "nexus-cortex/cortex"
	"nexus-cortex/cortex/compute"
)

func main() {
	modelPath := flag.String("model", "", "Path to a BitNet NXTF v3 checkpoint (required)")
	tokenizerPath := flag.String("tokenizer", "", "Path to an HF tokenizer.json (optional — falls back to -ids)")
	idsFlag := flag.String("ids", "", "Comma-separated token ids, used instead of -tokenizer + -prompt")
	prompt := flag.String("prompt", "The capital of France is", "Prompt text (needs -tokenizer)")
	system := flag.String("system", "", "Optional system turn, used only with -chat")
	chat := flag.Bool("chat", false, "Wrap -prompt in the checkpoint's chat template (cortex.Llama3ChatPrompt) before tokenizing")
	maxTokens := flag.Int("max-tokens", 32, "Max number of tokens to generate")
	greedy := flag.Bool("greedy", false, "Force greedy (argmax) decoding regardless of -temp")
	temp := flag.Float64("temp", 0.7, "Sampling temperature (greedy if <= ~0, or if -greedy is set)")
	topK := flag.Int("top-k", 40, "Top-k cutoff for sampling")
	topP := flag.Float64("top-p", 0.95, "Nucleus sampling mass (<=0 or >=1 disables)")
	repPenalty := flag.Float64("rep-penalty", 1.2, "Repetition penalty (<=1 disables)")
	seed := flag.Int64("seed", 42, "Sampler RNG seed")
	stream := flag.Bool("stream", false, "Print each token as it is generated instead of only at the end")
	gpu := flag.Bool("gpu", false, "Enable resident cuBLAS int8 GPU backend for every BitLinear (needs a -tags gpu build; see cortex/bitnet_gpu.go)")
	flag.Parse()

	fail := func(stage string, err error) {
		fmt.Fprintf(os.Stderr, "error: %s: %v\n", stage, err)
		os.Exit(1)
	}

	if *modelPath == "" {
		fail("flags", fmt.Errorf("-model is required"))
	}

	loadStart := time.Now()
	model, err := cortex.LoadBitNetModel(*modelPath)
	if err != nil {
		fail("model", err)
	}
	fmt.Fprintf(os.Stderr, "[bitnet-run] loaded %s in %.2fs (vocab=%d layers=%d embed=%d)\n",
		*modelPath, time.Since(loadStart).Seconds(), model.Cfg.VocabSize, model.Cfg.NumLayers, model.Cfg.EmbedDim)

	if *gpu {
		gpuStart := time.Now()
		if err := cortex.EnableBitNetGPU(model); err != nil {
			fail("enable gpu", err)
		}
		fmt.Fprintf(os.Stderr, "[bitnet-run] GPU backend enabled in %.2fs\n", time.Since(gpuStart).Seconds())
		if free, total, err := compute.MemInfoInt8(); err == nil {
			fmt.Fprintf(os.Stderr, "[bitnet-run] GPU memory: %.0f MiB used / %.0f MiB total\n",
				float64(total-free)/1024/1024, float64(total)/1024/1024)
		}
	}

	var promptIDs []int
	var tok *cortex.BPETokenizer
	stopIDs := []int{model.Cfg.EOSTokenID}

	switch {
	case *tokenizerPath != "":
		t, err := cortex.LoadHFTokenizerJSON(*tokenizerPath)
		if err != nil {
			fail("tokenizer", err)
		}
		tok = t
		text := *prompt
		if *chat {
			text = cortex.Llama3ChatPrompt(*system, *prompt)
		}
		promptIDs = tok.Encode(text)
		if eot := tok.EotID(); eot >= 0 {
			stopIDs = append(stopIDs, eot)
		}
	case *idsFlag != "":
		for _, s := range strings.Split(*idsFlag, ",") {
			s = strings.TrimSpace(s)
			if s == "" {
				continue
			}
			v, err := strconv.Atoi(s)
			if err != nil {
				fail("ids", fmt.Errorf("bad token id %q: %w", s, err))
			}
			promptIDs = append(promptIDs, v)
		}
		fmt.Fprintln(os.Stderr, "[bitnet-run] no -tokenizer given — using -ids directly; output will be printed as ids, not decoded text")
	default:
		fail("flags", fmt.Errorf("need either -tokenizer (with -prompt) or -ids"))
	}
	if len(promptIDs) == 0 {
		fail("prompt", fmt.Errorf("empty token id sequence"))
	}

	useGreedy := *greedy || *temp <= 1e-6

	// Sampling parameter defaults, mirroring cortex.SampleConfig.normalise
	// (cortex/transformer_sampling.go) — trivial parameter defaulting, not
	// sampling logic, so it's fine to inline rather than export that too.
	normTemp := float32(*temp)
	if normTemp <= 0 {
		normTemp = 1.0
	}
	normTopK := *topK
	if normTopK <= 0 || normTopK > model.Cfg.VocabSize {
		normTopK = model.Cfg.VocabSize
	}
	const repWindow = 64
	rng := rand.New(rand.NewSource(*seed))

	stopSet := make(map[int]bool, len(stopIDs))
	for _, id := range stopIDs {
		stopSet[id] = true
	}

	decodeOne := func(id int) string {
		if tok == nil {
			return fmt.Sprintf("%d ", id)
		}
		return tok.Decode([]int{id})
	}

	dec := cortex.NewBitNetDecoder(model)

	prefillStart := time.Now()
	logits := dec.Prefill(promptIDs)
	prefillElapsed := time.Since(prefillStart)

	seq := make([]int, len(promptIDs))
	copy(seq, promptIDs)
	var newIDs []int

	genStart := time.Now()
	for i := 0; i < *maxTokens; i++ {
		var next int
		if useGreedy {
			next = 0
			bestVal := logits[0]
			for v := 1; v < len(logits); v++ {
				if logits[v] > bestVal {
					bestVal = logits[v]
					next = v
				}
			}
		} else {
			cortex.ApplyRepetitionPenalty(logits, seq, repWindow, float32(*repPenalty))
			for j := range logits {
				logits[j] /= normTemp
			}
			next = cortex.SampleTopKTopP(rng, logits, normTopK, float32(*topP))
		}

		seq = append(seq, next)
		newIDs = append(newIDs, next)
		if *stream {
			fmt.Print(decodeOne(next))
		}

		if stopSet[next] {
			break
		}
		if i == *maxTokens-1 || dec.Len() >= model.Cfg.MaxSeqLen {
			break
		}
		logits = dec.Step(next)
	}
	genElapsed := time.Since(genStart)

	if *stream {
		fmt.Println()
	} else if tok != nil {
		fmt.Println(tok.Decode(seq))
	} else {
		fmt.Println(seq)
	}

	rate := float64(len(newIDs)) / genElapsed.Seconds()
	fmt.Fprintf(os.Stderr, "[bitnet-run] prefill %d tokens in %.2fs | generated %d tokens in %.2fs (%.1f tok/s)\n",
		len(promptIDs), prefillElapsed.Seconds(), len(newIDs), genElapsed.Seconds(), rate)
}
