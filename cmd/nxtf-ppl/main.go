package main

// nxtf-ppl — measure the perplexity of a trained brain (transformer.nxtf +
// tokenizer.json) against an arbitrary UTF-8 text file, on the Go engine.
//
// Definition (must match forge/ppl.py exactly):
//   1. Tokenize the whole file. Documents are separated by blank lines
//      (one or more empty lines); each document is encoded independently
//      and an EOS id is appended after it — exactly like
//      forge/hf_tokenizer.py:encode_jsonl does per JSONL record.
//   2. Concatenate every document's [ids..., eos] into one token stream.
//   3. Walk that stream in non-overlapping windows of -ctx tokens (default:
//      the model's max_seq_len from the nxtf header). Each window of length
//      w feeds tokens [0:w-1] through the model and scores them against
//      targets [1:w] (teacher forcing) — the window's first token has no
//      prediction. A final window shorter than 2 tokens is dropped.
//   4. mean_nll is the mean over ALL predicted tokens in the file;
//      perplexity = exp(mean_nll).
//   5. -per-doc additionally attributes each predicted token's NLL back to
//      the document that contains it (a window may straddle a document
//      boundary — attribution is by target token, not by window) and
//      reports per-document tokens/mean_nll/perplexity.
//
//	go run ./cmd/nxtf-ppl -data-dir data/forge/brain-a -text some.txt
//	go run ./cmd/nxtf-ppl -data-dir <fixture-dir-with-transformer.nxtf> -ids ids.txt
//
// -ids/-text are mutually exclusive: -ids reads a whitespace-separated list
// of integer token ids directly (bypassing the tokenizer entirely — the one
// path fixtures without a tokenizer.json can use) and treats the whole file
// as a single document.
//
// CPU only: the batched (non-causal-cache) Forward pass used here has no
// GPU path in cortex/transformer.go — only the autoregressive cached-step
// generation path (EnableGPUGeneration) is GPU-accelerated, and it isn't a
// drop-in replacement for scoring an arbitrary window without duplicating
// forward logic. The task allows CPU-only, so -gpu is intentionally omitted.

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	cortex "nexus-cortex/cortex"
)

// forwardFunc mirrors (*cortex.MiniTransformer).Forward: given input token
// ids it returns logits shaped [len(input), VocabSize]. Factored out so the
// windowing/NLL bookkeeping in computePerplexity is unit-testable without a
// real model (see main_test.go).
type forwardFunc func(input []int) *cortex.Tensor

// docSpan is a half-open [Start, End) range of global token-stream indices
// belonging to one document.
type docSpan struct {
	Start, End int
}

// docResult is the per-document slice of a pplResult.
type docResult struct {
	Doc        int     `json:"doc"`
	Tokens     int     `json:"tokens"`
	MeanNLL    float64 `json:"mean_nll"`
	Perplexity float64 `json:"perplexity"`
}

// pplResult is the full outcome of computePerplexity.
type pplResult struct {
	Tokens     int         `json:"tokens"`
	Windows    int         `json:"windows"`
	MeanNLL    float64     `json:"mean_nll"`
	Perplexity float64     `json:"perplexity"`
	PerDoc     []docResult `json:"per_doc,omitempty"`
}

// splitDocuments splits text into documents separated by blank lines
// (one or more consecutive empty-after-trim lines). Mirrors
// forge/ppl.py:split_documents exactly.
func splitDocuments(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	lines := strings.Split(text, "\n")

	var docs []string
	var cur []string
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			if len(cur) > 0 {
				docs = append(docs, strings.Join(cur, "\n"))
				cur = nil
			}
			continue
		}
		cur = append(cur, line)
	}
	if len(cur) > 0 {
		docs = append(docs, strings.Join(cur, "\n"))
	}
	return docs
}

