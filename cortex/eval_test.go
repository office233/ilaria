package cortex

import (
	"math/rand"
	"testing"
)

func TestRunSuiteIsolatedUsesFreshOrganismPerCase(t *testing.T) {
	cfg := organismTestConfig(t)
	cfg.DataDir = t.TempDir()
	cases := []TestCase{
		{Input: "unknown one", MustNotEqualInput: true},
		{Input: "unknown two", MustNotEqualInput: true},
	}

	calls := 0
	RunSuiteIsolated("isolated", cases, func() *Organism {
		calls++
		return NewOrganism(cfg, rand.New(rand.NewSource(int64(calls))))
	})

	if calls != len(cases) {
		t.Fatalf("factory called %d times, want %d", calls, len(cases))
	}
}
