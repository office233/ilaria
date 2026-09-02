package evalsuite

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// ScorerVersion stamps every ScoreResult so eval history can be
// partitioned by grading semantics.
//
//	v1: ModeContainsAny via raw strings.Contains; ModeNumeric took the
//	    FIRST number anywhere in the generation. Both produced the
//	    false-positive spikes documented in the cursa-D postmortem.
//	v2: word-boundary matching for text modes; answer-aware number
//	    extraction for ModeNumeric (see extractAnswerNumber).
//
// Results across versions are NOT comparable — rescore before mixing.
const ScorerVersion = 2

// reNumber matches the first plausible signed/decimal number in a string.
// Examples matched: "42", "-3", "12.5", "0.011".
var reNumber = regexp.MustCompile(`-?\d+(?:\.\d+)?`)

// extractAnswerNumber pulls the number a generation is most plausibly
// OFFERING as its answer, rather than the first digit that happens to
// appear (v1 behaviour — which marked "9. In the average of 1513
// square-..." correct for sqrt(81) because it opened with "9").
//
// Priority order, mirroring how answers are actually phrased:
//  1. After the last '=' — chain-of-thought endings: "6 × 14 = 84".
//  2. The last non-empty line — CoT answers land at the end.
//  3. The first 20 characters — direct answers lead with the number.
//
// A number in the middle of unrelated rambling matches none of these
// and correctly counts as "no answer".
func extractAnswerNumber(generated string) string {
	if eq := strings.LastIndexByte(generated, '='); eq >= 0 {
		if m := reNumber.FindString(generated[eq+1:]); m != "" {
			return m
		}
	}
	lines := strings.Split(strings.TrimSpace(generated), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		if m := reNumber.FindString(line); m != "" {
			// Only accept the last line's number when the generation is
			// short enough for that line to plausibly BE the answer, or
			// when it is the only line. A 300-char ramble whose last
			// line happens to contain "1513" is noise, not an answer —
			// unless an '=' or the opening pinned it (cases 1 and 3).
			if len(lines) == 1 || len(line) <= 40 {
				return m
			}
		}
		break
	}
	head := generated
	if len(head) > 20 {
		head = head[:20]
	}
	return reNumber.FindString(head)
}

// isWordChar mirrors Go regexp's \w (ASCII word char: letter, digit,
// underscore). Used by containsWordBoundary so we don't pay the cost
// of compiling a regex per Grade() call.
func isWordChar(b byte) bool {
	return (b >= 'a' && b <= 'z') ||
		(b >= 'A' && b <= 'Z') ||
		(b >= '0' && b <= '9') ||
		b == '_'
}

// containsWordBoundary reports whether `needle` occurs in `haystack`
// at a position where both the start and the end sit on a word
// boundary. Both inputs MUST already be lowercased by the caller.
//
// Word boundary semantics (ASCII): the byte BEFORE the match must be
// the start of the string OR a non-word char; the byte AFTER the
// match must be the end of the string OR a non-word char. This is
// exactly what regexp's \b does, but implemented inline to avoid
// per-call regex compilation in the hot grading path.
//
// Examples for needle="red":
//   "red"            → true   (start of string / end of string)
//   "the red car"    → true   (space before, space after)
//   "Red,"           → true   (start, comma after)
//   "predator"       → false  ('p' word char before "red")
//   "covered"        → false  ('e' word char after "red" in "redx")
//   "redder"         → false  ('d' word char after "red")
//
// Multi-word needles work too — the boundary is only checked at the
// outer edges of the needle, not internally. So needle="buenos d"
// matches "buenos días" (space inside the haystack matches the space
// inside the needle; 'd' at the end of the needle has 'í' after it
// in the haystack, which is a non-ASCII byte — not a word char by
// this function's ASCII-only definition — so the boundary holds).
func containsWordBoundary(haystack, needle string) bool {
	if needle == "" {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] != needle {
			continue
		}
		// Check left boundary.
		if i > 0 && isWordChar(haystack[i-1]) {
			// Needle starts with a word char — boundary required.
			// (If needle starts with non-word, like " foo", the
			// boundary check is implicitly satisfied because the
			// space inside the needle is its own boundary.)
			if isWordChar(needle[0]) {
				continue
			}
		}
		// Check right boundary.
		end := i + len(needle)
		if end < len(haystack) && isWordChar(haystack[end]) {
			if isWordChar(needle[len(needle)-1]) {
				continue
			}
		}
		return true
	}
	return false
}

