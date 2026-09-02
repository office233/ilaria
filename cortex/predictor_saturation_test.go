package cortex

import (
	"math/rand"
	"testing"
)


// newTestPredictorEnc builds a predictor + encoder pair the same way the
// existing suite does, so these tests exercise the real configuration.
func newTestPredictorEnc(t *testing.T) (*Predictor, *Encoder) {
	t.Helper()
	cfg := DefaultConfig()
	cfg.DataDir = t.TempDir()
	rng := rand.New(rand.NewSource(42))
	vocab := NewVocab()
	enc := NewEncoder(vocab, cfg.SDRSize, cfg.ActiveCount, rng, cfg)
	return NewPredictor(cfg), enc
}

// TestPredictor_UpdateWithoutPredictSaturates documents the failure mode that
// silently wasted a 28-minute training run: calling Update() without a prior
// Predict() compares reality against an EMPTY LastPrediction, so overlap is
// zero and the error pins at 255 forever.
//
// A saturated 255 is indistinguishable from "learned nothing" in the training
// log, but it actually means "never measured". Worse, it parks every item
// above the spaced-repetition threshold (>=50), so each epoch re-runs the
// entire corpus for no benefit.
func TestPredictor_UpdateWithoutPredictSaturates(t *testing.T) {
	p, enc := newTestPredictorEnc(t)

	sdr := enc.EncodeSentence("the capital of france is paris")

	// No Predict() call — this is the bug.
	got := p.Update(sdr)
	if got != 255 {
		t.Fatalf("expected saturated 255 without a prior Predict, got %d", got)
	}
}

// TestPredictor_PredictThenUpdateMeasuresRealOverlap proves the fix: once a
// prediction exists, the error reflects genuine overlap and can drop below
// the saturation point.
func TestPredictor_PredictThenUpdateMeasuresRealOverlap(t *testing.T) {
	p, enc := newTestPredictorEnc(t)

	sdr := enc.EncodeSentence("the capital of france is paris")

	// Predicting exactly what arrives is the best case: overlap is total,
	// so the error must be far below saturation.
	p.Predict(sdr)
	got := p.Update(sdr)

	if got == 255 {
		t.Fatal("error still saturated at 255 after Predict — prediction was ignored")
	}
	if got > 128 {
		t.Errorf("self-prediction should score well under half scale, got %d", got)
	}
	t.Logf("self-prediction error = %d (0 = perfect, 255 = no overlap)", got)
}

// TestPredictor_UnrelatedInputScoresWorseThanSelf is the ordering property the
// training loop depends on. If a wrong guess did not score worse than a right
// one, "surprise" would carry no information and spaced repetition would be
// choosing items at random.
func TestPredictor_UnrelatedInputScoresWorseThanSelf(t *testing.T) {
	_, enc := newTestPredictorEnc(t)

	question := enc.EncodeSentence("what is the capital of france")
	answer := enc.EncodeSentence("the capital of france is paris")
	unrelated := enc.EncodeSentence("photosynthesis converts light into chemical energy in plants")

	pSelf, _ := newTestPredictorEnc(t)
	pSelf.Predict(answer)
	selfErr := pSelf.Update(answer)

	pRelated, _ := newTestPredictorEnc(t)
	pRelated.Predict(question)
	relatedErr := pRelated.Update(answer)

	pWrong, _ := newTestPredictorEnc(t)
	pWrong.Predict(unrelated)
	wrongErr := pWrong.Update(answer)

	t.Logf("self=%d related=%d unrelated=%d", selfErr, relatedErr, wrongErr)

	if selfErr > wrongErr {
		t.Errorf("predicting the answer exactly (%d) scored worse than predicting something unrelated (%d)",
			selfErr, wrongErr)
	}
	if selfErr >= 255 {
		t.Errorf("exact self-prediction saturated at %d", selfErr)
	}
}
