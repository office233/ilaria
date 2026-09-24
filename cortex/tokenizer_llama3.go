package cortex

// tokenizer_llama3.go — Llama-3 / BitNet-b1.58-2B-4T byte-level BPE mode
// for BPETokenizer.
//
// WHY THIS EXISTS
//
// microsoft/bitnet-b1.58-2B-4T ships Meta's Llama-3 tokenizer verbatim: a
// tiktoken-style byte-level BPE with a 128,256-entry vocabulary (128,000
// merge-built tokens + 256 named special tokens) exported in Hugging
// Face's tokenizer.json format. Loading that checkpoint into Nexus is
// only useful if this engine tokenizes EXACTLY the way it was trained —
// same byte alphabet (shared with GPT-2, see tokenizer_gpt2.go), same
// pre-tokenization splits, same merge behaviour, same special tokens.
//
// This differs from the existing GPT-2 byte-level mode in three ways,
// each handled here behind t.Llama3:
//
//  1. Pre-tokenization regex. Llama-3's PAT string is not GPT-2's — see
//     llama3PreTokenize's doc comment for the exact differences (a
//     case-insensitive contraction match, a broader single-char prefix
//     class before letter runs, digit runs capped at 3, and CR/LF fusion
//     rules absent from GPT-2's pattern). Go's RE2 has neither lookahead
//     nor inline case-insensitive groups, so — as with GPT-2 — this is a
//     hand-rolled scanner, verified against Python's `regex` module
//     (which does support the pattern natively) on 200+ generated cases
//     plus the literals in TestLlama3PreTokenize.
//  2. ignore_merges. tokenizer.json sets model.ignore_merges: true —
//     required for exact parity, not just a speed optimization: for this
//     vocab, running the merge algorithm to completion from individual
//     bytes fails to reconstruct ~0.5% of vocab entries that a direct
//     whole-pre-token vocab lookup reaches. encodeLlama3Piece checks the
//     vocab first and only falls back to applyBPEMerges on a miss.
//  3. 256 special tokens (vs. GPT-2's one), recognised as atomic units
//     wherever they occur in raw input text — matching HF's
//     split_special_tokens=False default — via specialTokenRe.

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ─────────────────────────────────────────────────────────────────────
// Loading tokenizer.json
// ─────────────────────────────────────────────────────────────────────

// hfTokenizerJSON is the subset of a Hugging Face tokenizer.json this
// loader understands: a byte-level BPE model with an added-tokens table
// for the specials. Fields not needed for encode/decode (normalizer,
// truncation, padding, post_processor's BOS-wrapping template) are
// intentionally not modeled — Encode never adds BOS on its own, matching
// the rest of BPETokenizer's API (EncodeWithSpecial exists for that).
type hfTokenizerJSON struct {
	Model struct {
		Type         string            `json:"type"`
		Vocab        map[string]int    `json:"vocab"`
		Merges       []json.RawMessage `json:"merges"`
		IgnoreMerges bool              `json:"ignore_merges"`
	} `json:"model"`
	AddedTokens []struct {
		ID      int    `json:"id"`
		Content string `json:"content"`
		Special bool   `json:"special"`
	} `json:"added_tokens"`
	PreTokenizer json.RawMessage `json:"pre_tokenizer"`
	Decoder      json.RawMessage `json:"decoder"`
}

