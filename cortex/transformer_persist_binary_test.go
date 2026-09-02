package cortex

import (
	"math/rand"
	"path/filepath"
	"testing"
)

// TestBinaryPersist_Roundtrip: SaveBinary → LoadMiniTransformer must be
// byte-exact for every tensor and preserve the config. Magic-sniffing
// dispatch is exercised implicitly (same entry point as v1 JSON).
func TestBinaryPersist_Roundtrip(t *testing.T) {
	cfg := TransformerConfig{
		VocabSize: 97, EmbedDim: 24, NumHeads: 3,
		NumLayers: 2, FFNDim: 48, MaxSeqLen: 20, EOSTokenID: 5,
	}
	m := NewMiniTransformer(cfg, rand.New(rand.NewSource(3)))

	path := filepath.Join(t.TempDir(), "model.nxtf")
	if err := m.SaveBinary(path); err != nil {
		t.Fatalf("save: %v", err)
	}

	back, err := LoadMiniTransformer(path, rand.New(rand.NewSource(4)))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if back == nil {
		t.Fatal("load returned nil for existing file")
	}
	if back.Config != cfg {
		t.Fatalf("config mismatch: %+v vs %+v", back.Config, cfg)
	}

	orig := m.weightTensors()
	got := back.weightTensors()
	if len(orig) != len(got) {
		t.Fatalf("tensor count %d vs %d", len(got), len(orig))
	}
	for i := range orig {
		a, b := orig[i], got[i]
		if len(a.Data) != len(b.Data) {
			t.Fatalf("tensor %d: length %d vs %d", i, len(b.Data), len(a.Data))
		}
		for j := range a.Data {
			if a.Data[j] != b.Data[j] {
				t.Fatalf("tensor %d differs at %d: %v vs %v", i, j, b.Data[j], a.Data[j])
			}
		}
	}

	// The reloaded model must actually run.
	out := back.GenerateFast([]int{1, 2, 3}, 4, 1.0, 10)
	if len(out) <= 3 {
		t.Fatal("reloaded model failed to generate")
	}
}

// TestBinaryPersist_V1StillLoads: adding v2 must not break loading the
// original gzip-JSON format through the same entry point.
func TestBinaryPersist_V1StillLoads(t *testing.T) {
	cfg := TransformerConfig{
		VocabSize: 50, EmbedDim: 16, NumHeads: 2,
		NumLayers: 1, FFNDim: 32, MaxSeqLen: 16, EOSTokenID: 3,
	}
	m := NewMiniTransformer(cfg, rand.New(rand.NewSource(8)))
	path := filepath.Join(t.TempDir(), "model_v1.nxtf")
	if err := m.Save(path); err != nil {
		t.Fatalf("v1 save: %v", err)
	}
	back, err := LoadMiniTransformer(path, rand.New(rand.NewSource(9)))
	if err != nil {
		t.Fatalf("v1 load: %v", err)
	}
	if back == nil || back.Config != cfg {
		t.Fatal("v1 roundtrip failed after v2 introduction")
	}
}
