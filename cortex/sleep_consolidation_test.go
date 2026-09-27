package cortex

import (
	"math/rand"
	"testing"
)

// helper: build a minimal organism wired enough for sleep consolidation.
func newConsolidationTestOrg(t *testing.T) *Organism {
	t.Helper()
	cfg := organismTestConfig(t)
	cfg.DataDir = t.TempDir()
	cfg.SleepReplayCount = 5
	cfg.SleepInterleaveRatio = 2
	cfg.SleepStabilityThresh = 180
	rng := rand.New(rand.NewSource(42))
	return NewOrganism(cfg, rng)
}

func TestSleepConsolidationBasic(t *testing.T) {
	org := newConsolidationTestOrg(t)

	// Store several memories so there is something to replay.
	phrases := []string{
		"the cat sat on the mat",
		"dogs run in the park",
		"birds fly over trees",
		"fish swim in the lake",
		"the sun shines brightly",
	}
	for _, p := range phrases {
		org.Learn(p)
	}

	// Ensure hippocampus has memories.
	if org.Hippocampus.Size() == 0 {
		t.Fatal("Hippocampus should have memories after Learn calls")
	}

	// Run consolidation.
	report := org.SleepConsolidator.Consolidate(
		org.Hippocampus,
		org.Prefrontal,
		org.Brain,
		org.Broca,
		org.Self,
		org.Config,
	)

	// We replayed at least something.
	if report.Replayed == 0 {
		t.Error("expected at least one memory to be replayed")
	}

	// Total actions = Strengthened + Weakened + skipped (which equals
	// Replayed - Strengthened - Weakened). All counts ≥ 0.
	if report.Strengthened < 0 || report.Weakened < 0 {
		t.Error("negative counts in report")
	}

	// Logs should contain lines.
	if len(report.Logs) < 2 {
		t.Error("expected consolidation to produce log messages")
	}

	t.Logf("Replay=%d Strengthened=%d Weakened=%d Logs=%d",
		report.Replayed, report.Strengthened, report.Weakened, len(report.Logs))
}

func TestSleepConsolidationInterleave(t *testing.T) {
	recent := []Memory{
		{Input: NewSDR(64), Output: NewSDR(64), Strength: 10, Context: "r1"},
		{Input: NewSDR(64), Output: NewSDR(64), Strength: 10, Context: "r2"},
	}
	old := []Memory{
		{Input: NewSDR(64), Output: NewSDR(64), Strength: 50, Context: "o1"},
		{Input: NewSDR(64), Output: NewSDR(64), Strength: 50, Context: "o2"},
		{Input: NewSDR(64), Output: NewSDR(64), Strength: 50, Context: "o3"},
		{Input: NewSDR(64), Output: NewSDR(64), Strength: 50, Context: "o4"},
	}

	// Ratio 2 means: new, old, old, new, old, old, ...
	playlist := interleaveMemories(recent, old, 2)

	// Expected order: r1, o1, o2, r2, o3, o4
	expectedContexts := []string{"r1", "o1", "o2", "r2", "o3", "o4"}
	if len(playlist) != len(expectedContexts) {
		t.Fatalf("expected playlist length %d, got %d", len(expectedContexts), len(playlist))
	}
	for i, exp := range expectedContexts {
		if playlist[i].Context != exp {
			t.Errorf("playlist[%d].Context = %q, want %q", i, playlist[i].Context, exp)
		}
	}
}

func TestSleepConsolidationEmpty(t *testing.T) {
	org := newConsolidationTestOrg(t)

	// No memories stored — should not crash.
	report := org.SleepConsolidator.Consolidate(
		org.Hippocampus,
		org.Prefrontal,
		org.Brain,
		org.Broca,
		org.Self,
		org.Config,
	)

	if report.Replayed != 0 {
		t.Errorf("expected 0 replays on empty hippocampus, got %d", report.Replayed)
	}
	if report.Strengthened != 0 || report.Weakened != 0 {
		t.Error("expected zero strengthened/weakened on empty hippocampus")
	}
}

func TestSleepConsolidationViaSleep(t *testing.T) {
	// Verify that Sleep() integrates consolidation without crashing.
	org := newConsolidationTestOrg(t)

	org.Learn("neurons fire in the cortex")
	org.Learn("synapses connect neurons together")

	logs := org.Sleep()

	// Logs should include consolidation messages.
	found := false
	for _, l := range logs {
		if len(l) > 0 {
			found = true
		}
	}
	if !found {
		t.Error("expected Sleep() to return consolidation log messages")
	}
}
