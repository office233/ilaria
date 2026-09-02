package evalsuite

import "testing"

// TestModeNumericRejectsSubstringMatch verifies that ModeNumeric does NOT
// score "84" as a match against "1984" or "840" — the regex must extract
// the whole number, not a substring of digits.
//
// This guards against a class of bug where extracting digit-by-digit
// would give false positives: the model says "The year 1984 was…" and
// gets credit for an arithmetic answer of 84.
func TestModeNumericRejectsSubstringMatch(t *testing.T) {
	task := Task{
		ID:             "test_numeric",
		Category:       "test",
		Prompt:         "What is 12 times 7?",
		ExpectedNumber: 84,
		Tolerance:      0,
		Mode:           ModeNumeric,
	}

	cases := []struct {
		name      string
		generated string
		wantOK    bool
	}{
		{"exact match", "84", true},
		{"with prefix text", "The answer is 84.", true},
		{"with trailing text", "84 is correct", true},
		{"substring in larger number — must NOT match", "The year 1984 was great", false},
		{"trailing zero — must NOT match", "840 students", false},
		{"decimal — must NOT match expected integer", "The result is 8.4", false},
		{"no number", "the answer is unclear", false},
		{"different number", "The answer is 42", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Grade(task, tc.generated, 0)
			if got.Correct != tc.wantOK {
				t.Errorf("Grade(%q) correct=%v want=%v (reason: %s, numFound=%v)",
					tc.generated, got.Correct, tc.wantOK, got.Reason, got.NumFound)
			}
		})
	}
}

// TestModeContainsWordBoundary verifies that ModeContains (and
// ModeContainsAny) require word boundaries — "red" should not match
// inside "predator" or "covered".
//
// CURRENTLY EXPECTED TO FAIL until score.go switches from
// strings.Contains to a word-boundary check. This is the bug
// described in the cursa-D postmortem (~4% false-positive rate).
func TestModeContainsWordBoundary(t *testing.T) {
	taskColors := Task{
		ID: "test_colors", Category: "test",
		Prompt:   "List the three primary colors.",
		Expected: []string{"red", "blue", "yellow"},
		Mode:     ModeContains,
	}

	cases := []struct {
		name      string
		generated string
		wantOK    bool
	}{
		{"exact list", "red, blue, yellow", true},
		{"verbose answer", "The three primary colors are red, blue, and yellow.", true},
		{"with punctuation", "Red. Blue. Yellow.", true},
		{"case insensitive", "RED BLUE YELLOW", true},

		// These are the false-positive cases. Without word boundaries,
		// "red" matches "predator", "blue" matches nothing close, but
		// "red" embedded in many English words (covered, secured,
		// predator, ...) trips ModeContains.
		{"red in covered — must NOT match red alone", "The sky covered blue yellow", false},
		{"red in predator — must NOT match red alone", "predator blue yellow", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Grade(taskColors, tc.generated, 0)
			if got.Correct != tc.wantOK {
				t.Errorf("Grade(%q) correct=%v want=%v (reason: %s)",
					tc.generated, got.Correct, tc.wantOK, got.Reason)
			}
		})
	}
}

// TestModeContainsAnyWordBoundary verifies word-boundary handling for
// ModeContainsAny — same bug class as ModeContains.
//
// The "yes" or "no" yesno task is the typical victim: "no" is a
// substring of "now", "not", "none", "nothing", "know", "annotation",
// etc. Without word boundaries, "There is no other notion" matches
// "no" multiple ways.
func TestModeContainsAnyWordBoundary(t *testing.T) {
	yesnoTask := Task{
		ID: "test_yesno", Category: "test",
		Prompt:   "Is the Earth round? Answer yes or no.",
		Expected: []string{"yes", "no"},
		Mode:     ModeContainsAny,
	}

	cases := []struct {
		name      string
		generated string
		wantOK    bool
	}{
		{"yes", "yes", true},
		{"no", "no", true},
		{"yes with prefix", "Answer: yes.", true},
		{"no with prefix", "Answer: no.", true},

		// "no" embedded — false positives we want to reject:
		{"now — must NOT match no", "We don't know right now.", false},
		{"notion — must NOT match no", "It is a strange notion.", false},
		{"yesterday — must NOT match yes", "Yesterday I went home.", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Grade(yesnoTask, tc.generated, 0)
			if got.Correct != tc.wantOK {
				t.Errorf("Grade(%q) correct=%v want=%v (reason: %s)",
					tc.generated, got.Correct, tc.wantOK, got.Reason)
			}
		})
	}
}

