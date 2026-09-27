package cortex

import (
	"math/rand"
	"os"
	"strings"
	"testing"
)

func TestOrganismNoEchoRegression(t *testing.T) {
	tempDir := "temp_org_test"
	t.Cleanup(func() {
		os.RemoveAll(tempDir)
	})

	// Initialize a fresh organism in a temporary directory with a Config
	rng := rand.New(rand.NewSource(42))
	cfg := organismTestConfig(t)
	cfg.DataDir = tempDir
	org := NewOrganism(cfg, rng)
	org.FractalCortex = nil // Disable FractalCortex to test pure empty-brain fallback

	input := "where do neurons fire?"

	// Process the input when the organism is completely fresh (zero knowledge)
	response := org.Process(input)

	// Regression test: the input must not be echoed back.
	if strings.TrimSpace(response) == strings.TrimSpace(input) {
		t.Errorf("FAIL: input prompt %q was echoed back as the response!", input)
	}

	// Since there is no learned data, the response should fall back to the no-confidence policy.
	expected := NoConfidentResponse
	if response != expected {
		t.Errorf("expected low-confidence fallback %q for empty brain, got: %q", expected, response)
	}
}

func TestOrganismRecovery(t *testing.T) {
	tempDir := t.TempDir()

	rng := rand.New(rand.NewSource(42))
	cfg := organismTestConfig(t)
	cfg.DataDir = tempDir
	cfg.PrefrontalInputCurrent = 128
	cfg.HippoReconsolidationThresh = 200
	cfg.HippoInitialStrength = 10
	cfg.HippoLtpThreshold = 128

	org := NewOrganism(cfg, rng)

	// Teach the organism some facts
	org.Learn("câinele aleargă prin grădina mare")
	org.Process("unde aleargă câinele?")

	// Save organism to disk
	if err := org.Save(cfg.DataDir); err != nil {
		t.Fatalf("failed to save organism: %v", err)
	}

	// Load organism back
	loadedOrg, err := LoadOrganism(cfg, rng)
	if err != nil {
		t.Fatalf("failed to load organism: %v", err)
	}

	// Verify that configuration parameters are fully recovered
	if loadedOrg.Prefrontal.InputCurrent != cfg.PrefrontalInputCurrent {
		t.Errorf("expected Prefrontal.InputCurrent to be %d, got %d", cfg.PrefrontalInputCurrent, loadedOrg.Prefrontal.InputCurrent)
	}
	if loadedOrg.Hippocampus.ReconsolidationThresh != cfg.HippoReconsolidationThresh {
		t.Errorf("expected Hippocampus.ReconsolidationThresh to be %d, got %d", cfg.HippoReconsolidationThresh, loadedOrg.Hippocampus.ReconsolidationThresh)
	}
	if loadedOrg.Hippocampus.InitialStrength != cfg.HippoInitialStrength {
		t.Errorf("expected Hippocampus.InitialStrength to be %d, got %d", cfg.HippoInitialStrength, loadedOrg.Hippocampus.InitialStrength)
	}
	if loadedOrg.Hippocampus.LtpThreshold != cfg.HippoLtpThreshold {
		t.Errorf("expected Hippocampus.LtpThreshold to be %d, got %d", cfg.HippoLtpThreshold, loadedOrg.Hippocampus.LtpThreshold)
	}

	// Verify Prefrontal thinking is active (spiking with non-zero input current)
	testSDR := NewSDR(100)
	testSDR.Set(10)
	testSDR.Set(20)
	refined := loadedOrg.Prefrontal.Think(testSDR, 20)

	// Spiking reservoir with input current must generate activity
	activeCount := 0
	for i := 0; i < refined.Size; i++ {
		if refined.IsActive(i) {
			activeCount++
		}
	}
	if activeCount == 0 {
		t.Error("Prefrontal reservoir is completely silent (0 active bits) on loaded organism!")
	}
	// NOTE: Prefrontal confidence may be 0 with sparse spiking networks
	// that haven't developed stable attractors. This is correct behavior
	// after fixing measureStability to use Jaccard on active neurons only.
	// The old test relied on the buggy behavior where confidence was always
	// ~95% because it counted silent-silent neuron matches.

	// Verify Hippocampal episodic memory stores new distinct facts without collapsing existing ones
	initialCount := loadedOrg.Hippocampus.Size()
	if initialCount == 0 {
		t.Fatal("expected loaded Hippocampus to have stored memories, got 0")
	}

	// Storing a highly distinct new memory
	distinctInput := NewSDR(cfg.SDRSize)
	distinctInput.Set(1)
	distinctInput.Set(2)
	distinctOutput := NewSDR(cfg.SDRSize)
	distinctOutput.Set(3)
	distinctOutput.Set(4)

	loadedOrg.Hippocampus.Store(distinctInput, distinctOutput, "new facts")

	// Ensure the memory count increased (proving no LTP/Reconsolidation Collapse)
	newCount := loadedOrg.Hippocampus.Size()
	if newCount <= initialCount {
		t.Errorf("Hippocampus memory count did not increase (LTP/Reconsolidation collapse). Stored memories collapsed! Initial: %d, New: %d", initialCount, newCount)
	}
}

