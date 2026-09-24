//go:build gpu

package cortex

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestBitNetGPUTiming loads the real microsoft/bitnet-b1.58-2B-4T
// checkpoint (same NEXUS_BITNET_DIR convention as TestBitNetEquivalence
// in bitnet_equivalence_test.go: an absolute path to a directory
// containing bitnet.nxtf), enables the GPU BitLinear backend, and times
// a 16-token prefill followed by 32 greedily-generated tokens, printing
// tok/s — the timing half of the GPU BitLinear task's gate (the
// correctness half is TestBitLinearGPUMatchesCPU and
// TestMatMulInt8NTTinyAgainstReference). The generation loop mirrors
// cmd/bitnet-run's own Prefill/Step structure so the printed rate is
// directly comparable to that CLI's "-gpu" run. Skipped unless
// NEXUS_BITNET_DIR is set, bitnet.nxtf exists under it, and a CUDA
// device/driver is present.
func TestBitNetGPUTiming(t *testing.T) {
	dir := os.Getenv("NEXUS_BITNET_DIR")
	if dir == "" {
		t.Skip("NEXUS_BITNET_DIR not set — skipping GPU timing test")
	}
	nxtfPath := filepath.Join(dir, "bitnet.nxtf")
	if _, err := os.Stat(nxtfPath); err != nil {
		t.Skipf("%s not found: %v", nxtfPath, err)
	}

	loadStart := time.Now()
	m, err := LoadBitNetModel(nxtfPath)
	if err != nil {
		t.Fatalf("LoadBitNetModel(%s): %v", nxtfPath, err)
	}
	t.Logf("load: %s (vocab=%d layers=%d embed=%d)", time.Since(loadStart), m.Cfg.VocabSize, m.Cfg.NumLayers, m.Cfg.EmbedDim)

	gpuStart := time.Now()
	if err := EnableBitNetGPU(m); err != nil {
		t.Skipf("EnableBitNetGPU: %v (no CUDA device/driver?)", err)
	}
	defer DisableBitNetGPU(m)
	t.Logf("gpu upload: %s", time.Since(gpuStart))

	const promptLen, genLen = 16, 32
	ids := make([]int, promptLen)
	for i := range ids {
		ids[i] = (i*97 + 1) % m.Cfg.VocabSize // deterministic synthetic prompt, no tokenizer needed
	}

	dec := NewBitNetDecoder(m)
	prefillStart := time.Now()
	logits := dec.Prefill(ids)
	prefillElapsed := time.Since(prefillStart)

	seq := make([]int, len(ids))
	copy(seq, ids)
	next := argmaxRow(logits)

	genStart := time.Now()
	generated := 0
	for i := 0; i < genLen; i++ {
		seq = append(seq, next)
		generated++
		if i == genLen-1 || dec.Len() >= m.Cfg.MaxSeqLen {
			break
		}
		logits = dec.Step(next)
		next = argmaxRow(logits)
	}
	genElapsed := time.Since(genStart)

	rate := float64(generated) / genElapsed.Seconds()
	t.Logf("GPU: prefill %d tokens in %s | generated %d tokens in %s (%.2f tok/s)",
		promptLen, prefillElapsed, generated, genElapsed, rate)
}
