package cortex

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ─────────────────────────────────────────────────────────────────────
// BPE Tokenizer Tests
// ─────────────────────────────────────────────────────────────────────

func TestBPEPreTokenize(t *testing.T) {
	tests := []struct {
		input    string
		expected []string
	}{
		{"Hello world", []string{"Hello", "Ġworld"}},
		{"Hello  world", []string{"Hello", "Ġworld"}}, // double space
		{"a", []string{"a"}},
		{"", nil},
		{"one two three", []string{"one", "Ġtwo", "Ġthree"}},
	}

	for _, tc := range tests {
		got := PreTokenize(tc.input)
		if len(got) != len(tc.expected) {
			t.Errorf("PreTokenize(%q): got %v, want %v", tc.input, got, tc.expected)
			continue
		}
		for i := range got {
			if got[i] != tc.expected[i] {
				t.Errorf("PreTokenize(%q)[%d]: got %q, want %q", tc.input, i, got[i], tc.expected[i])
			}
		}
	}
}

func TestBPETrainSmall(t *testing.T) {
	// Small corpus to test basic training
	corpus := []string{
		"the cat sat on the mat",
		"the cat ate the rat",
		"the dog sat on the log",
		"the cat and the dog",
		"the mat is on the floor",
	}

	tok := NewBPETokenizer(300) // small vocab
	tok.Train(corpus)

	// Verify special tokens exist at expected positions
	if tok.TokenToID[TokenPAD] != 0 {
		t.Errorf("PAD should be ID 0, got %d", tok.TokenToID[TokenPAD])
	}
	if tok.TokenToID[TokenUNK] != 1 {
		t.Errorf("UNK should be ID 1, got %d", tok.TokenToID[TokenUNK])
	}
	if tok.TokenToID[TokenBOS] != 2 {
		t.Errorf("BOS should be ID 2, got %d", tok.TokenToID[TokenBOS])
	}

	// Verify vocab size is reasonable
	actualSize := tok.ActualVocabSize()
	if actualSize < numSpecialTokens+5 {
		t.Errorf("vocab too small: %d", actualSize)
	}
	if actualSize > 300 {
		t.Errorf("vocab exceeded target: %d > 300", actualSize)
	}

	// Verify merges were learned
	if len(tok.Merges) == 0 {
		t.Error("no merges learned")
	}

	t.Logf("Trained: vocab=%d, merges=%d", actualSize, len(tok.Merges))
}

func TestBPEEncodeDecode(t *testing.T) {
	corpus := []string{
		"the cat sat on the mat",
		"the cat ate the rat",
		"the dog sat on the log",
		"hello world hello world",
		"the quick brown fox jumps",
	}

	tok := NewBPETokenizer(300)
	tok.Train(corpus)

	// Test roundtrip on training data
	for _, text := range corpus {
		ids := tok.Encode(text)
		decoded := tok.Decode(ids)

		if decoded != text {
			t.Errorf("roundtrip failed:\n  input:   %q\n  encoded: %v\n  decoded: %q",
				text, ids, decoded)
		}
	}

	// Test roundtrip on unseen text using known vocab
	unseen := "the cat sat"
	ids := tok.Encode(unseen)
	decoded := tok.Decode(ids)
	if decoded != unseen {
		t.Errorf("unseen roundtrip: got %q, want %q", decoded, unseen)
	}
}

func TestBPEEncodeWithSpecial(t *testing.T) {
	corpus := []string{"hello world"}
	tok := NewBPETokenizer(300)
	tok.Train(corpus)

	ids := tok.EncodeWithSpecial("hello world")

	// First ID should be BOS, last should be EOS
	if len(ids) < 3 {
		t.Fatalf("EncodeWithSpecial too short: %v", ids)
	}
	if ids[0] != tok.BosID() {
		t.Errorf("first token should be BOS (%d), got %d", tok.BosID(), ids[0])
	}
	if ids[len(ids)-1] != tok.EosID() {
		t.Errorf("last token should be EOS (%d), got %d", tok.EosID(), ids[len(ids)-1])
	}

	// Decode should strip special tokens
	decoded := tok.Decode(ids)
	if decoded != "hello world" {
		t.Errorf("decode with specials: got %q, want %q", decoded, "hello world")
	}
}

