package cortex

// self_evaluator.go — Self-testing system for Ilaria.
//
// The SelfEvaluator generates test cases from learned material,
// tests the organism, and tracks improvement over time.
// This closes the autonomous learning loop: learn → test → identify gaps → repeat.

import (
	"strings"
	"time"
)

// Default limits for SelfEvaluator — extracted as named constants.
const (
	DefaultSelfEvaluatorMaxTests        = 500 // Maximum test bank size
	DefaultSelfEvaluatorMaxEvalPerCycle = 50  // Max tests evaluated per cycle
)

// SelfEvaluator tests the organism's knowledge and tracks progress.
type SelfEvaluator struct {
	TestBank     []SelfTest   // Pool of self-generated tests
	ScoreHistory []ScorePoint // Historical scores
	MaxTests     int          // Max test bank size
}

// SelfTest is a single self-generated test case.
type SelfTest struct {
	Question  string
	Expected  string
	Source    string // Where we learned this
	Created   time.Time
	LastScore float64 // Last evaluation score (0-1)
}

// ScorePoint records a score at a point in time.
type ScorePoint struct {
	Timestamp time.Time
	Score     float64
	TestCount int
	Correct   int
}

// NewSelfEvaluator creates a new evaluator.
func NewSelfEvaluator() *SelfEvaluator {
	return &SelfEvaluator{
		MaxTests: DefaultSelfEvaluatorMaxTests,
	}
}

// AddTestFromQA creates a test from a learned Q&A pair.
func (se *SelfEvaluator) AddTestFromQA(question, expected, source string) {
	if question == "" || expected == "" {
		return
	}

	// Don't duplicate
	for _, t := range se.TestBank {
		if strings.EqualFold(t.Question, question) {
			return
		}
	}

	se.TestBank = append(se.TestBank, SelfTest{
		Question: question,
		Expected: expected,
		Source:   source,
		Created:  time.Now(),
	})

	// Keep test bank bounded
	if len(se.TestBank) > se.MaxTests {
		se.TestBank = se.TestBank[len(se.TestBank)-se.MaxTests:]
	}
}

// AddTestFromFact creates a test from a learned fact.
// Example: fact "Paris is the capital of France"
// → question "What is the capital of France?", expected contains "Paris"
func (se *SelfEvaluator) AddTestFromFact(title, content, source string) {
	if title == "" || content == "" {
		return
	}
	question := "What is " + title + "?"
	se.AddTestFromQA(question, content, source)
}

// Evaluate runs all tests against the organism and returns the score.
func (se *SelfEvaluator) Evaluate(org *Organism) ScorePoint {
	if len(se.TestBank) == 0 {
		return ScorePoint{Timestamp: time.Now()}
	}

	correct := 0
	// Test a subset to avoid slowness (max 50 per eval)
	maxEval := DefaultSelfEvaluatorMaxEvalPerCycle
	if len(se.TestBank) < maxEval {
		maxEval = len(se.TestBank)
	}

	for i := 0; i < maxEval; i++ {
		test := &se.TestBank[i]
		response := org.Process(test.Question)
		score := textSimilarity(response, test.Expected)
		test.LastScore = score
		if score > 0.3 { // At least 30% word overlap = partial match
			correct++
		}
	}

	point := ScorePoint{
		Timestamp: time.Now(),
		Score:     float64(correct) / float64(maxEval),
		TestCount: maxEval,
		Correct:   correct,
	}
	se.ScoreHistory = append(se.ScoreHistory, point)
	return point
}

// WeakTests returns tests where the organism scored poorly.
// These become new KnowledgeGaps for the CuriosityLoop.
func (se *SelfEvaluator) WeakTests(threshold float64) []SelfTest {
	var weak []SelfTest
	for _, t := range se.TestBank {
		if t.LastScore < threshold {
			weak = append(weak, t)
		}
	}
	return weak
}

// ImprovementTrend returns the average score improvement over the last N evaluations.
func (se *SelfEvaluator) ImprovementTrend(window int) float64 {
	if len(se.ScoreHistory) < 2 {
		return 0
	}
	if window > len(se.ScoreHistory) {
		window = len(se.ScoreHistory)
	}
	recent := se.ScoreHistory[len(se.ScoreHistory)-window:]
	return recent[len(recent)-1].Score - recent[0].Score
}

// textSimilarity returns word overlap ratio between two texts (0-1).
func textSimilarity(a, b string) float64 {
	wordsA := strings.Fields(strings.ToLower(a))
	wordsB := strings.Fields(strings.ToLower(b))
	if len(wordsA) == 0 || len(wordsB) == 0 {
		return 0
	}

	setB := make(map[string]bool, len(wordsB))
	for _, w := range wordsB {
		setB[w] = true
	}

	matches := 0
	for _, w := range wordsA {
		if setB[w] {
			matches++
		}
	}

	// Jaccard-like: matches / union
	union := len(wordsA) + len(wordsB) - matches
	if union == 0 {
		return 0
	}
	return float64(matches) / float64(union)
}