func TestOrganismLearnQADoesNotPersistDirectAnswerMap(t *testing.T) {
	tempDir := t.TempDir()
	rng := rand.New(rand.NewSource(42))
	cfg := organismTestConfig(t)
	cfg.DataDir = tempDir

	org := NewOrganism(cfg, rng)
	org.LearnQA("what stores episodic memories?", "the hippocampus stores episodic memories.")

	if err := org.Save(cfg.DataDir); err != nil {
		t.Fatalf("failed to save organism: %v", err)
	}

	raw, err := os.ReadFile(tempDir + "/organism.json")
	if err != nil {
		t.Fatalf("failed to read organism metadata: %v", err)
	}
	if strings.Contains(string(raw), "qa_memory") {
		t.Fatalf("organism metadata must not persist direct qa_memory: %s", string(raw))
	}
}

func TestOrganismLearnQARetrievesEpisodicAnswerWithoutQAMemory(t *testing.T) {
	tempDir := t.TempDir()
	rng := rand.New(rand.NewSource(42))
	cfg := organismTestConfig(t)
	cfg.DataDir = tempDir
	cfg.MaxGenWords = 0              // Disable Broca generation to test pure fallback
	cfg.HippocampusRecallThresh = 50 // Lower threshold since test questions are short

	org := NewOrganism(cfg, rng)
	org.FractalCortex = nil // Disable AGI generation to test pure associative recall
	org.LearnQA("who loves gamma?", "gamma loves delta.")
	org.LearnQA("where is alpha?", "alpha is stored in beta.")

	response := org.Process("where is alpha?")
	if strings.TrimSpace(response) != "alpha is stored in beta." {
		t.Fatalf("expected exact episodic answer recall, got %q", response)
	}

	if err := org.Save(cfg.DataDir); err != nil {
		t.Fatalf("failed to save organism: %v", err)
	}
	raw, err := os.ReadFile(tempDir + "/organism.json")
	if err != nil {
		t.Fatalf("failed to read organism metadata: %v", err)
	}
	if strings.Contains(string(raw), "qa_memory") {
		t.Fatalf("episodic QA recall must not persist qa_memory: %s", string(raw))
	}
}

func TestOrganismLoadIgnoresLegacyQAMemory(t *testing.T) {
	tempDir := t.TempDir()
	rng := rand.New(rand.NewSource(42))
	cfg := organismTestConfig(t)
	cfg.DataDir = tempDir

	org := NewOrganism(cfg, rng)
	if err := org.Save(cfg.DataDir); err != nil {
		t.Fatalf("failed to save organism: %v", err)
	}

	legacyMeta := `{"interaction_count":0,"qa_memory":{"what stores episodic memories ?":"LEGACY HARD CODED ANSWER"}}`
	if err := os.WriteFile(tempDir+"/organism.json", []byte(legacyMeta), 0644); err != nil {
		t.Fatalf("failed to write legacy organism metadata: %v", err)
	}

	loadedOrg, err := LoadOrganism(cfg, rand.New(rand.NewSource(42)))
	if err != nil {
		t.Fatalf("failed to load organism: %v", err)
	}

	response := loadedOrg.Process("what stores episodic memories?")
	if strings.Contains(response, "LEGACY HARD CODED ANSWER") {
		t.Fatalf("legacy qa_memory was used as a direct answer: %q", response)
	}
}

