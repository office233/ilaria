// corpus-coverage — measure tokenizer coverage of a corpus.
//
// Loads an existing BPE tokenizer and a JSONL corpus, encodes a sample
// of lines, and reports:
//   - total tokens emitted
//   - <UNK> rate (tokens mapped to the unknown ID)
//   - top 20 unknown words (with counts)
//   - sample of encoded text with token IDs
//
// Used to decide whether a new corpus (e.g. Wikipedia RO) can be added
// to an in-progress training run without re-training the tokenizer:
// <UNK> rate under ~3% is usually fine.
//
// Usage:
//
//	corpus-coverage --tokenizer data/cortex-auto/tokenizer.json \
//	                --vocab     data/cortex-auto/vocab.json \
//	                --corpus    data/corpus/wikipedia_ro.jsonl \
//	                --sample    20000
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"

	"ilaria/cortex"
)

type rawItem struct {
	Text        string `json:"text,omitempty"`
	Instruction string `json:"instruction,omitempty"`
	Response    string `json:"response,omitempty"`
	Prompt      string `json:"prompt,omitempty"`
	Completion  string `json:"completion,omitempty"`
	Question    string `json:"question,omitempty"`
	Answer      string `json:"answer,omitempty"`
	Content     string `json:"content,omitempty"`
}

func (r rawItem) Combined() string {
	parts := []string{}
	for _, s := range []string{r.Text, r.Instruction, r.Response, r.Prompt, r.Completion, r.Question, r.Answer, r.Content} {
		if s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, " ")
}

func main() {
	tokPath := flag.String("tokenizer", "data/cortex-auto/tokenizer.json", "Path to BPE tokenizer JSON")
	vocabPath := flag.String("vocab", "data/cortex-auto/vocab.json", "Path to vocab JSON (currently unused, kept for symmetry)")
	corpusPath := flag.String("corpus", "", "JSONL corpus to measure (required)")
	sampleLines := flag.Int("sample", 10000, "Max lines to sample (0 = all)")
	topUnk := flag.Int("top-unk", 20, "Number of top unknown words to print")
	flag.Parse()

	_ = vocabPath // silence unused: kept for future RO-vocab introspection

	if *corpusPath == "" {
		fmt.Fprintln(os.Stderr, "missing --corpus")
		os.Exit(2)
	}

	tok, err := cortex.LoadBPETokenizer(*tokPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tokenizer load: %v\n", err)
		os.Exit(1)
	}
	unkID := tok.UnkID()
	fmt.Printf("Tokenizer loaded: vocab=%d UNK=%d BOS=%d EOS=%d\n",
		tok.VocabSize, unkID, tok.BosID(), tok.EosID())

	f, err := os.Open(*corpusPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "corpus open: %v\n", err)
		os.Exit(1)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)

	var (
		linesSeen   int
		totalTokens int64
		unkTokens   int64
		unkWords    = map[string]int{}
	)

	for scanner.Scan() {
		if *sampleLines > 0 && linesSeen >= *sampleLines {
			break
		}
		var it rawItem
		if err := json.Unmarshal(scanner.Bytes(), &it); err != nil {
			continue
		}
		text := it.Combined()
		if text == "" {
			continue
		}
		linesSeen++

		ids := tok.Encode(text)
		totalTokens += int64(len(ids))
		for _, id := range ids {
			if id == unkID {
				unkTokens++
			}
		}

		// Word-level UNK survey: split on whitespace, encode each word
		// in isolation, flag whole words that round-trip to UNK only.
		// Cheap but very informative for picking new vocab targets.
		for _, w := range strings.Fields(text) {
			wIDs := tok.Encode(w)
			allUnk := len(wIDs) > 0
			for _, id := range wIDs {
				if id != unkID {
					allUnk = false
					break
				}
			}
			if allUnk {
				unkWords[strings.ToLower(w)]++
			}
		}
	}

	fmt.Printf("\nSampled lines: %d\n", linesSeen)
	fmt.Printf("Total tokens:  %d\n", totalTokens)
	if totalTokens > 0 {
		fmt.Printf("UNK tokens:    %d (%.3f%%)\n",
			unkTokens, float64(unkTokens)/float64(totalTokens)*100)
	}
	fmt.Printf("Unique unknown words: %d\n", len(unkWords))

	if *topUnk > 0 && len(unkWords) > 0 {
		type kv struct {
			w string
			n int
		}
		list := make([]kv, 0, len(unkWords))
		for w, n := range unkWords {
			list = append(list, kv{w, n})
		}
		sort.Slice(list, func(i, j int) bool {
			if list[i].n != list[j].n {
				return list[i].n > list[j].n
			}
			return list[i].w < list[j].w
		})
		if len(list) > *topUnk {
			list = list[:*topUnk]
		}
		fmt.Printf("\nTop %d unknown words:\n", len(list))
		for _, e := range list {
			fmt.Printf("  %6d  %s\n", e.n, e.w)
		}
	}

	// Print one decoded round-trip for a sanity check.
	if linesSeen > 0 {
		f2, _ := os.Open(*corpusPath)
		defer f2.Close()
		scan2 := bufio.NewScanner(f2)
		scan2.Buffer(make([]byte, 1024*1024), 16*1024*1024)
		if scan2.Scan() {
			var it rawItem
			if err := json.Unmarshal(scan2.Bytes(), &it); err == nil {
				text := it.Combined()
				if len(text) > 200 {
					text = text[:200]
				}
				ids := tok.Encode(text)
				back := tok.Decode(ids)
				fmt.Printf("\nSample round-trip:\n  orig: %s\n  back: %s\n", text, back)
			}
		}
	}
}