// buildIDsFromText tokenizes each document and appends EosID() after it,
// recording the [start,end) span of every document in the concatenated
// token stream.
func buildIDsFromText(tok *cortex.BPETokenizer, text string) ([]int, []docSpan) {
	docs := splitDocuments(text)
	eos := tok.EosID()

	var ids []int
	spans := make([]docSpan, 0, len(docs))
	for _, doc := range docs {
		start := len(ids)
		ids = append(ids, tok.Encode(doc)...)
		ids = append(ids, eos)
		spans = append(spans, docSpan{Start: start, End: len(ids)})
	}
	return ids, spans
}

// buildIDsFromIDsFile reads a whitespace-separated list of integer token
// ids and treats the whole file as a single document. This is the path the
// tiny dev fixtures (no tokenizer.json) use.
func buildIDsFromIDsFile(path string) ([]int, []docSpan, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("read ids file: %w", err)
	}
	fields := strings.Fields(string(raw))
	ids := make([]int, 0, len(fields))
	for _, f := range fields {
		v, err := strconv.Atoi(f)
		if err != nil {
			return nil, nil, fmt.Errorf("ids file: bad integer %q: %w", f, err)
		}
		ids = append(ids, v)
	}
	if len(ids) == 0 {
		return ids, nil, nil
	}
	return ids, []docSpan{{Start: 0, End: len(ids)}}, nil
}

// computePerplexity is the windowing/NLL bookkeeping shared by the real
// model path and the unit test. ids is the full token stream, docSpans
// partitions it (must be contiguous and cover [0,len(ids)) when non-empty),
// ctx is the window size (>=2), and forward scores one window's input.
func computePerplexity(ids []int, docSpans []docSpan, ctx int, forward forwardFunc) pplResult {
	n := len(ids)
	docSumNLL := make([]float64, len(docSpans))
	docTokens := make([]int, len(docSpans))

	var totalNLL float64
	var totalTokens, windows int
	docPtr := 0

	for start := 0; start < n; start += ctx {
		end := start + ctx
		if end > n {
			end = n
		}
		w := end - start
		if w < 2 {
			continue // drop a final partial window shorter than 2 tokens
		}
		window := ids[start:end]
		input := window[:w-1]
		target := window[1:]
		logits := forward(input)
		vocab := logits.Shape[1]
		windows++

		if len(docSpans) == 0 {
			// No document bookkeeping requested/available: score the
			// whole window in one CrossEntropyLoss call.
			meanLoss := cortex.CrossEntropyLoss(logits, target)
			totalNLL += float64(meanLoss) * float64(w-1)
			totalTokens += w - 1
			continue
		}

		// Walk the predicted range [start+1, end) in contiguous
		// per-document sub-ranges, scoring each with the shared
		// CrossEntropyLoss (mean over the sub-range), then rescaling
		// back to a sum. This is how doc attribution happens without
		// a second per-token loss implementation.
		gpos := start + 1
		for gpos < end && docPtr < len(docSpans) {
			for docPtr < len(docSpans)-1 && gpos >= docSpans[docPtr].End {
				docPtr++
			}
			segEnd := end
			if docSpans[docPtr].End < segEnd {
				segEnd = docSpans[docPtr].End
			}
			segLen := segEnd - gpos
			if segLen <= 0 {
				break
			}
			offset := gpos - (start + 1) // row index into logits/target for this window
			subLogits := &cortex.Tensor{
				Shape: []int{segLen, vocab},
				Data:  logits.Data[offset*vocab : (offset+segLen)*vocab],
			}
			subTarget := target[offset : offset+segLen]
			meanLoss := cortex.CrossEntropyLoss(subLogits, subTarget)
			sumLoss := float64(meanLoss) * float64(segLen)

			totalNLL += sumLoss
			totalTokens += segLen
			docSumNLL[docPtr] += sumLoss
			docTokens[docPtr] += segLen

			gpos = segEnd
		}
	}

	res := pplResult{Tokens: totalTokens, Windows: windows}
	if totalTokens > 0 {
		res.MeanNLL = totalNLL / float64(totalTokens)
		res.Perplexity = math.Exp(res.MeanNLL)
	}
	for i := range docSpans {
		if docTokens[i] == 0 {
			continue
		}
		mean := docSumNLL[i] / float64(docTokens[i])
		res.PerDoc = append(res.PerDoc, docResult{
			Doc:        i,
			Tokens:     docTokens[i],
			MeanNLL:    mean,
			Perplexity: math.Exp(mean),
		})
	}
	return res
}