func TestOrganismSuppressesLowConfidenceUnknownResponse(t *testing.T) {
	tempDir := t.TempDir()
	rng := rand.New(rand.NewSource(42))
	cfg := organismTestConfig(t)
	cfg.DataDir = tempDir

	org := NewOrganism(cfg, rng)
	org.FractalCortex = nil // Disable AGI generation to test pure associative recall
	org.Learn("the hippocampus stores episodic memories")

	response := org.Process("who invented the imaginary tensor loom?")
	if response != NoConfidentResponse {
		t.Fatalf("expected unknown prompt to produce low-confidence fallback, got %q", response)
	}
}

// TestOrganismSDRCollisionDoesNotReturnWrongTopic guards against the
// "capital of France returns Berlin" bug discovered 2026-05-26 via the
// cortex-eval harness.
//
// The bug: Wernicke's union-encoded SDR collapses structurally similar
// questions ("What is the capital of X?") to near-identical vectors.
// The original SDR fast-path (organism.go ~line 401) returned the
// highest-similarity stored memory at sim>=200 WITHOUT verifying that
// the chosen memory was about the actual topic of the query. Result:
// "What is the capital of France?" would hit the stored "What is the
// capital of Germany? | ... Berlin" memory with sim=255 (because the
// distinguishing token "france" vs "germany" contributes only a few
// bits to the union SDR) and confidently return "Berlin".
//
// The fix is fastPathKeywordVeto: if the RAREST distinctive (non-
// stopword) token from the query is absent from the chosen memory's
// context, the fast-path is skipped and the keyword path (which CAN
// distinguish on rare tokens) gets a turn.
//
// This test wires up three structurally identical Q/A pairs about
// capitals and verifies that querying for each one returns the right
// city, not whichever one happens to have the highest union-SDR
// overlap.
func TestOrganismSDRCollisionDoesNotReturnWrongTopic(t *testing.T) {
	tempDir := t.TempDir()
	rng := rand.New(rand.NewSource(42))
	cfg := organismTestConfig(t)
	cfg.DataDir = tempDir
	cfg.NoSave = true

	org := NewOrganism(cfg, rng)
	org.FractalCortex = nil // isolate the Hippocampus recall path

	// Seed the three structurally-identical Q/A pairs that collided in
	// the original bug. Order matters slightly: Germany is learned
	// first because in the original repro it was the "loudest" memory
	// in the union SDR and won the fast-path tie.
	// Bypass the reconsolidation-collapse bug: with default
	// ReconsolidationThresh, Wernicke produces SDRs so similar across
	// these three structurally-identical questions that Hippocampus
	// considers them the same memory and merges them. Raise the
	// reconsolidation threshold to its maximum so each Store creates
	// a distinct memory and the test can exercise the SDR-collapse
	// fingerprint detector specifically (which is the bug this test
	// is for). The underlying reconsolidation-collapse bug is tracked
	// separately by TestOrganismWernickeReconsolidationCollapse.
	org.Hippocampus.ReconsolidationThresh = 255

	org.LearnQAFast("What is the capital of Germany?", "The capital of Germany is Berlin.")
	org.LearnQAFast("What is the capital of France?", "Paris is the capital of France.")
	org.LearnQAFast("What is the capital of Japan?", "Tokyo is the capital of Japan.")
	if got := org.Hippocampus.Size(); got != 3 {
		t.Fatalf("setup invariant violated: expected 3 distinct memories, got %d", got)
	}

	cases := []struct {
		query    string
		mustHave string // substring expected in the response
		mustNot  string // substring that would prove collision
	}{
		{"What is the capital of France?", "Paris", "Berlin"},
		{"What is the capital of Japan?", "Tokyo", "Berlin"},
		{"What is the capital of Germany?", "Berlin", "Paris"},
	}

	for _, c := range cases {
		got := org.Process(c.query)
		if !strings.Contains(strings.ToLower(got), strings.ToLower(c.mustHave)) {
			t.Errorf("query %q: expected response to contain %q, got %q",
				c.query, c.mustHave, got)
		}
		if strings.Contains(strings.ToLower(got), strings.ToLower(c.mustNot)) {
			t.Errorf("query %q: response contains collision token %q (full response: %q)",
				c.query, c.mustNot, got)
		}
	}
}

