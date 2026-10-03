package federated

import (
	"crypto/ed25519"
	"crypto/rand"
	"math"
	"reflect"
	"testing"
	"time"
)

func TestTrainerPausesOnInvalidGPUCeiling(t *testing.T) {
	for _, ceiling := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), -1, 0} {
		trainer := trainerFixture(t, "test-node", ceiling)
		if delta, err := trainer.ComputeMicroBatch(1, "layer", 1); err == nil || delta != nil || simRuns(trainer) != 0 {
			t.Fatalf("invalid GPU ceiling %v produced a delta", ceiling)
		}
		trainer.SetMaxGPUPercent(25)
		if _, err := trainer.ComputeMicroBatch(1, "layer", 1); err != nil {
			t.Fatalf("valid ceiling did not resume the trainer: %v", err)
		}
		trainer.SetMaxGPUPercent(ceiling)
		if delta, err := trainer.ComputeMicroBatch(1, "layer", 1); err == nil || delta != nil || simRuns(trainer) != 1 {
			t.Fatal("invalid updated ceiling did not pause training")
		}
	}
	trainer := trainerFixture(t, "test-node", 200)
	if trainer.maxGPUPercent != 100 {
		t.Fatal("GPU percentage exceeded 100")
	}
}

func TestTrainerNeverSimulatesWithoutExplicitConfiguration(t *testing.T) {
	trainer := NewLocalTrainer("test-node", 25)
	if delta, err := trainer.ComputeMicroBatch(1, "layer", 1); err == nil || delta != nil || simRuns(trainer) != 0 {
		t.Fatal("unconfigured trainer fabricated work")
	}
	first := trainerFixture(t, "test-node", 25)
	second := trainerFixture(t, "test-node", 25)
	a, err := first.ComputeMicroBatch(1, "layer", 8)
	if err != nil {
		t.Fatal(err)
	}
	b, err := second.ComputeMicroBatch(1, "layer", 8)
	if err != nil {
		t.Fatal(err)
	}
	if a.Evidence != "SIMULATED" || b.Evidence != "SIMULATED" || !reflect.DeepEqual(a.Values, b.Values) || a.Loss != b.Loss {
		t.Fatal("configured synthetic simulation is unlabelled or irreproducible")
	}
	if err := first.ConfigureSimulation(simConfig(first)); err == nil {
		t.Fatal("simulation silently reset after work started")
	}
}

func TestDeltaSignatureCoversEvidenceAndFullTime(t *testing.T) {
	trainer := trainerFixture(t, "test-node", 25)
	delta, err := trainer.ComputeMicroBatch(1, "layer", 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*WeightDelta){
		func(copy *WeightDelta) { copy.Evidence = "MEASURED" },
		func(copy *WeightDelta) { copy.IsPoisonous = true },
		func(copy *WeightDelta) { copy.Timestamp = copy.Timestamp.Add(time.Nanosecond) },
		func(copy *WeightDelta) { copy.SignatureVersion = 0 },
	} {
		copy := *delta
		mutate(&copy)
		if copy.VerifySignature(trainer.PublicKey()) {
			t.Fatal("modified evidence/time/version kept a valid delta signature")
		}
	}
}

func TestCandidateContentHashHasUnambiguousStringBoundaries(t *testing.T) {
	first := calculateProofHash("a", 1, "2:b", 7, []float64{1})
	second := calculateProofHash("a:1", 2, "b", 7, []float64{1})
	if first == second {
		t.Fatal("candidate content hash aliases delimiter-separated fields")
	}
}

func TestTrainerRefusesMismatchedSigningKeys(t *testing.T) {
	trainer := trainerFixture(t, "test-node", 25)
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	trainer.SetKeyPair(pub, trainer.privateKey())
	if delta, err := trainer.ComputeMicroBatch(1, "layer", 1); err == nil || delta != nil || simRuns(trainer) != 0 {
		t.Fatal("mismatched signing keys produced an unverifiable delta")
	}
}

func TestLargestRoundProducesFiniteSignedDelta(t *testing.T) {
	trainer := trainerFixture(t, "test-node", 25)
	delta, err := trainer.ComputeMicroBatch(int(^uint(0)>>1), "layer", 8)
	if err != nil || !VerifyDeltaIntegrity(delta) || !delta.VerifySignature(trainer.PublicKey()) {
		t.Fatalf("largest round failed: %+v %v", delta, err)
	}
	for _, value := range delta.Values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			t.Fatal("largest round overflowed a gradient")
		}
	}
	for _, count := range []int{0, -1} {
		if _, err := trainer.ComputeMicroBatch(1, "layer", count); err == nil {
			t.Fatal("implicit parameter-count default accepted")
		}
	}
}

