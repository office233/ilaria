package cortex

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// ─────────────────────────────────────────────────────────────────────
// Splitter unit test — llama3PreTokenize vs Python's `tokenizers`
// ─────────────────────────────────────────────────────────────────────

// TestLlama3PreTokenize pins the hand-rolled scanner against the actual
// Llama-3 regex, split-stage only (no byte remapping). Expected chunks
// are literals taken from:
//
//	tokenizers.pre_tokenizers.Split(
//	    pattern=Regex(PAT), behavior="isolated"
//	).pre_tokenize_str(in)
//
// run against tokenizer.json's own pattern string, so these are not
// hand-derived — they are what the reference implementation actually
// produces. (A broader, generated 200+-case cross-check against Python's
// `regex` module, which supports the pattern verbatim, was used to
// design llama3PreTokenize in the first place; these 30 are the
// committed regression set.)
func TestLlama3PreTokenize(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"Hello world!", []string{"Hello", " world", "!"}},
		{"  leading and   multiple   spaces  ", []string{" ", " leading", " and", "  ", " multiple", "  ", " spaces", "  "}},
		{"trailing spaces   ", []string{"trailing", " spaces", "   "}},
		{"line1\nline2\r\nline3\n\nline4", []string{"line", "1", "\n", "line", "2", "\r\n", "line", "3", "\n\n", "line", "4"}},
		{"tab\tseparated\tvalues", []string{"tab", "\tseparated", "\tvalues"}},
		{"mixed\r\n\r\nnewlines\n\n\ncount", []string{"mixed", "\r\n\r\n", "newlines", "\n\n\n", "count"}},
		{"  \n  spaces before newline  \n  ", []string{"  \n", " ", " spaces", " before", " newline", "  \n", "  "}},
		{"!!!hello world!!!", []string{"!!!", "hello", " world", "!!!"}},
		{"#hashtag and @mention", []string{"#hashtag", " and", " @", "mention"}},
		{"A1B2C3 mixed alnum42text", []string{"A", "1", "B", "2", "C", "3", " mixed", " alnum", "42", "text"}},
		{"   ", []string{"   "}},
		{"\n\n\n", []string{"\n\n\n"}},
		{"a", []string{"a"}},
		{"\r\r\r", []string{"\r\r\r"}},
		{"\r\n\r\n", []string{"\r\n\r\n"}},
		{" \r\n ", []string{" \r\n", " "}},
		{"\t\t\n\t\t", []string{"\t\t\n", "\t\t"}},
		{"x \n\n\n y", []string{"x", " \n\n\n", " y"}},
		{"x\n \n y", []string{"x", "\n \n", " y"}},
		{"x \t\n\t y", []string{"x", " \t\n", "\t", " y"}},
		{"word1234567890word", []string{"word", "123", "456", "789", "0", "word"}},
		{"I'm you're it's we'll they'd I've can't won't", []string{"I", "'m", " you", "'re", " it", "'s", " we", "'ll", " they", "'d", " I", "'ve", " can", "'t", " won", "'t"}},
		{"'S 'T 'RE 'VE 'LL 'D 'M", []string{"'S", " '", "T", " '", "RE", " '", "VE", " '", "LL", " '", "D", " '", "M"}},
		{"-word_test.case", []string{"-word", "_test", ".case"}},
		{"(paren)[bracket]{brace}", []string{"(paren", ")[", "bracket", "]{", "brace", "}"}},
		{"combining: e\u0301 accent", []string{"combining", ":", " e", "\u0301", " accent"}},
		{"Numbers: 1 12 123 1234 12345", []string{"Numbers", ":", " ", "1", " ", "12", " ", "123", " ", "123", "4", " ", "123", "45"}},
		{"Diacritics: \u0103\u00e2\u00ee\u0219\u021b", []string{"Diacritics", ":", " \u0103\u00e2\u00ee\u0219\u021b"}},
		{"path/to/file.txt", []string{"path", "/to", "/file", ".txt"}},
		{"!important", []string{"!important"}},
	}
	for _, c := range cases {
		got := llama3PreTokenize(c.in)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("llama3PreTokenize(%q) =\n  got  %q\n  want %q", c.in, got, c.want)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────
// ignore_merges: proof it's a behavioural requirement, not just speed
// ─────────────────────────────────────────────────────────────────────

// TestLlama3IgnoreMergesShortCircuit builds a tiny synthetic vocab where
// "xyz" is a direct vocab entry that the recorded merge list alone
// cannot reconstruct from individual bytes (only "y"+"z" is a merge; no
// path from there to "xyz" exists). This mirrors — at toy scale — the
// ~0.5% of BitNet-2B4T's real 128k vocab where the same gap exists
// (verified empirically against the actual tokenizer.json while
// designing this loader). Without IgnoreMerges, encoding "xyz" stops at
// ["x","yz"]; with it, the whole-piece vocab hit wins and produces the
// single "xyz" token, matching what the real tokenizer does.
func TestLlama3IgnoreMergesShortCircuit(t *testing.T) {
	vocab := map[string]int{"x": 0, "y": 1, "z": 2, "yz": 3, "xyz": 4}
	idToToken := make([]string, len(vocab))
	for tok, id := range vocab {
		idToToken[id] = tok
	}
	merges := []MergePair{{A: "y", B: "z"}}
	rank := map[string]int{mergeKey("y", "z"): 0}

	newTok := func(ignoreMerges bool) *BPETokenizer {
		return &BPETokenizer{
			VocabSize:    len(idToToken),
			Merges:       merges,
			TokenToID:    vocab,
			IDToToken:    idToToken,
			mergeRank:    rank,
			ByteLevel:    true,
			Llama3:       true,
			IgnoreMerges: ignoreMerges,
		}
	}

	gotWith := newTok(true).encodeLlama3Piece("xyz")
	gotWithout := newTok(false).encodeLlama3Piece("xyz")

	if want := []int{vocab["xyz"]}; !idsEqual(gotWith, want) {
		t.Errorf("with IgnoreMerges: got %v, want %v (single direct token)", gotWith, want)
	}
	if want := []int{vocab["x"], vocab["yz"]}; !idsEqual(gotWithout, want) {
		t.Errorf("without IgnoreMerges: got %v, want %v (merge-list result)", gotWithout, want)
	}
	if idsEqual(gotWith, gotWithout) {
		t.Fatal("test is vacuous: both configs produced the same result")
	}
}

// ─────────────────────────────────────────────────────────────────────
// Chat template
// ─────────────────────────────────────────────────────────────────────

// TestLlama3ChatPrompt pins Llama3ChatPrompt's output against jinja2's
// own rendering of BitNet-2B4T's real chat_template (verified directly
// with `jinja2.Environment().from_string(chat_template).render(...)`
// while writing this function — see this file's package doc and
// forge/llama3_tokenizer_reference.py's chat subcommand, which
// re-derives the same strings at equivalence-test time).
func TestLlama3ChatPrompt(t *testing.T) {
	cases := []struct {
		name   string
		system string
		user   string
		want   string
	}{
		{
			name:   "system+user, user has padding whitespace that trim must strip",
			system: "You are a helpful assistant.",
			user:   "  What is 2+2?  ",
			want:   "System: You are a helpful assistant.<|eot_id|>User: What is 2+2?<|eot_id|>Assistant: ",
		},
		{
			name: "user only, no system turn",
			user: "What is the capital of Romania?",
			want: "User: What is the capital of Romania?<|eot_id|>Assistant: ",
		},
	}
	for _, c := range cases {
		if got := Llama3ChatPrompt(c.system, c.user); got != c.want {
			t.Errorf("%s:\n  got  %q\n  want %q", c.name, got, c.want)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────
// Full equivalence test against the real tokenizer.json
// ─────────────────────────────────────────────────────────────────────

// llama3TokenizerPaths returns (tokenizer.json, tokenizer_config.json),
// skipping the test when the tokenizer.json isn't present.
func llama3TokenizerPaths(t *testing.T) (tokPath, cfgPath string) {
	t.Helper()
	dir := filepath.Join("..", "data", "pretrained", "bitnet-b1.58-2B-4T")
	tokPath = filepath.Join(dir, "tokenizer.json")
	cfgPath = filepath.Join(dir, "tokenizer_config.json")
	if _, err := os.Stat(tokPath); err != nil {
		t.Skipf("tokenizer.json not present (%v) — download microsoft/bitnet-b1.58-2B-4T's "+
			"tokenizer.json/tokenizer_config.json/special_tokens_map.json into %s", err, dir)
	}
	return tokPath, cfgPath
}

// idsEqual compares two id slices treating a nil slice and an empty
// slice as equal (reflect.DeepEqual would not: Encode returns nil for
// empty input, but json.Unmarshal of "[]" produces a non-nil []int{}).
func idsEqual(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestLlama3Equivalence is the contract between the real HF tokenizer
// (via forge/llama3_tokenizer_reference.py, which loads tokenizer.json
// with tokenizers.Tokenizer.from_file) and cortex.LoadHFTokenizerJSON +
// BPETokenizer.Encode: every line of a 300+-line diverse corpus must
// produce IDENTICAL ids in both. It also checks Decode(Encode(s)) == s
// for every line that doesn't embed a special token, and that
// Llama3ChatPrompt reproduces the same rendered string (and ids) as
// jinja2 rendering the checkpoint's actual chat_template.
//
// Skipped when tokenizer.json isn't present. Requires python3 with the
// `tokenizers` (and, for the chat check, `jinja2`) packages installed —
// both bundled with the transformers install this task set up.
func TestLlama3Equivalence(t *testing.T) {
	tokPath, cfgPath := llama3TokenizerPaths(t)

	tok, err := LoadHFTokenizerJSON(tokPath)
	if err != nil {
		t.Fatalf("LoadHFTokenizerJSON: %v", err)
	}
	t.Logf("loaded: vocab=%d ignore_merges=%v bos=%d end_of_text=%d eot_id=%d start_header=%d end_header=%d",
		tok.ActualVocabSize(), tok.IgnoreMerges, tok.BosID(), tok.EndOfTextID(), tok.EotID(),
		tok.StartHeaderID(), tok.EndHeaderID())
	if tok.EosID() != tok.EotID() {
		t.Errorf("EosID() = %d, want it to match EotID() = %d for BitNet-2B4T (tokenizer_config.json's eos_token is <|eot_id|>)", tok.EosID(), tok.EotID())
	}
	if tok.BosID() != 128000 {
		t.Errorf("BosID() = %d, want 128000", tok.BosID())
	}
	if tok.EndOfTextID() != 128001 {
		t.Errorf("EndOfTextID() = %d, want 128001", tok.EndOfTextID())
	}
	if tok.EotID() != 128009 {
		t.Errorf("EotID() = %d, want 128009", tok.EotID())
	}

	corpus := buildLlama3Corpus()
	if len(corpus) < 300 {
		t.Fatalf("test corpus has %d lines, want >= 300", len(corpus))
	}

	dir := t.TempDir()
	inPath := filepath.Join(dir, "corpus.jsonl")
	outPath := filepath.Join(dir, "ids.jsonl")
	writeJSONLStrings(t, inPath, corpus)

	runPython(t, "../forge/llama3_tokenizer_reference.py", "ids",
		"--tokenizer", tokPath, "--in", inPath, "--out", outPath)

	refIDs := readJSONLIDs(t, outPath)
	if len(refIDs) != len(corpus) {
		t.Fatalf("reference produced %d id-lines, want %d (one per corpus line)", len(refIDs), len(corpus))
	}

	mismatches := 0
	roundTripFailures := 0
	for i, line := range corpus {
		got := tok.Encode(line)
		want := refIDs[i]
		if !idsEqual(got, want) {
			mismatches++
			if mismatches <= 15 {
				t.Errorf("line %d mismatch\n  text: %q\n  go:   %v\n  py:   %v", i, line, got, want)
			}
			continue
		}
		if !strings.Contains(line, "<|") {
			if back := tok.Decode(got); back != line {
				roundTripFailures++
				if roundTripFailures <= 15 {
					t.Errorf("line %d round-trip: Decode(Encode(%q)) = %q", i, line, back)
				}
			}
		}
	}
	if mismatches > 0 || roundTripFailures > 0 {
		t.Fatalf("%d/%d lines mismatched the Python reference, %d round-trip failures",
			mismatches, len(corpus), roundTripFailures)
	}
	t.Logf("%d/%d lines matched the Python reference exactly (0 mismatches, 0 round-trip failures)", len(corpus), len(corpus))

	// Chat template: Go's rendering must match jinja2's, and Go's ids
	// for that rendering must match the real tokenizer's ids for it.
	system := "You are a helpful assistant."
	user := "What is the capital of Romania?"
	chatOut := runPythonOutput(t, "../forge/llama3_tokenizer_reference.py", "chat",
		"--tokenizer", tokPath, "--config", cfgPath, "--system", system, "--user", user)
	var chatRef struct {
		Rendered string `json:"rendered"`
		IDs      []int  `json:"ids"`
	}
	if err := json.Unmarshal(chatOut, &chatRef); err != nil {
		t.Fatalf("parse chat reference output: %v\nraw: %s", err, chatOut)
	}
	gotPrompt := Llama3ChatPrompt(system, user)
	if gotPrompt != chatRef.Rendered {
		t.Fatalf("Llama3ChatPrompt rendering mismatch:\n  go: %q\n  py: %q", gotPrompt, chatRef.Rendered)
	}
	gotChatIDs := tok.Encode(gotPrompt)
	if !idsEqual(gotChatIDs, chatRef.IDs) {
		t.Fatalf("chat prompt ids mismatch:\n  go: %v\n  py: %v", gotChatIDs, chatRef.IDs)
	}
	t.Logf("chat template ids match: %v", gotChatIDs)
}

// ─────────────────────────────────────────────────────────────────────
// Subprocess + JSONL plumbing
// ─────────────────────────────────────────────────────────────────────

func runPython(t *testing.T, args ...string) {
	t.Helper()
	cmd := exec.Command("python3", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("python3 %s: %v\n%s", strings.Join(args, " "), err, stderr.String())
	}
}

func runPythonOutput(t *testing.T, args ...string) []byte {
	t.Helper()
	cmd := exec.Command("python3", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("python3 %s: %v\n%s", strings.Join(args, " "), err, stderr.String())
	}
	return out
}

// writeJSONLStrings writes one JSON-encoded string per line, so a
// corpus entry may itself contain \n, \r, \t etc. without breaking the
// one-record-per-line framing forge/llama3_tokenizer_reference.py reads.
func writeJSONLStrings(t *testing.T, path string, lines []string) {
	t.Helper()
	var b bytes.Buffer
	for _, s := range lines {
		enc, err := json.Marshal(s)
		if err != nil {
			t.Fatalf("marshal corpus line %q: %v", s, err)
		}
		b.Write(enc)
		b.WriteByte('\n')
	}
	if err := os.WriteFile(path, b.Bytes(), 0644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// readJSONLIDs reads one JSON id-array per line.
func readJSONLIDs(t *testing.T, path string) [][]int {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var out [][]int
	for _, line := range strings.Split(strings.TrimRight(string(raw), "\n"), "\n") {
		if line == "" {
			continue
		}
		var ids []int
		if err := json.Unmarshal([]byte(line), &ids); err != nil {
			t.Fatalf("parse ids line %q: %v", line, err)
		}
		out = append(out, ids)
	}
	return out
}

// ─────────────────────────────────────────────────────────────────────
// Corpus
// ─────────────────────────────────────────────────────────────────────

// buildLlama3Corpus assembles a 300+-line diverse corpus covering every
// category the task asked for: English, Romanian with diacritics, code
// with tabs/newlines, numbers of 1-7 digits, contractions (including
// uppercase), emoji/CJK, repeated spaces, trailing spaces, mixed
// newlines, and special tokens embedded mid-text.
func buildLlama3Corpus() []string {
	var c []string

	// English.
	c = append(c,
		"Hello, world!",
		"The quick brown fox jumps over the lazy dog.",
		"NexusCortex is an experimental sparse cognitive architecture written in Go.",
		"Byte-pair encoding operates directly on UTF-8 bytes, so no input is out of vocabulary.",
		"A sparse distributed representation activates a small fraction of a large bit array.",
		"How much wood would a woodchuck chuck if a woodchuck could chuck wood?",
		"She sells seashells by the seashore.",
		"Reading comprehension improves with practice and repetition.",
		"The 2B4T checkpoint packs ternary ({-1,0,1}) weights into 2-bit codes on disk.",
		"Please encode this sentence exactly as the reference tokenizer would.",
		"Go 1.26 targets Windows, Linux, and macOS uniformly.",
		"A hippocampus-inspired module handles fast, one-shot episodic memory.",
		"Artificial intelligence research spans symbolic and connectionist traditions alike.",
		"Every byte maps to a printable Unicode symbol before BPE ever sees it.",
		"Case matters: Hello, HELLO, hello, and HeLLo are four distinct pre-tokens.",
		"Testing edge cases is tedious but it's how bugs get caught before production.",
		"Wernicke's area and Broca's area are both modeled as separate cortex regions here.",
		"Continual learning without catastrophic forgetting remains an open problem.",
		"The quick brown fox jumps; the lazy dog sleeps.",
		"Short.",
		"A",
		"I",
		"Do you understand how tokenization works?",
		"Ambiguity in natural language makes parsing genuinely hard.",
		"Compression and prediction are two sides of the same coin in language modeling.",
		"Version 5.3.0 of transformers introduced several breaking changes.",
		"The cat sat on the mat while the dog barked outside.",
		"Twenty-three skidoo!",
		"What time is it right now, exactly?",
		"Nothing beats a well-written test suite for catching regressions early.",
	)

	// Romanian with diacritics.
	c = append(c,
		"Bună ziua, ce mai faci?",
		"Aceasta este o propoziție în limba română cu diacritice: ă â î ș ț.",
		"Județul Cluj se află în regiunea Transilvania.",
		"Mulțumesc foarte mult pentru ajutor!",
		"Îmi place să citesc cărți despre inteligența artificială.",
		"Bucureștiul este capitala României.",
		"Astăzi este o zi frumoasă și însorită.",
		"Nu știu dacă o să reușesc să termin până mâine.",
		"Șoferul a oprit mașina lângă trotuar.",
		"Copiii se joacă fericiți în curtea școlii.",
		"Vă rugăm să completați formularul cu atenție.",
		"Îndrăgostiții se plimbau pe malul mării.",
		"Președintele a ținut un discurs important aseară.",
		"Fructele și legumele proaspete sunt esențiale pentru sănătate.",
		"Împărăția română avea odinioară granițe întinse.",
		"După-amiază vom merge la cumpărături în oraș.",
		"Câinele latră, iar pisica toarce liniștită.",
		"Străzile orașului erau pustii la ora aceea târzie.",
		"Întrebarea ta este foarte interesantă și complexă.",
		"Zăpada a acoperit întregul câmp peste noapte.",
		"Șase plus șapte fac treisprezece.",
		"Însă lucrurile nu sunt mereu așa cum par.",
		"Îți mulțumesc din suflet pentru sprijinul acordat.",
		"Grădina botanică găzduiește specii rare de plante.",
		"Weekend-ul acesta plănuim o excursie la munte.",
		"El administrează cu grijă baza de date a spitalului.",
		"Reținerea informațiilor medicale necesită proceduri stricte.",
		"Amoxicilina și ibuprofenul sunt medicamente frecvent prescrise.",
		"Aspirina se administrează cu precauție pacienților cardiaci.",
		"Warfarina interacționează periculos cu multe alte substanțe.",
	)

	// Code with tabs and newlines.
	c = append(c,
		"func main() {\n\tfmt.Println(\"hello\")\n}",
		"for i := 0; i < 10; i++ {\n\tsum += i\n}",
		"if err != nil {\n\treturn nil, err\n}",
		"def encode(text):\n\treturn tokenizer.encode(text).ids",
		"class Foo:\n\tdef __init__(self):\n\t\tself.x = 1",
		"SELECT * FROM users\nWHERE active = 1\nORDER BY id;",
		"{\n\t\"key\": \"value\",\n\t\"nested\": {\n\t\t\"a\": 1\n\t}\n}",
		"import (\n\t\"fmt\"\n\t\"os\"\n)",
		"while True:\n\tprint('loop')\n\tbreak",
		"switch x {\ncase 1:\n\treturn \"one\"\ndefault:\n\treturn \"other\"\n}",
		"#include <stdio.h>\nint main() {\n\tprintf(\"hi\\n\");\n\treturn 0;\n}",
		"const x = () => {\n\treturn 42;\n};",
		"try {\n\tdoSomething();\n} catch (e) {\n\tconsole.log(e);\n}",
		"struct Point {\n\tX, Y int\n}",
		"\tindented with a leading tab\nand a plain second line",
		"a\tb\tc\td\te",
		"func encodeLlama3Piece(pt string) []int {\n\treturn nil\n}",
		"x = 1;\ny = 2;\nz = x + y;",
		"path/to/file.go:42: syntax error",
		"git commit -m \"fix: correct off-by-one error\"",
	)

	// Numbers, 1-7 digits (and beyond, to confirm chunking continues).
	numberSamples := []string{
		"1", "12", "123", "1234", "12345", "123456", "1234567",
		"9", "42", "007", "2026", "99999", "314159", "2718281",
		"0", "10", "100", "1000", "10000", "100000", "1000000",
		"12345678", "123456789", "1234567890",
	}
	for _, n := range numberSamples {
		c = append(c, "value: "+n, n+" units", "x"+n+"y")
	}

	// Contractions, including uppercase and mixed case.
	c = append(c,
		"I'm going home now.",
		"You're the best friend I've ever had.",
		"It's a beautiful day, isn't it?",
		"We'll see what happens next.",
		"They'd rather stay home tonight.",
		"I've never seen anything like it.",
		"Can't stop, won't stop.",
		"Don't worry, it isn't a big deal.",
		"ISN'T that exactly what we discussed?",
		"DIDN'T anyone tell you already?",
		"I'M SURE YOU'LL UNDERSTAND EVENTUALLY.",
		"She's certain we'd never make it in time.",
		"They're not sure if it'll work.",
		"Y'all shouldn't've done that.",
		"'S 'T 'RE 'VE 'LL 'D 'M",
		"He'll call when he's ready.",
		"Wouldn't it be nice if we'd known earlier?",
		"COULDN'T, SHOULDN'T, WOULDN'T.",
		"That's not what I'd have guessed.",
		"We're here, they're there, it's everywhere.",
	)

	// Emoji and CJK.
	c = append(c,
		"Great job! 🎉🔥🚀",
		"你好，世界！",
		"こんにちは世界",
		"안녕하세요 세계",
		"I love pizza 🍕 and tacos 🌮.",
		"这是一个测试句子，包含中文字符。",
		"日本語のテキストをテストしています。",
		"한국어 텍스트 테스트입니다.",
		"Mixed text with emoji 😀 and English words together.",
		"数字123和emoji🎯混合在一起。",
		"星降る夜、静かな街を歩いた。",
		"고양이가 창문 옆에서 잠을 잔다。",
		"🚀🔥💯 all emoji, no text",
		"Café résumé naïve façade — accented Latin too.",
		"Ω≈ç√∫˜µ≤≥÷ — math and Greek symbols.",
		"emoji chain: 😀😃😄😁😆😅😂🤣",
		"中文 + English + Emoji 🎊 in one line.",
		"Здравствуй, мир! Привет!",
		"مرحبا بالعالم",
		"שלום עולם",
	)

	// Repeated spaces.
	c = append(c,
		"word1  word2",
		"word1   word2",
		"word1    word2",
		"  leading double space",
		"trailing double space  ",
		"a  b  c  d  e",
		"one    two    three",
		"spaced  out    words     everywhere",
		"  ",
		"   ",
		"a       b",
		"x  =  1  +  2",
		"multiple   internal     spaces   here",
		"tab and  space mixed",
		"double  space, comma  test",
	)

	// Trailing spaces (and leading).
	c = append(c,
		"trailing space ",
		"trailing spaces   ",
		"trailing tab\t",
		" leading space",
		"   leading spaces",
		"both sides   ",
		"line with trailing space \n",
		"no trailing content here   ",
		"punctuation trail !   ",
		"number trail 123   ",
	)

	// Mixed newlines (\n, \r\n, \r, blank lines).
	c = append(c,
		"line one\nline two",
		"line one\r\nline two",
		"line one\rline two",
		"para one\n\npara two",
		"crlf para\r\n\r\ncrlf para two",
		"mixed\r\n\r\nnewlines\n\n\ncount",
		"line1\nline2\r\nline3\n\nline4",
		"a\r\nb\nc\rd",
		"\n\nstarts with blank lines",
		"ends with blank lines\n\n",
		"\r\n\r\nall crlf at start",
		"trailing crlf\r\n",
		"  \n  spaces before newline  \n  ",
		"tab\tthen\nnewline\tthen\ttab",
		"x \n\n\n y",
	)

	// Special tokens embedded in text.
	c = append(c,
		"Hello<|eot_id|>World",
		"Before <|begin_of_text|> after",
		"System prompt<|eot_id|>User prompt<|eot_id|>",
		"<|begin_of_text|>Once upon a time",
		"text before <|end_of_text|> text after",
		"<|start_header_id|>system<|end_header_id|>",
		"multi<|eot_id|>turn<|eot_id|>conversation<|eot_id|>",
		"<|eot_id|><|eot_id|><|eot_id|>",
		"leading text<|end_header_id|>trailing text",
		"no space<|eot_id|>no space either",
		"space around <|eot_id|> here",
		"<|begin_of_text|><|eot_id|>",
		"Romanian cu diacritice<|eot_id|>și emoji 🎉",
		"code\tblock<|eot_id|>next\nline",
		"numbers 12345<|eot_id|>more text",
	)

	// Punctuation, quotes, symbols, paths, URLs.
	c = append(c,
		"Wait... what?! Really?",
		"He said, \"Hello there.\"",
		"She replied, 'Of course!'",
		"Unicode quotes: “left” and ‘right’.",
		"Symbols: @#$%^&*()_+-=[]{}|;:,.<>?/~`",
		"path/to/file.txt",
		"C:\\Windows\\System32\\drivers",
		"http://example.com/path?query=1&other=2",
		"https://github.com/anthropic/claude",
		"email@example.com is an email address.",
		"3.14159 is pi, roughly.",
		"100% sure, 50/50 chance, $19.99 price.",
		"#hashtag @mention $ticker",
		"(parens) [brackets] {braces}",
		"em—dash and en–dash usage.",
		"a/b/c/d/e/f",
		"key=value&other=thing",
		"1+1=2, 2*3=6, 10/2=5",
		"a.b.c.d version string",
		"multi---dash----test",
	)

	// Numbers of exactly 1-7 digits (systematic coverage of every length
	// the {1,3}-capped digit alternative has to chunk).
	for length := 1; length <= 7; length++ {
		digits := "1234567"[:length]
		c = append(c, digits, "n="+digits, digits+"px")
	}

	// Miscellaneous edge cases.
	c = append(c,
		"",
		" ",
		"\t",
		"\n",
		"x",
		"!important",
		"-word_test.case",
		"(paren)[bracket]{brace}",
		"combining: e\u0301 accent",
		"A1B2C3 mixed alnum42text",
		"word1234567890word",
		"supercalifragilisticexpialidocious",
		"antidisestablishmentarianism",
		"pseudopseudohypoparathyroidism",
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"!!!!!!!!!!!!!!!!!!!!",
		"AAAA aaaa AaAa aAaA",
		"snake_case_variable_name",
		"camelCaseVariableName",
		"kebab-case-variable-name",
		"UPPER_SNAKE_CASE",
	)

	return c
}
