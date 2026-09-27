package federated

import (
	"math"
	"testing"
)

func TestAggregatorOwnsSnapshots(t *testing.T) {
	agg := NewFederatedAggregator(1)
	trainer := NewLocalTrainer("test-node", 35)
	delta, err := trainer.ComputeMicroBatch(1, "transformer.lora_a", 32)
	if err != nil {
		t.Fatal(err)
	}
	if ok, reason := agg.SubmitDelta(delta); !ok {
		t.Fatal(reason)
	}
	if ok, _ := agg.SubmitDelta(delta); ok {
		t.Fatal("duplicate accepted")
	}
	delta.Values[0] = math.NaN()
	delta.Loss = math.NaN()
	checkpoint, _, err := agg.AggregateRound()
	if err != nil {
		t.Fatal(err)
	}
	if math.IsNaN(checkpoint.GlobalLoss) || math.IsNaN(checkpoint.Weights["transformer.lora_a"][0]) {
		t.Fatal("caller corrupted aggregation")
	}
	checkpoint.Weights["transformer.lora_a"][0] = 999
	if agg.GetCurrentCheckpoint().Weights["transformer.lora_a"][0] == 999 {
		t.Fatal("checkpoint exposes internal state")
	}
	old, err := trainer.ComputeMicroBatch(1, "transformer.lora_a", 32)
	if err != nil {
		t.Fatal(err)
	}
	if ok, _ := agg.SubmitDelta(old); ok {
		t.Fatal("stale round accepted")
	}
}

func TestKrumRejectsInvalidVectors(t *testing.T) {
	k := NewMultiKrumAggregator(1, 1)
	for _, deltas := range [][]*WeightDelta{{nil}, {{Values: []float64{math.NaN()}}}, {{Values: []float64{1}}, {Values: []float64{1, 2}}}} {
		if _, err := k.SelectRobustDeltas(deltas); err == nil {
			t.Fatal("invalid vectors accepted")
		}
	}
}