// TestModeContainsMultiWordPhrase verifies that expected strings
// containing spaces (e.g., "buenos d" or "good morning") still match
// when the boundary check is added. The boundary anchor at the END
// must allow a partial-word match if the expected itself ends mid-word
// — but the START must still be a word boundary.
func TestModeContainsMultiWordPhrase(t *testing.T) {
	task := Task{
		ID: "test_phrase", Category: "test",
		Prompt:   "Translate 'good morning' to Spanish.",
		Expected: []string{"buenos d"},
		Mode:     ModeContains,
	}

	cases := []struct {
		name      string
		generated string
		wantOK    bool
	}{
		{"full Spanish", "Buenos días", true},
		{"abbreviated", "buenos días señor", true},
		// "buenos d" inside a single word ("misbuenos doctrine") would
		// be rejected by the start boundary. We don't construct such
		// nonsense cases — they don't appear in any task.
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Grade(task, tc.generated, 0)
			if got.Correct != tc.wantOK {
				t.Errorf("Grade(%q) correct=%v want=%v (reason: %s)",
					tc.generated, got.Correct, tc.wantOK, got.Reason)
			}
		})
	}
}

// TestModeContainsAnyChemicalFormula — the "h2o" task uses
// ContainsAny and contains a digit. Word boundaries with digits are
// subtle: \b sits between word chars and non-word chars; both 'h'
// and '2' are \w, so there's no boundary between them. The boundary
// is at the start of "h" and after "o" — which is what we want.
func TestModeContainsAnyChemicalFormula(t *testing.T) {
	task := Task{
		ID: "test_h2o", Category: "test",
		Prompt:   "What is the chemical formula for water?",
		Expected: []string{"h2o", "h₂o"},
		Mode:     ModeContainsAny,
	}

	cases := []struct {
		name      string
		generated string
		wantOK    bool
	}{
		{"plain h2o", "Water is H2O", true},
		{"lowercase", "h2o", true},
		{"with surrounding text", "The formula is h2o.", true},
		// Edge: "h2o4" — does h2o match as a prefix? Yes, both with
		// strings.Contains AND with the boundary approach. There's no
		// boundary between "o" and "4" (both \w), so a strict word
		// boundary check would REJECT this. We accept that edge as
		// "fine" — chemistry shouldn't be subdivided into substrings.
		// Actually we leave this case unspecified — it doesn't appear
		// in the suite and either behavior is defensible.
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Grade(task, tc.generated, 0)
			if got.Correct != tc.wantOK {
				t.Errorf("Grade(%q) correct=%v want=%v (reason: %s)",
					tc.generated, got.Correct, tc.wantOK, got.Reason)
			}
		})
	}
}

// TestModeNumericAnswerAware guards the v2 answer-position extraction
// (extractAnswerNumber). The first case is verbatim the cursa-D step
// 19500 false positive: a rambling generation that merely OPENS with
// the digit "9" was scored correct for sqrt(81)=9 under v1 — v2 keeps
// scoring it correct ONLY because the number sits in the leading 20
// chars (a genuine answer position); numbers buried mid-ramble must
// not count.
func TestModeNumericAnswerAware(t *testing.T) {
	task := Task{
		ID:             "math_sqrt",
		Category:       "math",
		Prompt:         "What is the square root of 81?",
		ExpectedNumber: 9,
		Mode:           ModeNumeric,
	}

	cases := []struct {
		name      string
		generated string
		wantOK    bool
	}{
		{"leading digit (answer position)", "9. In the average of 1513 square- 24 million for 94.", true},
		{"cot equals ending", "The square root of 81: since 9 times 9 is 81, sqrt(81) = 9", true},
		{"answer on short last line", "Let me think about this.\nThe answer is 9.", true},
		{"number buried mid-ramble only", "In the town there were about 1513 people living near the square, which many considered remarkable throughout history and beyond all expectations of the census takers.", false},
		{"wrong number after equals", "sqrt(81) = 81", false},
		{"no number at all", "I do not know the answer to that question.", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Grade(task, tc.generated, 0)
			if got.Correct != tc.wantOK {
				t.Errorf("Grade(%q) correct=%v want=%v (reason: %s, numFound=%v)",
					tc.generated, got.Correct, tc.wantOK, got.Reason, got.NumFound)
			}
		})
	}
}

// TestScorerVersionStamped: every result must carry the scorer version
// so mixed-version eval histories can be partitioned during analysis.
func TestScorerVersionStamped(t *testing.T) {
	task := Task{ID: "v", Category: "test", ExpectedNumber: 1, Mode: ModeNumeric}
	res := Grade(task, "1", 0)
	if res.Scorer != ScorerVersion {
		t.Fatalf("Scorer = %d, want %d", res.Scorer, ScorerVersion)
	}
	if ScorerVersion < 2 {
		t.Fatal("ScorerVersion regressed below 2")
	}
}
