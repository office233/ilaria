package cortex

import (
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

// A forge-trained brain is dropped into the data dir as NXTF2BIN. The
// organism must write it back in the same format on Save, otherwise the
// first interactive session silently converts a 512 MB trained model into
// the legacy gzip layout that forge/nxtf.py cannot read (observed 2026-09-22
// with data/forge/brain-a).
func TestOrganismSave_KeepsTransformerAsNXTF2BIN(t *testing.T) {
	m, err := LoadMiniTransformer("../forge/fixtures/tiny_modern.nxtf", rand.New(rand.NewSource(1)))
	if err != nil {
		t.Skipf("fixture missing (%v) — run: python forge/make_fixture.py", err)
	}
	org := NewOrganism(DefaultConfig(), rand.New(rand.NewSource(1)))
	org.Transformer = m

	dir := t.TempDir()
	if err := org.Save(dir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "transformer.nxtf"))
	if err != nil {
		t.Fatalf("read saved transformer: %v", err)
	}
	if len(b) < 8 || string(b[:8]) != "NXTF2BIN" {
		t.Fatalf("saved transformer.nxtf is not NXTF2BIN (first bytes % x)", b[:min(8, len(b))])
	}
	// And it must still load — the round trip is what the organism relies on.
	if _, err := LoadMiniTransformer(filepath.Join(dir, "transformer.nxtf"), rand.New(rand.NewSource(1))); err != nil {
		t.Fatalf("reload saved transformer: %v", err)
	}
}
