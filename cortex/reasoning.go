package cortex

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/Knetic/govaluate"
)

// ─────────────────────────────────────────────────────────────────────
// ReasoningEngine — Deterministic symbolic reasoning
// ─────────────────────────────────────────────────────────────────────
//
// The neural pipeline (Hippocampus, Prefrontal, Broca) is optimised for
// associative, learned knowledge. It is fundamentally unsuited for exact
// arithmetic, sequence prediction, or logical deduction—tasks that
// require deterministic symbol manipulation.
//
// ReasoningEngine intercepts inputs that match recognisable reasoning
// patterns and produces exact answers WITHOUT going through the SDR
// pipeline. This is analogous to how the human brain has specialised
// modules (the intraparietal sulcus for numerosity, Broca's area for
// structured logic) that operate alongside the hippocampal system.
//
// Supported capabilities:
//   - Arithmetic:  "What is 15 + 27?" → "42"
//   - Word problems: "I have 3 apples and give away 1" → extract & solve
//   - Pattern recognition: arithmetic & geometric sequences
//   - Syllogistic logic: "All X are Y. Z is X. Is Z Y?" → "yes"
//   - Sorting: "Sort these numbers: 7, 2, 9" → "2 7 9"

// ReasoningEngine provides deterministic symbolic reasoning capabilities
// that complement the neural pipeline.
type ReasoningEngine struct {
	// Tools is an optional registry of pluggable deterministic skills.
	// When non-nil, it is consulted BEFORE the hardcoded skills so that
	// new capabilities can be added without touching this file. The
	// hardcoded skills remain as a fallback for backward compatibility.
	Tools *ToolRegistry

	// lastTool records the name of the Tool that answered the most
	// recent TryReason() call (ToolRegistry.Dispatch's toolName), or ""
	// when the answer came from a hardcoded skill instead. Kept internal
	// (rather than widening TryReason's return signature) so existing
	// two-value callers stay source-compatible; see LastTool().
	lastTool string
}

// NewReasoningEngine creates a new reasoning engine without tools.
// Use AttachTools() to plug in a ToolRegistry.
func NewReasoningEngine() *ReasoningEngine {
	return &ReasoningEngine{}
}

// AttachTools wires a ToolRegistry into the engine. Safe to call once at
// Organism construction time. Passing nil disables the registry path.
func (r *ReasoningEngine) AttachTools(tr *ToolRegistry) {
	r.Tools = tr
}

// ToolNames returns the registered tool names in dispatch order (nil-safe).
func (r *ReasoningEngine) ToolNames() []string {
	if r == nil || r.Tools == nil {
		return nil
	}
	return r.Tools.Names()
}

// LastTool returns the name of the Tool that produced the answer on the
// most recent successful TryReason() call, or "" when that answer came
// from a hardcoded ReasoningEngine skill (arithmetic, sequence,
// syllogism, sort, word problem) instead of the Tool registry. Only
// meaningful immediately after a TryReason() call that returned ok=true;
// nil-safe.
func (r *ReasoningEngine) LastTool() string {
	if r == nil {
		return ""
	}
	return r.lastTool
}

// TryReason attempts to handle the input with deterministic reasoning.
// Returns (answer, true) if the input matches a known reasoning pattern,
// or ("", false) if the neural pipeline should handle it.
func (r *ReasoningEngine) TryReason(input string) (string, bool) {
	// Reset per call so a stale name from a previous hit never leaks
	// into this call's result (only meaningful when the return is ok).
	r.lastTool = ""

	input = strings.TrimSpace(input)
	if input == "" {
		return "", false
	}

	// Pluggable tools take priority over hardcoded skills. They're
	// optional and side-effect-free; on miss we fall through.
	if r.Tools != nil {
		if ans, name, ok := r.Tools.Dispatch(input); ok {
			r.lastTool = name
			return ans, true
		}
	}

	lower := strings.ToLower(input)

	// Try each reasoning module in order of specificity.
	// Sorting is tried first because it has a very distinct trigger phrase.
	if answer, ok := r.trySorting(lower); ok {
		return answer, true
	}
	if answer, ok := r.trySyllogism(input); ok {
		return answer, true
	}
	if answer, ok := r.trySequence(lower); ok {
		return answer, true
	}
	if answer, ok := r.tryArithmetic(lower); ok {
		return answer, true
	}
	if answer, ok := r.tryWordProblem(lower); ok {
		return answer, true
	}
	return "", false
}

