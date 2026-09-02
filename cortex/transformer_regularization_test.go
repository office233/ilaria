package cortex

import (
	"math"
	"math/rand"
	"testing"
)

func regTestConfig() TransformerConfig {
	return TransformerConfig{
		VocabSize: 60, EmbedDim: 16, NumHeads: 2,
		NumLayers: 2, FFNDim: 32, MaxSeqLen: 24, EOSTokenID: 3,
	}
}

// TestDropout_InferenceUnaffected: with dropout configured, Forward and
// generation must remain deterministic and identical to a rate-0 model
// with the same weights — dropout may only ever fire inside
// ForwardTrain.
func TestDropout_InferenceUnaffected(t *testing.T) {
	cfg := regTestConfig()
	m := NewMiniTransformer(cfg, rand.New(rand.NewSource(4)))
	seq := []int{2, 7, 11, 19, 3}

	base := m.Forward(seq)
	m.SetDropout(0.5)
	after := m.Forward(seq)

	for i := range base.Data {
		if base.Data[i] != after.Data[i] {
			t.Fatalf("inference logits changed after SetDropout: idx %d, %v vs %v",
				i, base.Data[i], after.Data[i])
		}
	}
}

// TestDropout_TrainingStochastic: with dropout armed, two ForwardTrain
// passes over the same input must differ (the masks are resampled) —
// if they don't, dropout silently never fires and the regularisation
// is imaginary.
func TestDropout_TrainingStochastic(t *testing.T) {
	cfg := regTestConfig()
	cfg.DropoutRate = 0.4
	m := NewMiniTransformer(cfg, rand.New(rand.NewSource(4)))
	seq := []int{2, 7, 11, 19, 3}

	a := m.ForwardTrain(seq)
	aCopy := append([]float32(nil), a.Data...)
	b := m.ForwardTrain(seq)

	same := true
	for i := range aCopy {
		if aCopy[i] != b.Data[i] {
			same = false
			break
		}
	}
	if same {
		t.Fatal("two ForwardTrain passes produced identical logits at rate 0.4 — dropout never fired")
	}
}

// TestDropout_TrainingConverges: real backprop through the dropout
// masks must still overfit a single sequence — a chain-rule mistake in
// the mask handling shows up as a loss plateau or NaN.
func TestDropout_TrainingConverges(t *testing.T) {
	cfg := regTestConfig()
	cfg.DropoutRate = 0.1
	m := NewMiniTransformer(cfg, rand.New(rand.NewSource(9)))
	opt := NewAdamState(m, DefaultAdamConfig())
	seq := []int{2, 5, 10, 15, 20, 8, 3}

	first := m.TrainStepAdam(seq, 0.01, opt)
	var last float32
	for i := 0; i < 150; i++ {
		last = m.TrainStepAdam(seq, 0.01, opt)
	}
	if last != last {
		t.Fatal("loss is NaN with dropout enabled")
	}
	if last > first*0.5 {
		t.Fatalf("training with dropout does not converge: %.4f → %.4f", first, last)
	}
	t.Logf("dropout training loss: %.4f → %.4f over 150 steps", first, last)
}

// TestAdamW_DecayShrinksWeights: with a large decay and zero-ish
// gradients (empty-ish training), matrix weights must shrink while
// LayerNorm gammas — never decayed — hold their ground.
func TestAdamW_DecayShrinksWeights(t *testing.T) {
	cfg := regTestConfig()
	m := NewMiniTransformer(cfg, rand.New(rand.NewSource(12)))

	adamCfg := DefaultAdamConfig()
	adamCfg.WeightDecay = 0.1
	opt := NewAdamState(m, adamCfg)

	normW := func() float64 {
		s := 0.0
		for _, v := range m.Blocks[0].Attn.WQ.Data {
			s += float64(v) * float64(v)
		}
		return math.Sqrt(s)
	}
	gammaBefore := append([]float32(nil), m.Blocks[0].LN1Gamma.Data...)
	wBefore := normW()

	// Zero grads + Apply: pure decay steps.
	for i := 0; i < 20; i++ {
		m.zeroAllGrads()
		opt.Apply(m, 0.05)
	}

	if wAfter := normW(); wAfter >= wBefore*0.95 {
		t.Fatalf("weight decay did not shrink WQ: %v → %v", wBefore, wAfter)
	}
	for i, g := range m.Blocks[0].LN1Gamma.Data {
		if g != gammaBefore[i] {
			t.Fatalf("LayerNorm gamma decayed (idx %d: %v → %v) — LN must be exempt",
				i, gammaBefore[i], g)
		}
	}
}

// TestBatchPerTokenWeighting: a batch holding one long and one short
// sequence must weight the long one's gradient proportionally to its
// token count. We verify via loss semantics: the returned batch loss
// must equal the token-weighted mean of the individual losses.
func TestBatchPerTokenWeighting(t *testing.T) {
	cfg := regTestConfig()
	long := []int{2, 5, 10, 15, 20, 8, 9, 4, 3}
	short := []int{2, 7, 3}

	// Measure individual losses on an identical untouched model.
	mA := NewMiniTransformer(cfg, rand.New(rand.NewSource(33)))
	lossLong := CrossEntropyLoss(mA.ForwardTrain(long[:len(long)-1]), long[1:])
	lossShort := CrossEntropyLoss(mA.ForwardTrain(short[:len(short)-1]), short[1:])

	tokLong := float32(len(long) - 1)
	tokShort := float32(len(short) - 1)
	wantMean := (lossLong*tokLong + lossShort*tokShort) / (tokLong + tokShort)

	mB := NewMiniTransformer(cfg, rand.New(rand.NewSource(33)))
	optB := NewAdamState(mB, DefaultAdamConfig())
	got := mB.TrainStepAdamBatch([][]int{long, short}, 0.001, optB)

	if d := got - wantMean; d > 1e-4 || d < -1e-4 {
		t.Fatalf("batch loss %v, want token-weighted mean %v (per-sequence mean would be %v)",
			got, wantMean, (lossLong+lossShort)/2)
	}
}
