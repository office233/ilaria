package search

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// maxTermBytes drops pathological "words" (base64 blobs, minified identifiers)
// that would only bloat the vocabulary.
const maxTermBytes = 64

// Letters that do not decompose under NFKD but are commonly typed without
// their diacritic.
var extraFold = strings.NewReplacer("ł", "l", "đ", "d", "ø", "o", "ß", "ss", "æ", "ae", "œ", "oe", "þ", "th", "ı", "i")

// normalize applies compatibility decomposition, removes combining marks and
// lower-cases, so "Știință", its decomposed form and "stiinta" are one term,
// and "Győr" matches "gyor".
func normalize(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range norm.NFKD.String(s) {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return extraFold.Replace(b.String())
}

func isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsNumber(r) || unicode.Is(unicode.Mn, r)
}

// tokenize splits normalized text into index terms.
func tokenize(s string) []string {
	fields := strings.FieldsFunc(normalize(s), func(r rune) bool { return !isWordRune(r) })
	out := fields[:0]
	for _, f := range fields {
		if len(f) <= maxTermBytes {
			out = append(out, f)
		}
	}
	return out
}

// snippet returns about 50 words of the original text around the first word
// that matches a query term, so results show why they matched.
func snippet(text string, terms map[string]bool) string {
	words := strings.FieldsFunc(text, unicode.IsSpace)
	if len(words) == 0 {
		return ""
	}
	hit := -1
	for i, w := range words {
		for _, t := range tokenize(w) {
			if terms[t] {
				hit = i
				break
			}
		}
		if hit >= 0 {
			break
		}
	}
	start := 0
	if hit > 15 {
		start = hit - 15
	}
	end := start + 50
	if end > len(words) {
		end = len(words)
	}
	s := strings.Join(words[start:end], " ")
	if start > 0 {
		s = "… " + s
	}
	if end < len(words) {
		s += " …"
	}
	return clip(s, 600)
}