// ScoreResult is the verdict for a single task.
type ScoreResult struct {
	TaskID    string  `json:"task_id"`
	Category  string  `json:"category"`
	Prompt    string  `json:"prompt"`
	Generated string  `json:"generated"`
	Expected  string  `json:"expected"`
	Correct   bool    `json:"correct"`
	Mode      string  `json:"mode"`
	Reason    string  `json:"reason,omitempty"`
	GenMs     int64   `json:"gen_ms"`
	NumFound  float64 `json:"num_found,omitempty"`
	// Scorer records which grading semantics produced this verdict —
	// see ScorerVersion. Audit trail for cross-run comparability.
	Scorer int `json:"scorer_version"`
}

// Grade compares one task's expected answer against a raw generation.
// Case-insensitive substring matching for text modes; for numeric mode
// the first number in the generation is extracted and compared.
func Grade(t Task, generated string, genMs int64) ScoreResult {
	res := ScoreResult{
		TaskID:    t.ID,
		Category:  t.Category,
		Prompt:    t.Prompt,
		Generated: strings.TrimSpace(generated),
		Mode:      string(t.Mode),
		GenMs:     genMs,
		Scorer:    ScorerVersion,
	}

	lowerGen := strings.ToLower(res.Generated)

	switch t.Mode {
	case ModeContains:
		res.Expected = strings.Join(t.Expected, " AND ")
		missing := []string{}
		for _, want := range t.Expected {
			if !containsWordBoundary(lowerGen, strings.ToLower(want)) {
				missing = append(missing, want)
			}
		}
		if len(missing) == 0 {
			res.Correct = true
			res.Reason = "all expected substrings present"
		} else {
			res.Reason = "missing: " + strings.Join(missing, ", ")
		}

	case ModeContainsAny:
		res.Expected = strings.Join(t.Expected, " OR ")
		for _, want := range t.Expected {
			if containsWordBoundary(lowerGen, strings.ToLower(want)) {
				res.Correct = true
				res.Reason = "matched: " + want
				break
			}
		}
		if !res.Correct {
			res.Reason = "no expected substring present"
		}

	case ModeNumeric:
		res.Expected = strconv.FormatFloat(t.ExpectedNumber, 'f', -1, 64)
		if t.Tolerance > 0 {
			res.Expected += " (±" + strconv.FormatFloat(t.Tolerance, 'f', -1, 64) + ")"
		}
		match := extractAnswerNumber(res.Generated)
		if match == "" {
			res.Reason = "no answer-position number found in generation"
			break
		}
		got, err := strconv.ParseFloat(match, 64)
		if err != nil {
			res.Reason = "could not parse number: " + match
			break
		}
		res.NumFound = got
		tol := t.Tolerance
		if math.Abs(got-t.ExpectedNumber) <= tol+1e-9 {
			res.Correct = true
			res.Reason = "numeric match"
		} else {
			res.Reason = "got " + match + ", expected " + res.Expected
		}

	case ModeRegex:
		if len(t.Expected) == 0 {
			res.Reason = "no regex provided"
			break
		}
		res.Expected = t.Expected[0]
		re, err := regexp.Compile("(?i)" + t.Expected[0])
		if err != nil {
			res.Reason = "bad regex: " + err.Error()
			break
		}
		if re.MatchString(res.Generated) {
			res.Correct = true
			res.Reason = "regex matched"
		} else {
			res.Reason = "regex did not match"
		}

	default:
		res.Reason = "unknown score mode: " + string(t.Mode)
	}

	return res
}

// CategoryStats aggregates per-category accuracy.
type CategoryStats struct {
	Category string  `json:"category"`
	Total    int     `json:"total"`
	Correct  int     `json:"correct"`
	Accuracy float64 `json:"accuracy"`
	AvgGenMs float64 `json:"avg_gen_ms"`
}

// Summarise rolls per-task results up to per-category and overall stats.
func Summarise(results []ScoreResult) (perCat []CategoryStats, overall CategoryStats) {
	byCat := map[string]*CategoryStats{}
	var totalMs int64
	for _, r := range results {
		c, ok := byCat[r.Category]
		if !ok {
			c = &CategoryStats{Category: r.Category}
			byCat[r.Category] = c
		}
		c.Total++
		if r.Correct {
			c.Correct++
		}
		c.AvgGenMs += float64(r.GenMs)
		overall.Total++
		if r.Correct {
			overall.Correct++
		}
		totalMs += r.GenMs
	}
	for _, c := range byCat {
		if c.Total > 0 {
			c.Accuracy = float64(c.Correct) / float64(c.Total)
			c.AvgGenMs /= float64(c.Total)
		}
		perCat = append(perCat, *c)
	}
	overall.Category = "OVERALL"
	if overall.Total > 0 {
		overall.Accuracy = float64(overall.Correct) / float64(overall.Total)
		overall.AvgGenMs = float64(totalMs) / float64(overall.Total)
	}
	return perCat, overall
}
