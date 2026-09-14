package main

// corpus-tokenize — turn a JSONL corpus into a flat token stream the
// PyTorch forge (forge/train_ilaria.py) trains on.
//
// WHY TOKENIZE IN GO: the forge must train on EXACTLY the token ids the
// Go organism will feed the model at inference. Reimplementing the BPE
// (char-level PreTokenize + ranked merges, or the GPT-2 byte-level
// mode) in Python is a second implementation that can drift. One
// tokenizer, one truth: Go writes the ids, Python only reads them.
//
// Output: <out>.bin — little-endian uint16 (vocab ≤ 65535) or uint32
// ids, documents separated by EOS; <out>.json — metadata the forge
// needs (vocab size, eos id, dtype, token count).
//
//	go run ./cmd/corpus-tokenize -tokenizer data/cortex-eprime/tokenizer.json \
//	    -in data/corpus/tinystories-train.jsonl -out data/forge/tinystories

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	cortex "nexus-cortex/cortex"
)

func main() {
	tokPath := flag.String("tokenizer", "", "Nexus tokenizer.json (required)")
	in := flag.String("in", "", "Input JSONL with {\"text\": ...} lines (required)")
	out := flag.String("out", "", "Output path prefix (writes <out>.bin and <out>.json)")
	maxDocs := flag.Int("max", 0, "Max documents (0 = all)")
	flag.Parse()
	if *tokPath == "" || *in == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "error: -tokenizer, -in and -out are required")
		os.Exit(1)
	}

	tok, err := cortex.LoadBPETokenizer(*tokPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: tokenizer: %v\n", err)
		os.Exit(1)
	}
	vocab := tok.ActualVocabSize()
	eos := tok.EosID()
	wide := vocab > 65535

	fIn, err := os.Open(*in)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: open input: %v\n", err)
		os.Exit(1)
	}
	defer fIn.Close()
	fOut, err := os.Create(*out + ".bin")
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: create output: %v\n", err)
		os.Exit(1)
	}
	defer fOut.Close()
	w := bufio.NewWriterSize(fOut, 1<<20)

	writeID := func(id int) {
		if wide {
			var b [4]byte
			binary.LittleEndian.PutUint32(b[:], uint32(id))
			w.Write(b[:])
		} else {
			var b [2]byte
			binary.LittleEndian.PutUint16(b[:], uint16(id))
			w.Write(b[:])
		}
	}

	sc := bufio.NewScanner(fIn)
	sc.Buffer(make([]byte, 4<<20), 4<<20)
	start := time.Now()
	docs, tokens := 0, 0
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var rec struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal([]byte(line), &rec); err != nil || rec.Text == "" {
			continue
		}
		ids := tok.Encode(rec.Text)
		if len(ids) == 0 {
			continue
		}
		for _, id := range ids {
			writeID(id)
		}
		writeID(eos)
		tokens += len(ids) + 1
		docs++
		if *maxDocs > 0 && docs >= *maxDocs {
			break
		}
		if docs%50000 == 0 {
			fmt.Printf("[tokenize] %d docs, %d tokens (%.0fs)\n", docs, tokens, time.Since(start).Seconds())
		}
	}
	if err := w.Flush(); err != nil {
		fmt.Fprintf(os.Stderr, "error: flush: %v\n", err)
		os.Exit(1)
	}

	dtype := "uint16"
	if wide {
		dtype = "uint32"
	}
	meta := map[string]any{
		"vocab_size": vocab,
		"eos_id":     eos,
		"dtype":      dtype,
		"tokens":     tokens,
		"documents":  docs,
		"tokenizer":  *tokPath,
		"byte_level": tok.ByteLevel,
	}
	mb, _ := json.MarshalIndent(meta, "", "  ")
	if err := os.WriteFile(*out+".json", mb, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "error: write meta: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[tokenize] DONE: %d docs → %d tokens (%s) in %.1fs → %s.bin\n",
		docs, tokens, dtype, time.Since(start).Seconds(), *out)
}