// LoadHFTokenizerJSON reads a Hugging Face tokenizer.json for a
// tiktoken-style byte-level BPE model — the format
// microsoft/bitnet-b1.58-2B-4T ships (Meta's Llama-3 tokenizer,
// vocab 128,256).
//
// The returned tokenizer is set into Llama3 mode: pre-tokenization uses
// llama3PreTokenize, merges respect the file's ignore_merges flag, and
// added_tokens marked special become atomic units recognised wherever
// they occur in encoded text (see encodeLlama3) and skipped on decode.
//
// This does not attempt to interpret the file's pre_tokenizer/decoder/
// post_processor sections generically — BitNet-2B4T's shape (Split then
// ByteLevel; ByteLevel decoder) is documented and pinned by
// TestLlama3Equivalence, not re-derived at load time. Loading a
// tokenizer.json whose model isn't a BPE model is rejected; a
// differently-shaped BPE (e.g. a different pre-tokenizer regex) would
// load without error but would silently mistokenize — that's what the
// equivalence test guards against.
func LoadHFTokenizerJSON(path string) (*BPETokenizer, error) {
	buf, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read tokenizer.json: %w", err)
	}
	var hf hfTokenizerJSON
	if err := json.Unmarshal(buf, &hf); err != nil {
		return nil, fmt.Errorf("parse tokenizer.json: %w", err)
	}
	if hf.Model.Type != "BPE" {
		return nil, fmt.Errorf("unsupported model.type %q, want BPE", hf.Model.Type)
	}
	if len(hf.Model.Vocab) == 0 {
		return nil, fmt.Errorf("tokenizer.json has an empty model.vocab")
	}

	// added_tokens ids continue past the base vocab (128000..128255 for
	// BitNet-2B4T) — size IDToToken to cover both ranges.
	maxID := 0
	for _, id := range hf.Model.Vocab {
		if id > maxID {
			maxID = id
		}
	}
	for _, at := range hf.AddedTokens {
		if at.ID > maxID {
			maxID = at.ID
		}
	}

	tokenToID := make(map[string]int, len(hf.Model.Vocab)+len(hf.AddedTokens))
	idToToken := make([]string, maxID+1)
	for tok, id := range hf.Model.Vocab {
		if id >= 0 && id < len(idToToken) {
			idToToken[id] = tok
			tokenToID[tok] = id
		}
	}
	specials := make(map[string]int, len(hf.AddedTokens))
	for _, at := range hf.AddedTokens {
		if at.ID >= 0 && at.ID < len(idToToken) {
			idToToken[at.ID] = at.Content
			tokenToID[at.Content] = at.ID
		}
		if at.Special {
			specials[at.Content] = at.ID
		}
	}

	merges := make([]MergePair, 0, len(hf.Model.Merges))
	mergeRank := make(map[string]int, len(hf.Model.Merges))
	for i, raw := range hf.Model.Merges {
		a, b, err := parseHFMerge(raw)
		if err != nil {
			return nil, fmt.Errorf("merges[%d]: %w", i, err)
		}
		merges = append(merges, MergePair{A: a, B: b})
		mergeRank[mergeKey(a, b)] = i
	}

	tok := &BPETokenizer{
		VocabSize:     len(idToToken),
		Merges:        merges,
		TokenToID:     tokenToID,
		IDToToken:     idToToken,
		mergeRank:     mergeRank,
		ByteLevel:     true,
		Llama3:        true,
		IgnoreMerges:  hf.Model.IgnoreMerges,
		SpecialTokens: specials,
	}
	tok.buildSpecialTokenMatcher()
	return tok, nil
}

// parseHFMerge decodes one entry of tokenizer.json's model.merges, which
// HuggingFace emits either as "a b" (a single ASCII-space-separated
// string — byte-level tokens never contain a literal 0x20 space
// themselves, since that byte maps to "Ġ" in the byte-unicode alphabet,
// so splitting on the first space is safe) or as the two-element form
// ["a","b"].
func parseHFMerge(raw json.RawMessage) (a, b string, err error) {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		parts := strings.SplitN(s, " ", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return "", "", fmt.Errorf("malformed merge string %q", s)
		}
		return parts[0], parts[1], nil
	}
	var pair [2]string
	if err := json.Unmarshal(raw, &pair); err == nil {
		return pair[0], pair[1], nil
	}
	return "", "", fmt.Errorf("merge entry is neither a string nor a 2-element array: %s", string(raw))
}

