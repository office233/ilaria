package cortex

// tokenizer_gpt2.go — GPT-2 byte-level mode for BPETokenizer.
//
// WHY THIS EXISTS
//
// Pretrained GPT-2 checkpoints come with a byte-level BPE vocabulary
// (vocab.json + merges.txt). Loading those weights into MiniTransformer
// is only useful if we tokenize EXACTLY the way GPT-2 was trained:
// same byte→unicode alphabet, same pre-tokenization splits, same merge
// ranks. This file adds that mode without disturbing the existing
// char-level tokenizer that Nexus trains from scratch.
//
// The merge machinery (applyBPEMerges + mergeRank) is shared: GPT-2's
// merges.txt is just a ranked merge list, which is the same structure
// BPETokenizer already uses. Only three things differ in byte-level
// mode and all are handled here or behind t.ByteLevel branches:
//
//  1. The base alphabet is 256 mapped byte symbols, not runes — so any
//     input (Romanian diacritics included) is representable and <UNK>
//     becomes impossible.
//  2. Pre-tokenization follows GPT-2's regex semantics, which differ
//     from PreTokenize (contractions split, digits split from letters,
//     a single leading space fuses into the following token).
//  3. There is one special token, <|endoftext|> (id 50256), which
//     serves as BOS, EOS, PAD and SEP alike.

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"unicode"
	"unicode/utf8"
)

// GPT2EndOfText is the only special token in the GPT-2 vocabulary.
const GPT2EndOfText = "<|endoftext|>"

// ─────────────────────────────────────────────────────────────────────
// Byte ↔ unicode alphabet
// ─────────────────────────────────────────────────────────────────────

// gpt2ByteEncoder maps each raw byte to the printable rune GPT-2 uses
// for it inside vocab.json; gpt2ByteDecoder is the inverse.
//
// The construction mirrors OpenAI's bytes_to_unicode(): printable
// latin-1 ranges keep their own codepoint, every other byte b gets
// rune(256+n) with n counting those bytes in ascending order. This is
// why a space (0x20) appears as Ġ (U+0120) and newline as Ċ (U+010A).
var gpt2ByteEncoder [256]rune
var gpt2ByteDecoder map[rune]byte

func init() {
	printable := func(b int) bool {
		return (b >= '!' && b <= '~') || (b >= 0xA1 && b <= 0xAC) || (b >= 0xAE && b <= 0xFF)
	}
	gpt2ByteDecoder = make(map[rune]byte, 256)
	n := 0
	for b := 0; b < 256; b++ {
		var r rune
		if printable(b) {
			r = rune(b)
		} else {
			r = rune(256 + n)
			n++
		}
		gpt2ByteEncoder[b] = r
		gpt2ByteDecoder[r] = byte(b)
	}
}

// gpt2EncodeBytes rewrites raw text into the byte-unicode alphabet.
func gpt2EncodeBytes(piece string) string {
	var b strings.Builder
	b.Grow(len(piece) * 2)
	for i := 0; i < len(piece); i++ {
		b.WriteRune(gpt2ByteEncoder[piece[i]])
	}
	return b.String()
}

// gpt2DecodeBytes maps byte-unicode symbols back to raw bytes. Runes
// outside the alphabet (shouldn't happen with a well-formed vocab) are
// dropped rather than corrupting the output.
func gpt2DecodeBytes(sym string) string {
	out := make([]byte, 0, len(sym))
	for _, r := range sym {
		if b, ok := gpt2ByteDecoder[r]; ok {
			out = append(out, b)
		}
	}
	return string(out)
}

// ─────────────────────────────────────────────────────────────────────
// Pre-tokenization
// ─────────────────────────────────────────────────────────────────────