// ─────────────────────────────────────────────────────────────────────
// Arithmetic — Direct math expression detection
// ─────────────────────────────────────────────────────────────────────

// reDirectMath matches patterns like "5+2+8*9" or "what is 15 + 27"
var reDirectMath = regexp.MustCompile(`([\d\.]+(?:\s*[\+\-\*\/]\s*[\d\.]+)+)`)

func (r *ReasoningEngine) tryArithmetic(input string) (string, bool) {
	// Clean text from common words first to help extraction
	input = strings.ReplaceAll(input, "what is", "")
	input = strings.ReplaceAll(input, "calculate", "")
	input = strings.ReplaceAll(input, "?", "")
	input = strings.ReplaceAll(input, "plus", "+")
	input = strings.ReplaceAll(input, "minus", "-")
	input = strings.ReplaceAll(input, "times", "*")
	input = strings.ReplaceAll(input, "divided by", "/")

	m := reDirectMath.FindString(input)
	if m == "" {
		return "", false
	}

	expr, err := govaluate.NewEvaluableExpression(m)
	if err != nil {
		return "", false
	}

	result, err := expr.Evaluate(nil)
	if err != nil {
		return "", false
	}

	if val, ok := result.(float64); ok {
		return formatNumber(val), true
	}

	return "", false
}

// ─────────────────────────────────────────────────────────────────────
// Word Problems — Extract numbers and operations from natural language
// ─────────────────────────────────────────────────────────────────────

func (r *ReasoningEngine) tryWordProblem(input string) (string, bool) {
	// Strategy: extract all numbers from the text, then look for
	// operational keywords to determine what to do with them.
	numbers := extractNumbers(input)
	if len(numbers) < 2 {
		return "", false
	}

	// Keyword-based operation detection.
	// We look for action verbs that imply arithmetic operations.

	// Subtraction cues: "give away", "leave", "take away", "lose", "eat",
	// "remove", "subtract"
	hasSubtract := containsAny(input, []string{
		"give away", "gave away", "take away", "took away",
		"leave", "leaves", "left",
		"lose", "lost", "ate", "eat", "eats",
		"remove", "subtract",
	})

	// Addition cues: "come in", "more come", "join", "add", "arrive",
	// "get", "receive", "buy"
	hasAdd := containsAny(input, []string{
		"come in", "comes in", "came in",
		"more come", "more came",
		"join", "joined", "joins",
		"add", "added", "adds",
		"arrive", "arrived", "arrives",
		"get", "gets", "got",
		"receive", "received",
		"buy", "bought",
		"then",
	})

	// "How many" question pattern—compound word problem.
	// e.g. "5 cats, 2 leave, 3 come in" → 5 - 2 + 3 = 6
	if strings.Contains(input, "how many") && len(numbers) >= 2 {
		return r.solveCompoundWordProblem(input, numbers, hasSubtract, hasAdd)
	}

	// Simple two-number word problems.
	if len(numbers) == 2 {
		a, b := numbers[0], numbers[1]
		if hasSubtract && !hasAdd {
			return formatNumber(a - b), true
		}
		if hasAdd && !hasSubtract {
			return formatNumber(a + b), true
		}
	}

	return "", false
}