// buildSpecialTokenMatcher compiles a single regexp alternating every
// SpecialTokens key (longest first, so no key can shadow a longer one it
// happens to prefix — not the case for BitNet-2B4T's specials today, but
// cheap insurance) for use by encodeLlama3's text-splitting pass.
func (t *BPETokenizer) buildSpecialTokenMatcher() {
	if len(t.SpecialTokens) == 0 {
		t.specialTokenRe = nil
		return
	}
	toks := make([]string, 0, len(t.SpecialTokens))
	for s := range t.SpecialTokens {
		toks = append(toks, s)
	}
	sort.Slice(toks, func(i, j int) bool { return len(toks[i]) > len(toks[j]) })
	parts := make([]string, len(toks))
	for i, s := range toks {
		parts[i] = regexp.QuoteMeta(s)
	}
	t.specialTokenRe = regexp.MustCompile(strings.Join(parts, "|"))
}

// isRegisteredSpecial reports whether token is one of t.SpecialTokens's
// keys. Used by the shared Decode to skip Llama3 specials; always false
// outside Llama3 mode (SpecialTokens is nil).
func (t *BPETokenizer) isRegisteredSpecial(token string) bool {
	if t.SpecialTokens == nil {
		return false
	}
	_, ok := t.SpecialTokens[token]
	return ok
}

// ─────────────────────────────────────────────────────────────────────
// Encoding
// ─────────────────────────────────────────────────────────────────────

// encodeLlama3 is BPETokenizer.Encode's Llama3-mode implementation: split
// out any embedded special tokens first (recognised as atomic units
// regardless of position — matching HF's split_special_tokens=False,
// which applies independently of add_special_tokens), then
// pre-tokenize+BPE-encode the plain-text segments between them.
func (t *BPETokenizer) encodeLlama3(text string) []int {
	if text == "" {
		return nil
	}
	if t.specialTokenRe == nil {
		return t.encodeLlama3Plain(text)
	}
	var ids []int
	pos := 0
	for _, m := range t.specialTokenRe.FindAllStringIndex(text, -1) {
		start, end := m[0], m[1]
		if start > pos {
			ids = append(ids, t.encodeLlama3Plain(text[pos:start])...)
		}
		if id, ok := t.TokenToID[text[start:end]]; ok {
			ids = append(ids, id)
		}
		pos = end
	}
	if pos < len(text) {
		ids = append(ids, t.encodeLlama3Plain(text[pos:])...)
	}
	return ids
}

// encodeLlama3Plain pre-tokenizes and BPE-encodes a text segment known to
// contain no special tokens.
func (t *BPETokenizer) encodeLlama3Plain(text string) []int {
	if text == "" {
		return nil
	}
	var ids []int
	for _, piece := range llama3PreTokenize(text) {
		ids = append(ids, t.encodeLlama3Piece(gpt2EncodeBytes(piece))...)
	}
	return ids
}

// encodeLlama3Piece BPE-encodes one already byte-remapped pre-token. When
// IgnoreMerges is set (true for BitNet-2B4T), a whole-piece vocab hit is
// used directly, bypassing the merge loop — see this file's package doc
// for why that is required, not just faster.
func (t *BPETokenizer) encodeLlama3Piece(pt string) []int {
	if pt == "" {
		return nil
	}
	if t.IgnoreMerges {
		if id, ok := t.TokenToID[pt]; ok {
			return []int{id}
		}
	}
	chars := splitToChars(pt)
	if len(chars) == 0 {
		return nil
	}
	symbols := make([]string, len(chars))
	copy(symbols, chars)
	symbols = t.applyBPEMerges(symbols)
	ids := make([]int, 0, len(symbols))
	for _, sym := range symbols {
		if id, ok := t.TokenToID[sym]; ok {
			ids = append(ids, id)
		}
		// Byte-level coverage is total (every single byte-unicode rune is
		// one of the 256 base vocab entries), so a miss here can't happen
		// for a well-formed vocab; dropping silently rather than
		// panicking keeps a malformed tokenizer.json a wrong-output bug,
		// not a crash.
	}
	return ids
}