func TestContentHashRejectsNonfiniteGradients(t *testing.T) {
	trainer := trainerFixture(t, "test-node", 25)
	delta, err := trainer.ComputeMicroBatch(1, "layer", 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		copy := *delta
		copy.Values = []float64{value}
		copy.ProofHash = calculateProofHash(copy.NodeID, copy.RoundID, copy.LayerName, copy.ProofNonce, copy.Values)
		if VerifyDeltaIntegrity(&copy) {
			t.Fatalf("nonfinite gradient %v passed hash verification", value)
		}
	}
}

func TestCandidateRejectsWrongDimensions(t *testing.T) {
	agg := aggregationFixture(t, 1, 64)
	trainer := trainerFixture(t, "test-node", 25)
	if err := agg.RegisterNodeKey("test-node", trainer.PublicKey()); err != nil {
		t.Fatal(err)
	}
	for _, count := range []int{1, 63, 65} {
		delta, err := trainer.ComputeMicroBatch(1, "transformer.lora_a", count)
		if err != nil {
			t.Fatal(err)
		}
		if ok, reason := agg.SubmitDelta(delta); ok || reason != "REJECTED_DELTA_DIMENSION" {
			t.Fatalf("wrong dimension %d was not refused: %v %s", count, ok, reason)
		}
	}
	if len(agg.pendingDeltas) != 0 {
		t.Fatal("rejected dimensions occupied a round slot")
	}
}

func TestCandidateStartsEmptyAndOwnsExplicitWeights(t *testing.T) {
	agg := NewFederatedAggregator(1)
	if len(agg.GetCurrentCheckpoint().Weights) != 0 {
		t.Fatal("new aggregator invented weights")
	}
	weights := map[string][]float64{"layer": {1, 2}}
	policy := AggregationPolicy{LearningRate: 0.1, MaxGradientNorm: 1}
	if err := agg.ConfigureCandidate(weights, policy); err != nil {
		t.Fatal(err)
	}
	weights["layer"][0] = 99
	if agg.GetCurrentCheckpoint().Weights["layer"][0] != 1 {
		t.Fatal("caller mutated the configured candidate")
	}
	if err := agg.ConfigureCandidate(weights, policy); err == nil {
		t.Fatal("candidate reconfiguration overwrote existing weights")
	}
}

func TestFailedCandidateUpdateIsAtomic(t *testing.T) {
	agg := NewFederatedAggregator(1)
	if err := agg.ConfigureCandidate(map[string][]float64{"layer": {math.MaxFloat64}},
		AggregationPolicy{LearningRate: math.MaxFloat64, MaxGradientNorm: 2}); err != nil {
		t.Fatal(err)
	}
	trainer := trainerFixture(t, "test-node", 25)
	if err := agg.RegisterNodeKey("test-node", trainer.PublicKey()); err != nil {
		t.Fatal(err)
	}
	delta, err := trainer.ComputeMicroBatch(1, "layer", 1)
	if err != nil {
		t.Fatal(err)
	}
	delta.Values[0] = 1
	delta.ProofHash = calculateProofHash(delta.NodeID, delta.RoundID, delta.LayerName, delta.ProofNonce, delta.Values)
	if err := delta.Sign(trainer.privateKey()); err != nil {
		t.Fatal(err)
	}
	if ok, reason := agg.SubmitDelta(delta); !ok {
		t.Fatal(reason)
	}
	before := agg.GetCurrentCheckpoint()
	if _, _, err := agg.AggregateRound(); err == nil {
		t.Fatal("overflowing candidate update accepted")
	}
	if !reflect.DeepEqual(before, agg.GetCurrentCheckpoint()) || agg.GetCurrentRound() != 1 || len(agg.pendingDeltas) != 1 {
		t.Fatal("failed candidate update changed state")
	}
}

func TestCandidateRoundCannotWrap(t *testing.T) {
	round := int(^uint(0) >> 1)
	agg := aggregationFixture(t, round, 1)
	trainer := trainerFixture(t, "test-node", 25)
	if err := agg.RegisterNodeKey("test-node", trainer.PublicKey()); err != nil {
		t.Fatal(err)
	}
	delta, err := trainer.ComputeMicroBatch(round, "transformer.lora_a", 1)
	if err != nil {
		t.Fatal(err)
	}
	if ok, reason := agg.SubmitDelta(delta); !ok {
		t.Fatal(reason)
	}
	if _, _, err := agg.AggregateRound(); err == nil || agg.GetCurrentRound() != round {
		t.Fatal("candidate round wrapped around")
	}
}