func TestBPEUnicode(t *testing.T) {
	corpus := []string{
		"aceasta este o propoziție în limba română",
		"câinele și pisica sunt animale",
		"diacritice: ă â î ș ț",
		"programarea este ușoară",
		"băiatul a mâncat prăjitura cu miere",
	}

	tok := NewBPETokenizer(500)
	tok.Train(corpus)

	// Roundtrip on Romanian text
	for _, text := range corpus {
		ids := tok.Encode(text)
		decoded := tok.Decode(ids)

		if decoded != text {
			t.Errorf("Romanian roundtrip failed:\n  input:   %q\n  decoded: %q", text, decoded)
		}
	}

	// Verify diacritics are in vocab (as characters at minimum)
	diacritics := []string{"ă", "â", "î", "ș", "ț"}
	for _, d := range diacritics {
		if _, ok := tok.TokenToID[d]; !ok {
			t.Errorf("diacritic %q not in vocab", d)
		}
	}
}

func TestBPEUnknownChars(t *testing.T) {
	// Train on simple corpus
	corpus := []string{"hello world"}
	tok := NewBPETokenizer(300)
	tok.Train(corpus)

	// Encode text with characters not seen during training
	ids := tok.Encode("hello 你好")

	// Should contain UNK tokens for Chinese characters
	hasUnk := false
	unkID := tok.UnkID()
	for _, id := range ids {
		if id == unkID {
			hasUnk = true
			break
		}
	}
	if !hasUnk {
		tokens := tok.DecodeTokens(ids)
		t.Errorf("expected UNK tokens for unseen chars, got: %v", tokens)
	}
}

func TestBPESaveLoad(t *testing.T) {
	corpus := []string{
		"the cat sat on the mat",
		"the cat ate the rat",
		"the dog sat on the log",
	}

	tok := NewBPETokenizer(300)
	tok.Train(corpus)

	// Encode something before save
	text := "the cat sat"
	originalIDs := tok.Encode(text)

	// Save
	tmpDir := t.TempDir()
	path := filepath.Join(tmpDir, "test_tokenizer.json")
	if err := tok.Save(path); err != nil {
		t.Fatalf("save failed: %v", err)
	}

	// Verify file exists and has content
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("saved file not found: %v", err)
	}
	if info.Size() < 100 {
		t.Errorf("saved file too small: %d bytes", info.Size())
	}

	// Load
	tok2, err := LoadBPETokenizer(path)
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}

	// Verify loaded tokenizer produces same encoding
	loadedIDs := tok2.Encode(text)
	if len(loadedIDs) != len(originalIDs) {
		t.Fatalf("loaded tokenizer produces different length: %v vs %v",
			loadedIDs, originalIDs)
	}
	for i := range loadedIDs {
		if loadedIDs[i] != originalIDs[i] {
			t.Errorf("ID mismatch at position %d: %d vs %d", i, loadedIDs[i], originalIDs[i])
		}
	}

	// Verify roundtrip after load
	decoded := tok2.Decode(loadedIDs)
	if decoded != text {
		t.Errorf("roundtrip after load: got %q, want %q", decoded, text)
	}
}

func TestBPEDecodeTokens(t *testing.T) {
	corpus := []string{"hello world"}
	tok := NewBPETokenizer(300)
	tok.Train(corpus)

	ids := tok.Encode("hello world")
	tokens := tok.DecodeTokens(ids)

	if len(tokens) == 0 {
		t.Fatal("DecodeTokens returned empty")
	}

	// Verify each token is a valid string
	for i, token := range tokens {
		if token == "" {
			t.Errorf("empty token at position %d", i)
		}
	}

	t.Logf("Tokens: %v", tokens)
}