// ─────────────────────────────────────────────────────────────────────
// Pre-tokenization
// ─────────────────────────────────────────────────────────────────────

// llama3PreTokenize splits text per the Llama-3 / BitNet-b1.58-2B-4T
// pre-tokenization regex (tokenizer.json's pre_tokenizer.pretokenizers[0]
// Split pattern):
//
//	(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}|
//	 ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+
//
// Go's regexp (RE2) supports neither lookahead nor inline
// case-insensitive groups, so this is a hand-rolled scanner rather than
// a regexp.Regexp, matching the approach tokenizer_gpt2.go already takes
// for GPT-2's simpler pattern. Differences from that pattern, each
// implemented below:
//
//   - The contraction alternative is case-insensitive ('S, 'Re, 'VE, ...
//     all match, not just lowercase).
//   - The letter-run prefix is `[^\r\n\p{L}\p{N}]?` — ANY single
//     non-CR/LF, non-letter, non-digit character (punctuation, symbols,
//     a space, ...) fuses as a prefix, not just a literal space as in
//     GPT-2's ` ?\p{L}+`. E.g. "#hello" pre-tokenizes as one piece.
//   - Digit runs are capped at 1-3 digits (`\p{N}{1,3}`, no prefix at
//     all) instead of GPT-2's unbounded ` ?\p{N}+` — "12345" splits into
//     "123"+"45", and a space never fuses with a digit run.
//   - The "other symbols" alternative fuses trailing CR/LF onto the run
//     (`[\r\n]*`), and a new alternative `\s*[\r\n]+` (absent from
//     GPT-2) lets a whitespace run ending in CR/LF fuse the space/tab
//     before it into the same piece.
//
// The whitespace-run handling below (alt5/6/7) is derived analytically
// from backtracking semantics rather than emulated step by step — see
// the inline comments — and was cross-checked against Python's `regex`
// module (which supports this pattern verbatim) on 200+ generated edge
// cases; see TestLlama3PreTokenize for the literal cases taken from
// Python's `tokenizers` library itself.
func llama3PreTokenize(text string) []string {
	if text == "" {
		return nil
	}
	var pieces []string
	n := len(text)
	i := 0
	for i < n {
		r, size := utf8.DecodeRuneInString(text[i:])

		// alt1: case-insensitive 's|'t|'re|'ve|'m|'ll|'d
		if r == '\'' {
			if m := matchLlama3Contraction(text[i:]); m != "" {
				pieces = append(pieces, text[i:i+len(m)])
				i += len(m)
				continue
			}
		}

		// alt2, no prefix: a letter starts a letter run.
		if unicode.IsLetter(r) {
			j := i + size
			for j < n {
				rr, ss := utf8.DecodeRuneInString(text[j:])
				if !unicode.IsLetter(rr) {
					break
				}
				j += ss
			}
			pieces = append(pieces, text[i:j])
			i = j
			continue
		}

		// alt2, with prefix: one non-CRLF/letter/digit char immediately
		// followed by a letter fuses as that letter run's prefix. r is
		// already known non-letter here (handled above), so only crlf
		// and digit remain to exclude.
		if r != '\r' && r != '\n' && !unicode.IsNumber(r) && i+size < n {
			nr, ns := utf8.DecodeRuneInString(text[i+size:])
			if unicode.IsLetter(nr) {
				j := i + size + ns
				for j < n {
					rr, ss := utf8.DecodeRuneInString(text[j:])
					if !unicode.IsLetter(rr) {
						break
					}
					j += ss
				}
				pieces = append(pieces, text[i:j])
				i = j
				continue
			}
		}

		// alt3: 1 to 3 digits, no prefix ever.
		if unicode.IsNumber(r) {
			j := i + size
			count := 1
			for j < n && count < 3 {
				rr, ss := utf8.DecodeRuneInString(text[j:])
				if !unicode.IsNumber(rr) {
					break
				}
				j += ss
				count++
			}
			pieces = append(pieces, text[i:j])
			i = j
			continue
		}

		// alt4: optional literal-space prefix + run of "other" symbols
		// (not whitespace, not letter, not digit) + fused trailing CR/LF.
		if r == ' ' && i+size < n {
			nr, ns := utf8.DecodeRuneInString(text[i+size:])
			if isLlama3Other(nr) {
				j := i + size + ns
				j = extendLlama3Other(text, j)
				j = extendLlama3CRLF(text, j)
				pieces = append(pieces, text[i:j])
				i = j
				continue
			}
		}
		if isLlama3Other(r) {
			j := extendLlama3Other(text, i+size)
			j = extendLlama3CRLF(text, j)
			pieces = append(pieces, text[i:j])
			i = j
			continue
		}

		// Remaining case: r is whitespace (everything else has been
		// ruled out above: not contraction start, not letter, not a
		// letter-run prefix, not digit, not space-before-other, not
		// other). Handle the three whitespace alternatives
		// (\s*[\r\n]+ | \s+(?!\S) | \s+) via the maximal contiguous
		// whitespace run starting at i.
		m := i
		for m < n {
			rr, ss := utf8.DecodeRuneInString(text[m:])
			if !unicode.IsSpace(rr) {
				break
			}
			m += ss
		}

		// alt5: \s*[\r\n]+. Backtracking \s* from the run's end to find
		// where a trailing [\r\n]+ can start is equivalent to: if the run
		// contains any CR/LF at all, the match consumes the run up
		// through the RIGHTMOST CR/LF byte in it (CR/LF are single-byte
		// ASCII, so a plain byte scan can't land mid-rune). Verified
		// against Python's `regex` module — see this function's doc
		// comment.
		crlfPos := -1
		for k := m - 1; k >= i; k-- {
			if text[k] == '\r' || text[k] == '\n' {
				crlfPos = k
				break
			}
		}
		if crlfPos >= 0 {
			pieces = append(pieces, text[i:crlfPos+1])
			i = crlfPos + 1
			continue
		}

		// No CR/LF in the run: alt6 \s+(?!\S) takes the whole run when it
		// reaches EOF or is a single character (can't back off any
		// further), else the whole run minus its last character — that
		// leftover character is picked up fresh on the next iteration,
		// naturally handling multi-space runs the same way GPT-2's
		// pendingSpace mechanism does explicitly. alt7 \s+ never actually
		// diverges from alt6 here since alt6 always succeeds in this
		// branch (no-CR/LF run).
		if m == n || m-i == 1 {
			pieces = append(pieces, text[i:m])
			i = m
			continue
		}
		pieces = append(pieces, text[i:m-1])
		i = m - 1
	}
	return pieces
}

