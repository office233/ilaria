// tok-stats — measure a Nexus tokenizer on held-out text: tokens per
// character (per language file), <UNK> rate, and diacritics round-trip.
//
//	go run ./cmd/tok-stats -tokenizer data/tokenizer-ro-en-32k.json -ro file.txt -en file.txt
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

	"nexus-cortex/cortex"
)

func main() {
	tokPath := flag.String("tokenizer", "", "tokenizer.json")
	roPath := flag.String("ro", "", "held-out Romanian text (one doc per line)")
	enPath := flag.String("en", "", "held-out English text (one doc per line)")
	maxLines := flag.Int("max-lines", 2000, "lines per file")
	flag.Parse()
	tok, err := cortex.LoadBPETokenizer(*tokPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("vocab %d, eos %d\n", tok.ActualVocabSize(), tok.EosID())
	for _, probe := range []string{"Ștefan cel Mare a fost domnul Moldovei între 1457 și 1504.", "În această după-amiază, copiii învață să citească.", "The quick brown fox jumps over the lazy dog."} {
		ids := tok.Encode(probe)
		back := tok.Decode(ids)
		fmt.Printf("probe %q → %d tokens, roundtrip %v\n", probe, len(ids), back == probe)
		if back != probe {
			fmt.Printf("   decoded: %q\n", back)
		}
	}
	unkID := -1
	for i := 0; i < tok.ActualVocabSize(); i++ {
		if tok.Decode([]int{i}) == cortex.TokenUNK {
			unkID = i
			break
		}
	}
	for _, f := range []struct{ lang, path string }{{"ro", *roPath}, {"en", *enPath}} {
		if f.path == "" {
			continue
		}
		fh, err := os.Open(f.path)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			continue
		}
		sc := bufio.NewScanner(fh)
		sc.Buffer(make([]byte, 1<<20), 1<<24)
		var chars, toks, unk, words, lines int
		for sc.Scan() && lines < *maxLines {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			lines++
			ids := tok.Encode(line)
			chars += utf8.RuneCountInString(line)
			words += len(strings.Fields(line))
			toks += len(ids)
			for _, id := range ids {
				if id == unkID {
					unk++
				}
			}
		}
		fh.Close()
		fmt.Printf("%s: %d lines, %.3f tokens/char, %.2f tokens/word, UNK %.4f%%\n", f.lang, lines, float64(toks)/float64(chars), float64(toks)/float64(words), 100*float64(unk)/float64(toks))
	}
}