// solveCompoundWordProblem handles multi-step word problems like
// "5 cats, 2 leave, then 3 come in. How many cats?"
func (r *ReasoningEngine) solveCompoundWordProblem(input string, numbers []float64, hasSubtract, hasAdd bool) (string, bool) {
	if len(numbers) < 2 {
		return "", false
	}

	// Heuristic: the first number is the starting quantity.
	// Subsequent numbers are applied based on nearby action keywords.
	result := numbers[0]

	// Split the sentence into clauses to associate each number with an action.
	// We look for the position of each number in the text and check the
	// surrounding context for add/subtract cues.
	subtractWords := []string{
		"give away", "gave away", "take away", "took away",
		"leave", "leaves", "left",
		"lose", "lost", "ate", "eat", "eats",
		"remove", "subtract",
	}
	addWords := []string{
		"come in", "comes in", "came in",
		"more come", "more came", "more join",
		"join", "joined", "joins",
		"add", "added", "adds",
		"arrive", "arrived", "arrives",
	}

	// Find all number positions in the text.
	reNum := regexp.MustCompile(`\d+(?:\.\d+)?`)
	matches := reNum.FindAllStringIndex(input, -1)

	for i := 1; i < len(numbers) && i < len(matches); i++ {
		// Context: text AFTER the current number up to the next number.
		// This prevents action keywords from earlier clauses from bleeding
		// into later numbers' contexts (e.g. "2 leave" shouldn't affect "3 come in").
		afterStart := matches[i][1]
		afterEnd := len(input)
		if i+1 < len(matches) {
			afterEnd = matches[i+1][0]
		}
		afterCtx := input[afterStart:afterEnd]

		// Also check a narrow window before the number (from previous
		// number's end to this number's start) for pre-number verbs
		// like "give away 1".
		beforeCtx := input[matches[i-1][1]:matches[i][0]]

		if containsAny(afterCtx, subtractWords) {
			result -= numbers[i]
		} else if containsAny(afterCtx, addWords) {
			result += numbers[i]
		} else if containsAny(beforeCtx, subtractWords) {
			result -= numbers[i]
		} else if containsAny(beforeCtx, addWords) {
			result += numbers[i]
		} else if hasSubtract && !hasAdd {
			result -= numbers[i]
		} else if hasAdd && !hasSubtract {
			result += numbers[i]
		}
	}

	return formatNumber(result), true
}

// ─────────────────────────────────────────────────────────────────────
// Pattern Recognition — Numeric sequence prediction
// ─────────────────────────────────────────────────────────────────────

func (r *ReasoningEngine) trySequence(input string) (string, bool) {
	// Must look like a sequence question.
	if !strings.Contains(input, "next") && !strings.Contains(input, "sequence") && !strings.Contains(input, "pattern") {
		return "", false
	}

	numbers := extractNumbers(input)
	if len(numbers) < 3 {
		return "", false
	}

	// Try arithmetic sequence (constant difference).
	if answer, ok := tryArithmeticSequence(numbers); ok {
		return answer, true
	}

	// Try geometric sequence (constant ratio).
	if answer, ok := tryGeometricSequence(numbers); ok {
		return answer, true
	}

	return "", false
}

// tryArithmeticSequence checks if the numbers form an arithmetic sequence
// (constant difference) and predicts the next term.
func tryArithmeticSequence(nums []float64) (string, bool) {
	if len(nums) < 3 {
		return "", false
	}

	diff := nums[1] - nums[0]
	for i := 2; i < len(nums); i++ {
		if nums[i]-nums[i-1] != diff {
			return "", false
		}
	}

	next := nums[len(nums)-1] + diff
	return formatNumber(next), true
}

// tryGeometricSequence checks if the numbers form a geometric sequence
// (constant ratio) and predicts the next term.
func tryGeometricSequence(nums []float64) (string, bool) {
	if len(nums) < 3 || nums[0] == 0 {
		return "", false
	}

	ratio := nums[1] / nums[0]
	if ratio == 0 {
		return "", false
	}

	for i := 2; i < len(nums); i++ {
		if nums[i-1] == 0 {
			return "", false
		}
		if nums[i]/nums[i-1] != ratio {
			return "", false
		}
	}

	next := nums[len(nums)-1] * ratio
	return formatNumber(next), true
}

// ─────────────────────────────────────────────────────────────────────
// Syllogistic Logic — Simple deductive reasoning
// ─────────────────────────────────────────────────────────────────────

// reSyllogism matches "All X are Y. Z is X. Is Z Y?"
var reSyllogism = regexp.MustCompile(
	`(?i)all\s+(\w+)\s+are\s+(\w+)\s*\.\s*(\w+)\s+is\s+(?:a\s+|an\s+)?(\w+)\s*\.\s*is\s+(\w+)\s+(?:a\s+|an\s+)?(\w+)\s*\??`)