// isLlama3Other reports whether r is in the "other symbols" class:
// [^\s\p{L}\p{N}] — not whitespace, not a letter, not a number.
func isLlama3Other(r rune) bool {
	return !unicode.IsSpace(r) && !unicode.IsLetter(r) && !unicode.IsNumber(r)
}

// extendLlama3Other advances j over a run of isLlama3Other runes in text,
// starting at byte offset j.
func extendLlama3Other(text string, j int) int {
	n := len(text)
	for j < n {
		rr, ss := utf8.DecodeRuneInString(text[j:])
		if !isLlama3Other(rr) {
			break
		}
		j += ss
	}
	return j
}

// extendLlama3CRLF advances j over a run of literal \r / \n bytes in
// text, starting at byte offset j (the `[\r\n]*` suffix of alt4).
func extendLlama3CRLF(text string, j int) int {
	n := len(text)
	for j < n && (text[j] == '\r' || text[j] == '\n') {
		j++
	}
	return j
}

// llama3ContractionSuffixes lists the (lowercased) contraction bodies
// alt1 matches after an apostrophe, in the same order as the regex
// alternation — irrelevant here since none is a prefix of another, but
// kept for fidelity.
var llama3ContractionSuffixes = [...]string{"s", "t", "re", "ve", "m", "ll", "d"}