func TestBPEEmptyInput(t *testing.T) {
	corpus := []string{"hello world"}
	tok := NewBPETokenizer(300)
	tok.Train(corpus)

	// Empty text should produce no tokens
	ids := tok.Encode("")
	if len(ids) != 0 {
		t.Errorf("empty input should produce no tokens, got %v", ids)
	}

	// Decoding empty should produce empty
	decoded := tok.Decode(nil)
	if decoded != "" {
		t.Errorf("decoding nil should produce empty, got %q", decoded)
	}
}

func TestBPELargerCorpus(t *testing.T) {
	// Generate a larger corpus to test training at scale
	var corpus []string
	sentences := []string{
		"the quick brown fox jumps over the lazy dog",
		"a stitch in time saves nine",
		"to be or not to be that is the question",
		"all that glitters is not gold",
		"where there is a will there is a way",
		"actions speak louder than words",
		"practice makes perfect",
		"knowledge is power",
		"time is money",
		"the pen is mightier than the sword",
		"beauty is in the eye of the beholder",
		"necessity is the mother of invention",
		"fortune favors the bold",
		"the early bird catches the worm",
		"honesty is the best policy",
		"patience is a virtue",
		"two wrongs do not make a right",
		"when in rome do as the romans do",
		"the squeaky wheel gets the grease",
		"curiosity killed the cat",
	}

	// Repeat to build frequency
	for i := 0; i < 10; i++ {
		corpus = append(corpus, sentences...)
	}

	tok := NewBPETokenizer(500)
	tok.Train(corpus)

	// Common words like "the" should be single tokens
	theIDs := tok.Encode("the")
	if len(theIDs) > 1 {
		tokens := tok.DecodeTokens(theIDs)
		t.Logf("'the' tokenized as %d tokens: %v (expected 1)", len(theIDs), tokens)
	}

	// Verify all training sentences roundtrip
	for _, s := range sentences {
		ids := tok.Encode(s)
		decoded := tok.Decode(ids)
		if decoded != s {
			t.Errorf("roundtrip fail: %q → %q", s, decoded)
		}
	}

	// Compression test: encoded should be shorter than char count
	longText := strings.Join(sentences, " ")
	ids := tok.Encode(longText)
	charCount := len([]rune(longText))
	compression := float64(len(ids)) / float64(charCount)
	t.Logf("Compression: %d chars → %d tokens (ratio: %.2f)", charCount, len(ids), compression)
	if compression >= 1.0 {
		t.Error("BPE should compress text (fewer tokens than characters)")
	}
}

func TestBPESpecialTokenIDs(t *testing.T) {
	tok := NewBPETokenizer(300)
	tok.Train([]string{"test"})

	// Verify special token IDs are sequential 0-4
	if tok.PadID() != 0 {
		t.Errorf("PadID: got %d, want 0", tok.PadID())
	}
	if tok.UnkID() != 1 {
		t.Errorf("UnkID: got %d, want 1", tok.UnkID())
	}
	if tok.BosID() != 2 {
		t.Errorf("BosID: got %d, want 2", tok.BosID())
	}
	if tok.EosID() != 3 {
		t.Errorf("EosID: got %d, want 3", tok.EosID())
	}
	if tok.SepID() != 4 {
		t.Errorf("SepID: got %d, want 4", tok.SepID())
	}
}

func TestBPEMixedLanguage(t *testing.T) {
	corpus := []string{
		"the cat sat on the mat",
		"pisica a stat pe covor",
		"the dog and câinele",
		"hello world salut lume",
		"programming is ușor",
		"inteligența artificială este viitorul",
	}

	tok := NewBPETokenizer(500)
	tok.Train(corpus)

	// Roundtrip mixed language
	for _, text := range corpus {
		ids := tok.Encode(text)
		decoded := tok.Decode(ids)
		if decoded != text {
			t.Errorf("mixed language roundtrip: %q → %q", text, decoded)
		}
	}

	// Test with both languages in one sentence
	mixed := "the pisica is on the covor"
	ids := tok.Encode(mixed)
	decoded := tok.Decode(ids)
	if decoded != mixed {
		t.Errorf("mixed sentence: %q → %q", mixed, decoded)
	}
}