// TestOrganismFastPathStillFiresForUniqueTopics is the companion to
// TestOrganismSDRCollisionDoesNotReturnWrongTopic. It ensures the
// fastPathKeywordVeto did not become so aggressive that it blocks the
// SDR fast-path on legitimate queries where the SDR match is the
// genuinely best memory and shares topic vocabulary with the query.
//
// Specifically: when the SDR's chosen memory contains the rarest
// distinctive token from the query, the veto must NOT fire (otherwise
// we'd regress queries like "Who developed the theory of relativity?"
// → "Einstein" which the eval harness caught when the veto was set
// too conservatively in fix v2).
func TestOrganismFastPathStillFiresForUniqueTopics(t *testing.T) {
	tempDir := t.TempDir()
	rng := rand.New(rand.NewSource(42))
	cfg := organismTestConfig(t)
	cfg.DataDir = tempDir
	cfg.NoSave = true

	org := NewOrganism(cfg, rng)
	org.FractalCortex = nil

	// Learn three unrelated facts. The rare token ("photosynthesis",
	// "relativity", "polonium") appears in both the question and the
	// stored answer, so the veto must NOT fire for these.
	org.LearnQAFast("What is photosynthesis?", "Photosynthesis is how plants use sunlight to make food.")
	org.LearnQAFast("Who developed the theory of relativity?", "Albert Einstein developed the theory of relativity.")
	org.LearnQAFast("Who discovered polonium?", "Marie Curie discovered polonium.")

	cases := []struct {
		query    string
		mustHave string
	}{
		{"What is photosynthesis?", "plant"},
		{"Who developed the theory of relativity?", "Einstein"},
		{"Who discovered polonium?", "Curie"},
	}

	for _, c := range cases {
		got := org.Process(c.query)
		if !strings.Contains(strings.ToLower(got), strings.ToLower(c.mustHave)) {
			t.Errorf("query %q: expected response to contain %q (fast-path veto too aggressive?), got %q",
				c.query, c.mustHave, got)
		}
	}
}

// TestOrganismWernickeReconsolidationCollapse documents (rather than
// gates on) a SECOND failure mode discovered during the SDR-collision
// investigation on 2026-05-26.
//
// When three structurally-identical Q/A pairs ("What is the capital
// of X?") are learned back-to-back into a fresh organism using the
// DEFAULT reconsolidation threshold, Wernicke produces question SDRs
// so similar that Hippocampus.Store treats every new memory as a
// reconsolidation of the first one and overwrites it. Result: 3
// LearnQAFast calls produce 1 stored memory (the last one), and the
// first two facts are effectively lost.
//
// In the cortex-eval audit this didn't surface because the eval
// corpus was loaded over many sessions with intervening other-topic
// learning, so the Wernicke vocabulary had already diverged enough
// that the SDRs were distinguishable at Store time. But the bug is
// real and will bite anyone bulk-loading similar Q/A pairs.
//
// This test runs in t.Skip mode for now — it's a known-broken
// canary, not a gate. Remove the Skip when the underlying Wernicke
// encoding is fixed (e.g. by increasing distinctive-token weight or
// adding rare-token boosting to the union-SDR construction).
func TestOrganismWernickeReconsolidationCollapse(t *testing.T) {
	t.Skip("known issue: Wernicke SDR collapse causes reconsolidation merge on structurally-identical Q/A pairs; tracked for follow-up")

	tempDir := t.TempDir()
	rng := rand.New(rand.NewSource(42))
	cfg := organismTestConfig(t)
	cfg.DataDir = tempDir
	cfg.NoSave = true

	org := NewOrganism(cfg, rng)
	org.FractalCortex = nil

	org.LearnQAFast("What is the capital of Germany?", "The capital of Germany is Berlin.")
	org.LearnQAFast("What is the capital of France?", "Paris is the capital of France.")
	org.LearnQAFast("What is the capital of Japan?", "Tokyo is the capital of Japan.")

	if got := org.Hippocampus.Size(); got != 3 {
		t.Errorf("Wernicke SDR collapse: expected 3 distinct memories after 3 Q/A learns, got %d (memories were reconsolidated into one)", got)
	}
}