// matchLlama3Contraction returns the matched prefix of s (which must
// start with "'") for (?i:'s|'t|'re|'ve|'m|'ll|'d), or "" if none match.
func matchLlama3Contraction(s string) string {
	rest := s[1:]
	for _, c := range llama3ContractionSuffixes {
		if len(rest) >= len(c) && strings.EqualFold(rest[:len(c)], c) {
			return s[:1+len(c)]
		}
	}
	return ""
}

// ─────────────────────────────────────────────────────────────────────
// Special-token IDs
// ─────────────────────────────────────────────────────────────────────

// EndOfTextID returns the id of <|end_of_text|> (128001) — the base
// Llama-3 model's eos token (special_tokens_map.json's eos_token for
// this checkpoint). -1 outside Llama3 mode. See EosID's doc comment for
// how this relates to EotID.
func (t *BPETokenizer) EndOfTextID() int {
	if !t.Llama3 {
		return -1
	}
	return t.TokenToID["<|end_of_text|>"]
}

// EotID returns the id of <|eot_id|> (128009) — BitNet-2B4T's
// end-of-turn marker, and the same value EosID() returns in Llama3 mode.
// Kept as its own accessor per this checkpoint having two eos-shaped
// tokens: callers that specifically want "the instruct end-of-turn
// token" shouldn't need to know it happens to equal EosID() here. -1
// outside Llama3 mode.
func (t *BPETokenizer) EotID() int {
	if !t.Llama3 {
		return -1
	}
	return t.TokenToID["<|eot_id|>"]
}

// StartHeaderID and EndHeaderID return <|start_header_id|> (128006) /
// <|end_header_id|> (128007) — present in BitNet-2B4T's vocabulary but
// unused by its actual chat_template (see Llama3ChatPrompt), which
// renders turns as "Role: content<|eot_id|>" rather than Llama-3's usual
// header-token framing. Exposed for completeness / future templates.
// -1 outside Llama3 mode.
func (t *BPETokenizer) StartHeaderID() int {
	if !t.Llama3 {
		return -1
	}
	return t.TokenToID["<|start_header_id|>"]
}

func (t *BPETokenizer) EndHeaderID() int {
	if !t.Llama3 {
		return -1
	}
	return t.TokenToID["<|end_header_id|>"]
}

// ─────────────────────────────────────────────────────────────────────
// Chat template
// ─────────────────────────────────────────────────────────────────────

// Llama3ChatPrompt renders BitNet-b1.58-2B-4T's chat template — read
// verbatim from tokenizer_config.json's chat_template, not assumed from
// Llama-3 convention:
//
//	{% for message in messages %}
//	  {{ message.role | capitalize }}: {{ message.content | trim }}<|eot_id|>
//	{% endfor %}
//	{% if add_generation_prompt %}Assistant: {% endif %}
//
// with add_generation_prompt always true (this engine only ever prompts
// for a completion). The system turn is included only when system != "".
// This is NOT the <|start_header_id|>-based template most Llama-3
// checkpoints ship — BitNet-2B4T's is the simpler "Role: content<|eot_id|>"
// form; StartHeaderID/EndHeaderID exist for a future template but this
// function reproduces the one the checkpoint actually has.
//
// Jinja's `trim` filter strips leading/trailing whitespace
// (strings.TrimSpace); `capitalize` on "system"/"user" is already their
// natural form. Cross-checked against jinja2's own rendering of the
// template — see TestLlama3ChatPrompt and
// forge/llama3_tokenizer_reference.py's chat subcommand.
func Llama3ChatPrompt(system, user string) string {
	var b strings.Builder
	if system != "" {
		b.WriteString("System: ")
		b.WriteString(strings.TrimSpace(system))
		b.WriteString("<|eot_id|>")
	}
	b.WriteString("User: ")
	b.WriteString(strings.TrimSpace(user))
	b.WriteString("<|eot_id|>")
	b.WriteString("Assistant: ")
	return b.String()
}
