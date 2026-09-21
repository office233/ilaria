// tok-encode — encode stdin lines with a Nexus tokenizer and print one JSON
// array of ids per line. Used to verify that another implementation (the
// HuggingFace `tokenizers` byte-level BPE used in Colab) produces exactly the
// ids the Go engine will see.
//
//	printf 'text\n' | go run ./cmd/tok-encode -tokenizer data/tokenizer.json
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"nexus-cortex/cortex"
)

func main() {
	tokPath := flag.String("tokenizer", "", "tokenizer.json")
	flag.Parse()
	tok, err := cortex.LoadBPETokenizer(*tokPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	enc := json.NewEncoder(os.Stdout)
	for sc.Scan() {
		ids := tok.Encode(sc.Text())
		if ids == nil {
			ids = []int{}
		}
		_ = enc.Encode(ids)
	}
	fmt.Fprintf(os.Stderr, "vocab %d eos %d byte_level %v\n", tok.ActualVocabSize(), tok.EosID(), tok.ByteLevel)
}
