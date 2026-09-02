package cortex

import (
	"path/filepath"
	"reflect"
	"testing"
)

// TestGPT2ByteAlphabet_Bijection: 256 distinct symbols, exact inverse,
// and the two anchor points everyone recognises from GPT-2 vocabs.
func TestGPT2ByteAlphabet_Bijection(t *testing.T) {
	seen := make(map[rune]bool, 256)
	for b := 0; b < 256; b++ {
		r := gpt2ByteEncoder[b]
		if seen[r] {
			t.Fatalf("byte %d maps to duplicate rune %q", b, r)
		}
		seen[r] = true
		if back, ok := gpt2ByteDecoder[r]; !ok || back != byte(b) {
			t.Fatalf("roundtrip failed for byte %d", b)
		}
	}
	if gpt2ByteEncoder[' '] != 'Ġ' {
		t.Errorf("space maps to %q, want Ġ", gpt2ByteEncoder[' '])
	}
	if gpt2ByteEncoder['\n'] != 'Ċ' {
		t.Errorf("newline maps to %q, want Ċ", gpt2ByteEncoder['\n'])
	}
}

// TestGPT2PreTokenize verifies the hand-rolled scanner against the
// regex semantics it replicates (values derived from GPT-2's pattern:
// contractions split, class changes split, one space fuses forward,
// longer whitespace runs keep all but their last space separate).
func TestGPT2PreTokenize(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"Hello world!", []string{"Hello", " world", "!"}},
		{"don't stop", []string{"don", "'t", " stop"}},
		{"I'll go", []string{"I", "'ll", " go"}},
		{"abc123", []string{"abc", "123"}},
		{"x = 42", []string{"x", " =", " 42"}},
		{"  double", []string{" ", " double"}},
		{"a\nb", []string{"a", "\n", "b"}},
		{"end.  ", []string{"end", ".", "  "}},
		{"salută", []string{"salută"}},
		{"", nil},
	}
	for _, c := range cases {
		got := gpt2PreTokenize(c.in)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("PreTokenize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// buildTinyGPT2Tokenizer constructs a minimal byte-level tokenizer in
// memory: base alphabet + a few merges, plus <|endoftext|>. Enough to
// exercise the full encode→merge→decode path without the real 50k vocab.
func buildTinyGPT2Tokenizer(t *testing.T) *BPETokenizer {
	t.Helper()
	vocab := make(map[string]int)
	id := 0
	for b := 0; b < 256; b++ {
		vocab[string(gpt2ByteEncoder[b])] = id
		id++
	}
	merges := []MergePair{
		{A: "h", B: "e"},       // he
		{A: "l", B: "l"},       // ll
		{A: "he", B: "ll"},     // hell
		{A: "hell", B: "o"},    // hello
		{A: "Ġ", B: "w"},       // Ġw
		{A: "Ġw", B: "o"},      // Ġwo
	}
	for _, m := range merges {
		vocab[m.A+m.B] = id
		id++
	}
	vocab[GPT2EndOfText] = id

	idToToken := make([]string, id+1)
	for tok, i := range vocab {
		idToToken[i] = tok
	}
	rank := make(map[string]int, len(merges))
	for i, m := range merges {
		rank[mergeKey(m.A, m.B)] = i
	}
	return &BPETokenizer{
		VocabSize: len(idToToken),
		Merges:    merges,
		TokenToID: vocab,
		IDToToken: idToToken,
		mergeRank: rank,
		ByteLevel: true,
	}
}

// TestGPT2Tokenizer_EncodeDecodeRoundtrip: byte-level coverage means
// ANY string — Romanian diacritics and newlines included — survives
// encode→decode exactly. This is the property the char-level tokenizer
// cannot offer (unseen chars become <UNK>).
func TestGPT2Tokenizer_EncodeDecodeRoundtrip(t *testing.T) {
	tok := buildTinyGPT2Tokenizer(t)
	cases := []string{
		"hello world",
		"hello, world!",
		"Salută, ăsta e un test șțâî",
		"line one\nline two\n",
		"tabs\tand  spaces",
	}
	for _, c := range cases {
		ids := tok.Encode(c)
		if len(ids) == 0 {
			t.Errorf("Encode(%q) produced no ids", c)
			continue
		}
		back := tok.Decode(ids)
		if back != c {
			t.Errorf("roundtrip %q → %q", c, back)
		}
	}
}

// TestGPT2Tokenizer_MergesApply: the shared merge machinery must pick
// ranked merges exactly as GPT-2 does — "hello" collapses to one token
// via 4 chained merges, " wo" ends as Ġwo+r+l+d.
func TestGPT2Tokenizer_MergesApply(t *testing.T) {
	tok := buildTinyGPT2Tokenizer(t)
	ids := tok.Encode("hello world")
	toks := tok.DecodeTokens(ids)
	want := []string{"hello", "Ġwo", "r", "l", "d"}
	if !reflect.DeepEqual(toks, want) {
		t.Errorf("tokens = %q, want %q", toks, want)
	}
}

// TestGPT2Tokenizer_SpecialsCollapse: every special-role accessor must
// resolve to <|endoftext|> in byte-level mode, EncodeWithSpecial must
// frame with it, and Decode must strip it.
func TestGPT2Tokenizer_SpecialsCollapse(t *testing.T) {
	tok := buildTinyGPT2Tokenizer(t)
	eot := tok.TokenToID[GPT2EndOfText]
	for name, got := range map[string]int{
		"PadID": tok.PadID(), "UnkID": tok.UnkID(),
		"BosID": tok.BosID(), "EosID": tok.EosID(), "SepID": tok.SepID(),
	} {
		if got != eot {
			t.Errorf("%s = %d, want endoftext id %d", name, got, eot)
		}
	}

	ids := tok.EncodeWithSpecial("hello")
	if ids[0] != eot || ids[len(ids)-1] != eot {
		t.Errorf("EncodeWithSpecial not framed by endoftext: %v", ids)
	}
	if got := tok.Decode(ids); got != "hello" {
		t.Errorf("Decode with specials = %q, want %q", got, "hello")
	}
}

// TestGPT2Tokenizer_SaveLoadPreservesByteLevel: persistence must keep
// the mode flag — a byte-level vocab reloaded as char-level would
// silently produce garbage ids.
func TestGPT2Tokenizer_SaveLoadPreservesByteLevel(t *testing.T) {
	tok := buildTinyGPT2Tokenizer(t)
	path := filepath.Join(t.TempDir(), "tok.json")
	if err := tok.Save(path); err != nil {
		t.Fatalf("save: %v", err)
	}
	back, err := LoadBPETokenizer(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !back.ByteLevel {
		t.Fatal("ByteLevel flag lost in save/load")
	}
	in := "hello world\n"
	if got, want := back.Decode(back.Encode(in)), in; got != want {
		t.Errorf("post-reload roundtrip %q → %q", want, got)
	}
	if back.EosID() != back.TokenToID[GPT2EndOfText] {
		t.Error("EosID wrong after reload")
	}
}
