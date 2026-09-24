package cortex

// ternary_pack_fixture_test.go — cross-checks Go's PackTernaryTile (the
// bit layout the BitNet NXTF v3 importer must mirror exactly) against a
// fixture produced independently by the pure-Python packer in
// forge/import_bitnet.py (pack_ternary_tile / pack_ternary_matrix).
//
// Fixture: forge/fixtures/ternary_pack_fixture.json — regenerate with:
//
//	python -c "..." (see forge/import_bitnet.py docstring), or re-run the
//	one-off script that produced it (a random 37-weight row — 37 is not a
//	multiple of 16, so this also exercises the zero-padded last tile).

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type ternaryPackFixture struct {
	InFeatures int      `json:"in_features"`
	Weights    []int8   `json:"weights"`
	Tiles      []uint32 `json:"tiles"`
	BytesHex   string   `json:"bytes_hex"`
}

// TestTernaryPackFixture packs the fixture's row with the real Go
// PackTernaryTile and checks both the per-tile uint32 values and the raw
// little-endian byte serialization against the Python-produced fixture.
func TestTernaryPackFixture(t *testing.T) {
	path := filepath.Join("..", "forge", "fixtures", "ternary_pack_fixture.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("fixture missing (%v) — run forge/import_bitnet.py's fixture generator", err)
	}
	var fx ternaryPackFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("fixture json: %v", err)
	}
	if fx.InFeatures != len(fx.Weights) {
		t.Fatalf("fixture inconsistent: in_features=%d but %d weights", fx.InFeatures, len(fx.Weights))
	}

	tilesPerRow := (fx.InFeatures + 15) / 16
	if tilesPerRow != len(fx.Tiles) {
		t.Fatalf("fixture inconsistent: expected %d tiles, fixture has %d", tilesPerRow, len(fx.Tiles))
	}

	padded := make([]int8, tilesPerRow*16)
	copy(padded, fx.Weights)

	wantBytes, err := hex.DecodeString(fx.BytesHex)
	if err != nil {
		t.Fatalf("fixture bytes_hex: %v", err)
	}
	if len(wantBytes) != tilesPerRow*4 {
		t.Fatalf("fixture bytes_hex length %d, want %d", len(wantBytes), tilesPerRow*4)
	}

	for ti := 0; ti < tilesPerRow; ti++ {
		var w [16]int8
		copy(w[:], padded[ti*16:ti*16+16])
		got := PackTernaryTile(w)

		if uint32(got) != fx.Tiles[ti] {
			t.Errorf("tile %d: PackTernaryTile=%#08x, fixture=%#08x", ti, uint32(got), fx.Tiles[ti])
		}

		gotBytes := got.RGBA32Bytes()
		wantTileBytes := wantBytes[ti*4 : ti*4+4]
		for b := 0; b < 4; b++ {
			if gotBytes[b] != wantTileBytes[b] {
				t.Fatalf("tile %d byte %d: Go=%#02x fixture=%#02x (full Go=%v fixture=%v)",
					ti, b, gotBytes[b], wantTileBytes[b], gotBytes, wantTileBytes)
			}
		}

		// Round-trip sanity: unpacking must reproduce the (unpadded) weights.
		unpacked := got.Unpack()
		for i := 0; i < 16; i++ {
			if unpacked[i] != w[i] {
				t.Fatalf("tile %d weight %d: PackTernaryTile/Unpack round-trip mismatch: got %d want %d", ti, i, unpacked[i], w[i])
			}
		}
	}
}
