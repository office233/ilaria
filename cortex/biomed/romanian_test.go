package biomed

import "testing"

// romanianTestIndex is a literal list of real RxNorm-style display names,
// used because the recorded displaynames.json fixture does not carry every
// ingredient exercised here (e.g. "metformin", "amoxicillin", "diclofenac",
// "omeprazole", "paracetamol" are absent from it as standalone entries).
func romanianTestIndex() *DrugNameIndex {
	return NewDrugNameIndex([]string{
		"warfarin", "aspirin", "ibuprofen", "metformin", "amoxicillin",
		"diclofenac", "omeprazole", "paracetamol", "acetaminophen",
		"aspirin 81 mg oral tablet",
	})
}

func TestFindMentions_RomanianInflectedDrugNames(t *testing.T) {
	ix := romanianTestIndex()
	cases := []struct{ word, want string }{
		{"warfarina", "warfarin"},        // definite article "a"
		{"warfarinului", "warfarin"},     // genitive/dative "ului"
		{"aspirina", "aspirin"},          // definite article "a"
		{"aspirinei", "aspirin"},         // genitive/dative "ei"
		{"ibuprofenul", "ibuprofen"},     // definite article "ul"
		{"paracetamolul", "paracetamol"}, // definite article "ul"
		{"metformina", "metformin"},      // definite article "a"
		{"amoxicilina", "amoxicillin"},   // "a" + RO->EN "cilin"->"cillin"
		{"diclofenacul", "diclofenac"},   // definite article "ul"
		{"omeprazolul", "omeprazole"},    // "ul" + RO drops trailing "e"
	}
	for _, c := range cases {
		t.Run(c.word, func(t *testing.T) {
			m := ix.FindMentions(c.word)
			if len(m) != 1 || m[0].Text != c.want {
				t.Fatalf("FindMentions(%q) = %+v, want single mention %q", c.word, m, c.want)
			}
		})
	}
}

// TestFindMentions_RomanianCommonWordsAreNotDrugs guards against the
// suffix-stripping rules turning ordinary Romanian words/names into false
// drug mentions.
func TestFindMentions_RomanianCommonWordsAreNotDrugs(t *testing.T) {
	ix := romanianTestIndex()
	for _, word := range []string{"marina", "cortina", "mașina", "masina", "carina"} {
		if m := ix.FindMentions(word); len(m) != 0 {
			t.Errorf("FindMentions(%q) = %+v, want no mentions", word, m)
		}
	}
}

// TestFindMentions_MultiWordNamesStillMatch guards against the new
// single-word fallback changing the existing multi-word (n-gram) matching
// behavior.
func TestFindMentions_MultiWordNamesStillMatch(t *testing.T) {
	ix := romanianTestIndex()
	m := ix.FindMentions("ia aspirin 81 mg oral tablet zilnic")
	if len(m) != 1 || m[0].Text != "aspirin 81 mg oral tablet" {
		t.Fatalf("mentions = %+v", m)
	}
}

func TestRomanianVariants_DiacriticsFoldedBeforeStemming(t *testing.T) {
	got := romanianVariants("warfarină") // indefinite form, with diacritic
	for _, v := range got {
		if v == "warfarin" {
			return
		}
	}
	t.Fatalf("romanianVariants(%q) = %v, want it to include %q", "warfarină", got, "warfarin")
}