func main() {
	dataDir := flag.String("data-dir", "", "Dir with transformer.nxtf (+ tokenizer.json unless -ids)")
	textPath := flag.String("text", "", "UTF-8 text file to score")
	idsPath := flag.String("ids", "", "Whitespace-separated token-id file (bypasses the tokenizer; single document)")
	ctxFlag := flag.Int("ctx", 0, "Window size in tokens (default: model's max_seq_len)")
	perDoc := flag.Bool("per-doc", false, "Also print per-document perplexity")
	jsonPath := flag.String("json", "", "Write the full result as JSON to this path")
	flag.Parse()

	fail := func(stage string, err error) {
		fmt.Fprintf(os.Stderr, "error: %s: %v\n", stage, err)
		os.Exit(1)
	}

	if *dataDir == "" {
		fail("flags", fmt.Errorf("-data-dir is required"))
	}
	if (*textPath == "") == (*idsPath == "") {
		fail("flags", fmt.Errorf("exactly one of -text or -ids is required"))
	}

	// Loading builds a fresh MiniTransformer (random init) before
	// overwriting it with the checkpoint's weights, so a real *rand.Rand
	// is needed even though nothing here samples from it (Forward, unlike
	// ForwardTrain, never touches dropout/Rng).
	model, err := cortex.LoadMiniTransformer(filepath.Join(*dataDir, "transformer.nxtf"), rand.New(rand.NewSource(1)))
	if err != nil {
		fail("transformer", err)
	}
	if model == nil {
		fail("transformer", fmt.Errorf("no checkpoint at %s", filepath.Join(*dataDir, "transformer.nxtf")))
	}

	ctx := *ctxFlag
	if ctx <= 0 {
		ctx = model.Config.MaxSeqLen
	}
	if ctx > model.Config.MaxSeqLen {
		fmt.Fprintf(os.Stderr, "[nxtf-ppl] warning: -ctx %d exceeds model max_seq_len %d, clamping\n", ctx, model.Config.MaxSeqLen)
		ctx = model.Config.MaxSeqLen
	}
	if ctx < 2 {
		fail("flags", fmt.Errorf("ctx must be >= 2 (got %d)", ctx))
	}

	var ids []int
	var spans []docSpan
	if *idsPath != "" {
		ids, spans, err = buildIDsFromIDsFile(*idsPath)
		if err != nil {
			fail("ids", err)
		}
	} else {
		tok, err := cortex.LoadBPETokenizer(filepath.Join(*dataDir, "tokenizer.json"))
		if err != nil {
			fail("tokenizer", err)
		}
		raw, err := os.ReadFile(*textPath)
		if err != nil {
			fail("text", err)
		}
		ids, spans = buildIDsFromText(tok, string(raw))
	}

	if len(ids) < 2 {
		fail("input", fmt.Errorf("fewer than 2 tokens (%d) — nothing to score", len(ids)))
	}

	res := computePerplexity(ids, spans, ctx, model.Forward)

	fmt.Printf("[nxtf-ppl] tokens=%d windows=%d mean_nll=%.6f ppl=%.6f\n",
		res.Tokens, res.Windows, res.MeanNLL, res.Perplexity)
	if *perDoc {
		for _, d := range res.PerDoc {
			fmt.Printf("[nxtf-ppl] doc=%d tokens=%d mean_nll=%.6f ppl=%.6f\n",
				d.Doc, d.Tokens, d.MeanNLL, d.Perplexity)
		}
	}

	if *jsonPath != "" {
		out := res
		if !*perDoc {
			out.PerDoc = nil
		}
		buf, err := json.MarshalIndent(out, "", "  ")
		if err != nil {
			fail("json", err)
		}
		if err := os.WriteFile(*jsonPath, buf, 0644); err != nil {
			fail("json", err)
		}
	}
}
