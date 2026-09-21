package biomed

import "strings"

// Romanian inflects drug names with definite articles and case endings
// ("warfarina", "aspirinei", "ibuprofenul") that RxNorm's English display
// names never carry. This file de-inflects a single free-text token into a
// small set of candidate spellings and tries them against the index — no
// network calls, no medical knowledge, purely spelling.

// diacriticFolder maps Romanian diacritics to their plain-ASCII base letter,
// covering both Unicode encodings of ș/ț (cedilla and comma-below).
var diacriticFolder = strings.NewReplacer(
	"ă", "a", "â", "a", "î", "i",
	"ș", "s", "ş", "s", "ț", "t", "ţ", "t",
)

// foldDiacritics strips Romanian diacritics so a query token and an indexed
// name compare equal regardless of accents (RxNorm names never carry them).
func foldDiacritics(s string) string { return diacriticFolder.Replace(s) }

// roSuffixes are Romanian definite-article / case endings that are not part
// of a drug's stem. Longest first, so "ului" is tried whole before its "ul"
// tail would otherwise be cut short.
//   - "ului": warfarinului  -> warfarin  (masculine genitive/dative)
//   - "ul":   ibuprofenul   -> ibuprofen, diclofenacul -> diclofenac,
//     omeprazolul   -> omeprazol, paracetamolul -> paracetamol
//   - "ei":   aspirinei     -> aspirin   (feminine genitive/dative)
//   - "a":    warfarina, aspirina, metformina, amoxicilina -> ...+"a" article
var roSuffixes = []string{"ului", "ul", "ei", "a"}

// roSpellingFixes rewrite a stripped Romanian stem's tail to match RxNorm's
// English spelling. Romanian pharma names simplify the doubled consonant
// English keeps: "amoxicilina" strips to "amoxicilin", but RxNorm indexes
// "amoxicillin" (double l).
var roSpellingFixes = []struct{ from, to string }{
	{"cilin", "cillin"}, // amoxicilin -> amoxicillin (also penicilin, ampicilin)
}

// romanianStemMinLen guards against short, coincidental stems: "marina" and
// "mașina"/"masina" strip (via the "a" suffix) to "marin"/"masin", both under
// this length, so they are never tried as drug names. Every real drug stem
// used above ("warfarin", "aspirin", "ibuprofen", ...) is at least this long.
const romanianStemMinLen = 6

// romanianVariants returns deduplicated candidate spellings for a lowercase
// Romanian-inflected word, most specific (least changed) first.
func romanianVariants(word string) []string {
	folded := foldDiacritics(word)
	seen := map[string]bool{folded: true}
	out := []string{folded}
	add := func(s string) {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	for _, suf := range roSuffixes {
		stem, ok := strings.CutSuffix(folded, suf)
		if !ok || len(stem) < romanianStemMinLen {
			continue
		}
		add(stem)
		add(stem + "e") // RO drops a final "e" English keeps: omeprazol -> omeprazole
		for _, fix := range roSpellingFixes {
			if strings.HasSuffix(stem, fix.from) {
				add(strings.TrimSuffix(stem, fix.from) + fix.to)
			}
		}
	}
	return out
}

// matchRomanianVariant tries Romanian-inflected spellings of a single word
// against the index and returns the canonical indexed name it resolved to.
func (ix *DrugNameIndex) matchRomanianVariant(word string) (string, bool) {
	for _, v := range romanianVariants(word) {
		if len(v) < minMentionLen {
			continue
		}
		if _, ok := ix.names[v]; ok {
			return v, true
		}
	}
	return "", false
}
