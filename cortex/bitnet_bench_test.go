package cortex

// bitnet_bench_test.go — reproducible measurement harness for BitLinear /
// BitNetDecoder performance work (see the optimization task tracked
// alongside cortex/bitnet_linear.go and cortex/bitnet_decode.go).
//
// BenchmarkBitLinearForwardBatch isolates the hot inner loop
// (BitLinear.ForwardBatch) on the real 2560x6912 Gate/Up shape used by
// microsoft/bitnet-b1.58-2B-4T, with synthetic (but realistically-sparse,
// ~50% zero) ternary weights — no checkpoint file needed, so it always
// runs:
//
//	go test ./cortex -run=^$ -bench=BenchmarkBitLinearForwardBatch -benchtime=5x
//
// TestBitNetRealTiming is gated on NEXUS_BITNET_DIR (same env var as
// TestBitNetEquivalence in bitnet_equivalence_test.go) and reports prefill
// seconds/token and decode tokens/sec on the real checkpoint for a
// 16-token synthetic prompt (raw token ids, no tokenizer needed — argmax
// stability isn't the point here, timing is) followed by 16 generated
// tokens via BitNetDecoder.Step:
//
//	NEXUS_BITNET_DIR=D:/nexus/data/forge/bitnet-2b4t go test ./cortex -run TestBitNetRealTiming -v -timeout 10m

import (
	"math/rand"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// newSyntheticBitLinear builds a BitLinear of shape (in,out) with
// deterministic pseudo-random ternary weights at roughly 50% sparsity
// (matching the task's "synthetic ternary weights" ask) and a plausible
// non-unit Scale, so the benchmark exercises the same arithmetic shape
// (branch mix between zero/nonzero weights) as real checkpoint weights.
func newSyntheticBitLinear(in, out int, seed int64) *BitLinear {
	l := NewBitLinear(in, out)
	l.Scale = 0.017 // plausible absmean weight scale, order-of-magnitude only
	rng := rand.New(rand.NewSource(seed))
	row := make([]int8, in)
	for j := 0; j < out; j++ {
		for i := 0; i < in; i++ {
			switch rng.Intn(4) {
			case 0:
				row[i] = 1
			case 1:
				row[i] = -1
			default:
				row[i] = 0
			}
		}
		l.SetRow(j, row)
	}
	return l
}

func syntheticActivations(t, in int, seed int64) [][]float32 {
	rng := rand.New(rand.NewSource(seed))
	x := make([][]float32, t)
	for i := range x {
		row := make([]float32, in)
		for j := range row {
			row[j] = float32(rng.NormFloat64())
		}
		x[i] = row
	}
	return x
}

// BenchmarkBitLinearForwardBatch measures BitLinear.ForwardBatch on the
// real 2560->6912 Gate/Up projection shape (microsoft/bitnet-b1.58-2B-4T:
// EmbedDim=2560, FFNDim=6912) at two batch sizes: T=1 (BitNetDecoder.Step's
// shape — the decode-tok/s-critical path) and T=16 (BitNetDecoder.Prefill's
// shape for a 16-token prompt — the prefill-s/token-critical path).
func BenchmarkBitLinearForwardBatch(b *testing.B) {
	const in, out = 2560, 6912
	l := newSyntheticBitLinear(in, out, 1)

	for _, T := range []int{1, 16} {
		b.Run(benchName(T), func(b *testing.B) {
			x := syntheticActivations(T, in, 2)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				_ = l.ForwardBatch(x)
			}
		})
	}
}

func benchName(t int) string {
	switch t {
	case 1:
		return "T=1_decode_step"
	case 16:
		return "T=16_prefill"
	default:
		return "T=" + itoa(t)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// TestBitNetRealTiming loads the real 2.4B-param microsoft/bitnet-b1.58-2B-4T
// checkpoint from NEXUS_BITNET_DIR/bitnet.nxtf and reports Prefill
// seconds/token (16-token synthetic prompt) and decode tokens/sec (16
// Step calls following Prefill). Skipped when NEXUS_BITNET_DIR is unset.
// Token ids are synthetic (deterministic, spread across the vocab) rather
// than tokenizer output — this test measures wall-clock arithmetic cost,
// not generation quality (see bitnet_equivalence_test.go for correctness).
func TestBitNetRealTiming(t *testing.T) {
	dir := os.Getenv("NEXUS_BITNET_DIR")
	if dir == "" {
		t.Skip("NEXUS_BITNET_DIR not set — skipping real-checkpoint timing test")
	}
	nxtfPath := filepath.Join(dir, "bitnet.nxtf")

	loadStart := time.Now()
	m, err := LoadBitNetModel(nxtfPath)
	if err != nil {
		t.Fatalf("LoadBitNetModel(%s): %v", nxtfPath, err)
	}
	t.Logf("load: %s (%s)", time.Since(loadStart), nxtfPath)

	const promptLen = 16
	const genLen = 16
	prompt := make([]int, promptLen)
	rng := rand.New(rand.NewSource(7))
	for i := range prompt {
		prompt[i] = rng.Intn(m.Cfg.VocabSize)
	}

	dec := NewBitNetDecoder(m)

	prefillStart := time.Now()
	logits := dec.Prefill(prompt)
	prefillElapsed := time.Since(prefillStart)
	prefillPerToken := prefillElapsed.Seconds() / float64(promptLen)
	t.Logf("prefill: %d tokens in %s (%.4f s/token)", promptLen, prefillElapsed, prefillPerToken)

	decodeStart := time.Now()
	for i := 0; i < genLen; i++ {
		best := argmaxFloat32(logits)
		if dec.Len() >= m.Cfg.MaxSeqLen {
			t.Fatalf("hit MaxSeqLen after %d/%d decode steps", i, genLen)
		}
		logits = dec.Step(best)
	}
	decodeElapsed := time.Since(decodeStart)
	decodeTokPerSec := float64(genLen) / decodeElapsed.Seconds()
	t.Logf("decode: %d tokens in %s (%.3f tok/s)", genLen, decodeElapsed, decodeTokPerSec)
}