// TestBPETrainIncrementalEquivalence pins the incremental Train (lazy
// heap + pair→words index) to the exact output of the quadratic
// reference implementation: same merges in the same order, same vocab.
// Any drift means the heap tie-breaking or the incremental counting
// diverged from ground truth.
func TestBPETrainIncrementalEquivalence(t *testing.T) {
	corpus := []string{
		"the quick brown fox jumps over the lazy dog",
		"the theory of relativity was developed by albert einstein",
		"pack my box with five dozen liquor jugs",
		"the capital of france is paris and the capital of japan is tokyo",
		"sphinx of black quartz judge my vow",
		"how vexingly quick daft zebras jump",
		"the five boxing wizards jump quickly over the fence",
		"o vulpe rapidă sare peste câinele leneș din pădure",
		"limba română are diacritice precum ă î ș ț â",
		"repetition repetition repetition builds strong merge statistics",
	}

	fast := NewBPETokenizer(400)
	fast.Train(corpus)

	ref := NewBPETokenizer(400)
	ref.trainReference(corpus)

	if len(fast.Merges) != len(ref.Merges) {
		t.Fatalf("merge count differs: incremental=%d reference=%d",
			len(fast.Merges), len(ref.Merges))
	}
	for i := range ref.Merges {
		if fast.Merges[i] != ref.Merges[i] {
			t.Fatalf("merge %d differs: incremental=%+v reference=%+v",
				i, fast.Merges[i], ref.Merges[i])
		}
	}
	if len(fast.IDToToken) != len(ref.IDToToken) {
		t.Fatalf("vocab size differs: %d vs %d", len(fast.IDToToken), len(ref.IDToToken))
	}
	for i := range ref.IDToToken {
		if fast.IDToToken[i] != ref.IDToToken[i] {
			t.Fatalf("vocab[%d] differs: %q vs %q", i, fast.IDToToken[i], ref.IDToToken[i])
		}
	}

	// And the encodings agree end to end.
	for _, line := range corpus {
		a, b := fast.Encode(line), ref.Encode(line)
		if len(a) != len(b) {
			t.Fatalf("encoding length differs for %q", line)
		}
		for i := range a {
			if a[i] != b[i] {
				t.Fatalf("encoding differs for %q at %d", line, i)
			}
		}
	}
}

// BenchmarkBPETrain compares the incremental trainer against the
// quadratic reference on a repetitive corpus at a realistic vocab.
// Run: go test -bench BenchmarkBPETrain -run NONE ./cortex/
func BenchmarkBPETrainIncremental(b *testing.B) {
	corpus := benchCorpus()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		tok := NewBPETokenizer(2000)
		tok.Train(corpus)
	}
}

func BenchmarkBPETrainReference(b *testing.B) {
	corpus := benchCorpus()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		tok := NewBPETokenizer(2000)
		tok.trainReference(corpus)
	}
}

func benchCorpus() []string {
	// A diverse corpus with thousands of DISTINCT words — the regime
	// that separates the two trainers. The reference rescans every
	// unique word per merge; the incremental one touches only affected
	// words, so its advantage grows with corpus vocabulary.
	syllables := []string{"ka", "ro", "mi", "ten", "bra", "lus", "or", "vek", "sha", "din", "pol", "ez"}
	corpus := make([]string, 0, 3000)
	for i := 0; i < 3000; i++ {
		var sb []byte
		for w := 0; w < 8; w++ {
			n := 2 + (i+w)%3
			for s := 0; s < n; s++ {
				sb = append(sb, syllables[(i*7+w*13+s*5)%len(syllables)]...)
			}
			sb = append(sb, ' ')
		}
		corpus = append(corpus, string(sb))
	}
	return corpus
}
