package main

// tinystories-convert — turn the TinyStories plain-text dumps
// (stories separated by <|endoftext|> lines) into the {"text": ...}
// JSONL the Nexus corpus loaders read.
//
// WHY A CAP: cortex-broca-train tokenizes the whole corpus into RAM.
// The full train split holds ~2.1M stories; a 40k-step run with batch 8
// consumes 320k sequences, so a capped subset keeps memory sane while
// leaving more data than the run can ever see. Stories are taken in
// file order (the dataset is pre-shuffled at generation time).
//
//	go run ./cmd/tinystories-convert -in TinyStories-train.txt \
//	    -out data/corpus/tinystories-train.jsonl -max 400000

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
)

func main() {
	in := flag.String("in", "", "TinyStories .txt file (required)")
	out := flag.String("out", "", "Output JSONL path (required)")
	maxStories := flag.Int("max", 0, "Max stories to emit (0 = all)")
	minWords := flag.Int("min-words", 20, "Skip stories shorter than this many words")
	flag.Parse()

	if *in == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "error: -in and -out are required")
		os.Exit(1)
	}

	fIn, err := os.Open(*in)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: open input: %v\n", err)
		os.Exit(1)
	}
	defer fIn.Close()

	fOut, err := os.Create(*out)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: create output: %v\n", err)
		os.Exit(1)
	}
	defer fOut.Close()
	w := bufio.NewWriterSize(fOut, 1<<20)

	type line struct {
		Text string `json:"text"`
	}
	enc := json.NewEncoder(w)

	emit := func(story []string) bool {
		text := strings.TrimSpace(strings.Join(story, " "))
		if text == "" || len(strings.Fields(text)) < *minWords {
			return false
		}
		if err := enc.Encode(line{Text: text}); err != nil {
			fmt.Fprintf(os.Stderr, "error: write: %v\n", err)
			os.Exit(1)
		}
		return true
	}

	sc := bufio.NewScanner(fIn)
	sc.Buffer(make([]byte, 1<<20), 1<<20)

	var story []string
	emitted, skipped := 0, 0
	for sc.Scan() {
		l := strings.TrimSpace(sc.Text())
		if l == "<|endoftext|>" {
			if emit(story) {
				emitted++
			} else {
				skipped++
			}
			story = story[:0]
			if *maxStories > 0 && emitted >= *maxStories {
				break
			}
			continue
		}
		if l != "" {
			story = append(story, l)
		}
	}
	if *maxStories == 0 || emitted < *maxStories {
		if emit(story) {
			emitted++
		}
	}
	if err := sc.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "error: scan: %v\n", err)
		os.Exit(1)
	}
	if err := w.Flush(); err != nil {
		fmt.Fprintf(os.Stderr, "error: flush: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[convert] %s → %s: %d stories (%d skipped as too short)\n",
		*in, *out, emitted, skipped)
}