// gpt2PreTokenize splits raw text following the semantics of GPT-2's
// pattern:
//
//	's|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+
//
// Go's RE2 has no lookahead, so this is a hand-rolled scanner. The
// non-obvious consequence of `\s+(?!\S)` + backtracking is encoded in
// the whitespace branch: a whitespace run followed by a non-space
// yields the run MINUS its last character as one piece, and the last
// character then either fuses into the next piece (only if it is a
// literal space — the ` ?` in the alternatives) or stands alone.
//
// Returned pieces are raw text; the caller byte-encodes them.
func gpt2PreTokenize(text string) []string {
	var pieces []string
	i := 0
	pendingSpace := false // a single ' ' waiting to fuse with the next piece

	flushPending := func() {
		if pendingSpace {
			pieces = append(pieces, " ")
			pendingSpace = false
		}
	}

	classOf := func(r rune) int {
		switch {
		case unicode.IsSpace(r):
			return 0
		case unicode.IsLetter(r):
			return 1
		case unicode.IsNumber(r):
			return 2
		default:
			return 3
		}
	}

	for i < len(text) {
		r, _ := utf8.DecodeRuneInString(text[i:])
		cls := classOf(r)

		if cls == 0 {
			// Whitespace run [i, j).
			j := i
			for j < len(text) {
				rr, ss := utf8.DecodeRuneInString(text[j:])
				if !unicode.IsSpace(rr) {
					break
				}
				j += ss
			}
			run := text[i:j]
			if j >= len(text) {
				// Run reaches EOF: `\s+(?!\S)` takes it whole.
				flushPending()
				pieces = append(pieces, run)
				i = j
				break
			}
			// Followed by non-space: emit run minus last ws char.
			_, lastSize := utf8.DecodeLastRuneInString(run)
			head := run[:len(run)-lastSize]
			last := run[len(run)-lastSize:]
			if head != "" {
				flushPending()
				pieces = append(pieces, head)
			}
			if last == " " {
				flushPending()
				pendingSpace = true
			} else {
				flushPending()
				pieces = append(pieces, last)
			}
			i = j
			continue
		}

		// Contractions only match with no fused space (the regex
		// alternatives for them carry no ` ?`).
		if !pendingSpace && r == '\'' {
			rest := text[i:]
			matched := ""
			for _, c := range [...]string{"'s", "'t", "'re", "'ve", "'m", "'ll", "'d"} {
				if strings.HasPrefix(rest, c) {
					matched = c
					break
				}
			}
			if matched != "" {
				pieces = append(pieces, matched)
				i += len(matched)
				continue
			}
		}

		// Letters, numbers, or "other" runs — same shape, different class.
		j := i
		for j < len(text) {
			rr, ss := utf8.DecodeRuneInString(text[j:])
			if classOf(rr) != cls {
				break
			}
			j += ss
		}
		piece := text[i:j]
		if pendingSpace {
			piece = " " + piece
			pendingSpace = false
		}
		pieces = append(pieces, piece)
		i = j
	}
	flushPending()
	return pieces
}

// ─────────────────────────────────────────────────────────────────────
// Loading vocab.json + merges.txt
// ─────────────────────────────────────────────────────────────────────

// LoadGPT2Tokenizer builds a byte-level BPETokenizer from the two files
// every GPT-2-family checkpoint ships with:
//
//   - vocab.json  — {"!": 0, ..., "<|endoftext|>": 50256}
//   - merges.txt  — ranked merge rules, "Ġ t" per line, optional
//     "#version" first line
//
// The result plugs into everything that already accepts *BPETokenizer.
func LoadGPT2Tokenizer(vocabPath, mergesPath string) (*BPETokenizer, error) {
	vocabRaw, err := os.ReadFile(vocabPath)
	if err != nil {
		return nil, fmt.Errorf("read vocab: %w", err)
	}
	var vocab map[string]int
	if err := json.Unmarshal(vocabRaw, &vocab); err != nil {
		return nil, fmt.Errorf("parse vocab: %w", err)
	}
	if _, ok := vocab[GPT2EndOfText]; !ok {
		return nil, fmt.Errorf("vocab has no %s token — not a GPT-2 vocab?", GPT2EndOfText)
	}

	mergesRaw, err := os.ReadFile(mergesPath)
	if err != nil {
		return nil, fmt.Errorf("read merges: %w", err)
	}
	var merges []MergePair
	for _, line := range strings.Split(string(mergesRaw), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" || strings.HasPrefix(line, "#version") {
			continue
		}
		parts := strings.SplitN(line, " ", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			continue
		}
		merges = append(merges, MergePair{A: parts[0], B: parts[1]})
	}
	if len(merges) == 0 {
		return nil, fmt.Errorf("no merges parsed from %s", mergesPath)
	}

	maxID := 0
	for _, id := range vocab {
		if id > maxID {
			maxID = id
		}
	}
	idToToken := make([]string, maxID+1)
	for tok, id := range vocab {
		if id >= 0 && id < len(idToToken) {
			idToToken[id] = tok
		}
	}
	mergeRank := make(map[string]int, len(merges))
	for i, m := range merges {
		mergeRank[mergeKey(m.A, m.B)] = i
	}

	return &BPETokenizer{
		VocabSize: len(idToToken),
		Merges:    merges,
		TokenToID: vocab,
		IDToToken: idToToken,
		mergeRank: mergeRank,
		ByteLevel: true,
	}, nil
}

// gpt2SpecialID returns the id of <|endoftext|>, the token GPT-2 uses
// for every special role.
func (t *BPETokenizer) gpt2SpecialID() int {
	return t.TokenToID[GPT2EndOfText]
}