func (r *ReasoningEngine) trySyllogism(input string) (string, bool) {
	// Run on original input to preserve casing of names
	m := reSyllogism.FindStringSubmatch(input)
	if m == nil {
		return "", false
	}

	// "All X are Y. Z is X. Is Z Y?"
	// m[1]=X (category), m[2]=Y (property)
	// m[3]=Z (instance name), m[4]=X (should match m[1])
	// m[5]=Z (should match m[3]), m[6]=Y (should match m[2])
	category := strings.ToLower(m[1])
	property := strings.ToLower(m[2])
	instanceName := m[3] // Keep original case for display
	instanceCategory := strings.ToLower(m[4])
	questionSubject := strings.ToLower(m[5])
	questionProperty := m[6] // Keep original case for display

	// Validate the syllogism structure.
	// Use stemMatch for comparison to handle singular/plural forms
	// (e.g. "dogs" matches "dog", "animals" matches "animal").
	if stemMatch(instanceCategory, category) &&
		questionSubject == strings.ToLower(instanceName) &&
		stemMatch(strings.ToLower(questionProperty), property) {
		// Determine article: "an" before vowels, "a" otherwise.
		article := "a"
		if len(questionProperty) > 0 {
			first := strings.ToLower(questionProperty[:1])
			if first == "a" || first == "e" || first == "i" || first == "o" || first == "u" {
				article = "an"
			}
		}
		return fmt.Sprintf("yes, %s is %s %s", instanceName, article, questionProperty), true
	}

	// The subject is in the category but asking about a different property.
	if stemMatch(instanceCategory, category) && questionSubject == strings.ToLower(instanceName) {
		return "no", true
	}

	return "", false
}

// ─────────────────────────────────────────────────────────────────────
// Sorting — Parse and sort numeric lists
// ─────────────────────────────────────────────────────────────────────

func (r *ReasoningEngine) trySorting(input string) (string, bool) {
	if !strings.Contains(input, "sort") {
		return "", false
	}

	numbers := extractNumbers(input)
	if len(numbers) < 2 {
		return "", false
	}

	// Detect sort direction.
	descending := containsAny(input, []string{
		"largest to smallest", "descending", "biggest to smallest",
		"high to low", "greatest to least",
	})

	sort.Float64s(numbers)
	if descending {
		// Reverse the slice.
		for i, j := 0, len(numbers)-1; i < j; i, j = i+1, j-1 {
			numbers[i], numbers[j] = numbers[j], numbers[i]
		}
	}

	parts := make([]string, len(numbers))
	for i, n := range numbers {
		parts[i] = formatNumber(n)
	}
	return strings.Join(parts, " "), true
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

// extractNumbers finds all numeric values in the text.
var reNumber = regexp.MustCompile(`\d+(?:\.\d+)?`)

func extractNumbers(text string) []float64 {
	matches := reNumber.FindAllString(text, -1)
	nums := make([]float64, 0, len(matches))
	for _, m := range matches {
		if n, err := strconv.ParseFloat(m, 64); err == nil {
			nums = append(nums, n)
		}
	}
	return nums
}

// containsAny returns true if the text contains any of the given substrings.
func containsAny(text string, subs []string) bool {
	for _, s := range subs {
		if strings.Contains(text, s) {
			return true
		}
	}
	return false
}

// stemMatch compares two words with basic singular/plural normalisation.
// "dogs" matches "dog", "animals" matches "animal", "cats" matches "cat".
func stemMatch(a, b string) bool {
	if a == b {
		return true
	}
	return naiveStem(a) == naiveStem(b)
}

// naiveStem strips common English plural suffixes for comparison purposes.
func naiveStem(word string) string {
	if strings.HasSuffix(word, "ses") || strings.HasSuffix(word, "xes") || strings.HasSuffix(word, "zes") || strings.HasSuffix(word, "ches") || strings.HasSuffix(word, "shes") {
		return word[:len(word)-2]
	}
	if strings.HasSuffix(word, "ies") && len(word) > 3 {
		return word[:len(word)-3] + "y"
	}
	if strings.HasSuffix(word, "s") && !strings.HasSuffix(word, "ss") && len(word) > 2 {
		return word[:len(word)-1]
	}
	return word
}

// formatNumber formats a float64 as a clean string:
// integers are displayed without decimal points, floats keep their precision.
func formatNumber(n float64) string {
	if n == float64(int64(n)) {
		return fmt.Sprintf("%d", int64(n))
	}
	return strconv.FormatFloat(n, 'f', -1, 64)
}
