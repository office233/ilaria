package cortex

import (
	"nexus-cortex/cortex/compute"
	"testing"
)

func TestFractalCortexNeurogenesis(t *testing.T) {
	cfg := fractalTestConfig(t)
	engine := compute.NewCPUEngine()
	fc := NewFractalCortex(cfg, engine)

	if len(fc.Blocks) != 1 {
		t.Fatalf("expected 1 block initially, got %d", len(fc.Blocks))
	}

	// Trigger high error to spawn new block
	fc.CheckPredictionError(0.9)

	if len(fc.Blocks) != 2 {
		t.Fatalf("expected 2 blocks after neurogenesis, got %d", len(fc.Blocks))
	}

	// Lock should prevent immediate spawn
	fc.CheckPredictionError(0.9)
	if len(fc.Blocks) != 2 {
		t.Fatalf("expected lock to prevent spawn, got %d blocks", len(fc.Blocks))
	}

	// Test ProcessToken routing
	sdr := NewSDR(cfg.SDRSize)
	// Active a few bits
	for i := 0; i < 200; i++ {
		sdr.Bits[i/64] |= 1 << uint(i%64)
	}
	sdr.ActiveCount = 200

	outSDR := fc.ProcessToken(sdr)
	if outSDR.ActiveCount == 0 {
		t.Errorf("expected active bits from ProcessToken, got 0")
	}
}

func TestFractalCortexQuantumRouterCreation(t *testing.T) {
	engine := compute.NewCPUEngine()

	// Disabled: no QRouter should be created
	cfg := fractalTestConfig(t)
	cfg.EnableQuantumInspired = false
	fc := NewFractalCortex(cfg, engine)
	if fc.QRouter != nil {
		t.Error("expected QRouter to be nil when EnableQuantumInspired=false")
	}
	if fc.Journal != nil {
		t.Error("expected Journal to be nil when EnableQuantumInspired=false")
	}

	// Enabled: QRouter and Journal should be created
	cfg.EnableQuantumInspired = true
	fc = NewFractalCortex(cfg, engine)
	if fc.QRouter == nil {
		t.Fatal("expected QRouter to be non-nil when EnableQuantumInspired=true")
	}
	if fc.Journal == nil {
		t.Fatal("expected Journal to be non-nil when EnableQuantumInspired=true")
	}
	if fc.QRouter.TopK != cfg.FractalTopK {
		t.Errorf("expected QRouter.TopK=%d (from Config.FractalTopK), got %d", cfg.FractalTopK, fc.QRouter.TopK)
	}
	if fc.QRouter.SDRSize != cfg.SDRSize {
		t.Errorf("expected QRouter.SDRSize=%d, got %d", cfg.SDRSize, fc.QRouter.SDRSize)
	}
}

func TestFractalCortexQuantumRouting(t *testing.T) {
	cfg := fractalTestConfig(t)
	cfg.EnableQuantumInspired = true
	engine := compute.NewCPUEngine()
	fc := NewFractalCortex(cfg, engine)

	// Spawn enough blocks to trigger quantum routing (need > TopK=2)
	for len(fc.Blocks) <= fc.QRouter.TopK {
		fc.GrowthLock = false
		fc.SpawnNeurogenesis()
	}

	// Create a test SDR
	sdr := NewSDR(cfg.SDRSize)
	for i := 0; i < 50; i++ {
		sdr.Set(i * 3)
	}

	// ProcessToken should use quantum routing path (no panic, produces output)
	outSDR := fc.ProcessToken(sdr)
	if outSDR.Size != cfg.SDRSize {
		t.Errorf("expected output SDR size %d, got %d", cfg.SDRSize, outSDR.Size)
	}
}

func TestFractalCortexBackwardCompatibility(t *testing.T) {
	cfg := fractalTestConfig(t)
	cfg.EnableQuantumInspired = false
	engine := compute.NewCPUEngine()
	fc := NewFractalCortex(cfg, engine)

	// Spawn multiple blocks
	fc.GrowthLock = false
	fc.SpawnNeurogenesis()

	// Create a test SDR
	sdr := NewSDR(cfg.SDRSize)
	for i := 0; i < 50; i++ {
		sdr.Set(i * 7)
	}

	// Should use the classical all-block voting path (no QRouter)
	outSDR := fc.ProcessToken(sdr)
	if outSDR.Size != cfg.SDRSize {
		t.Errorf("expected output SDR size %d, got %d", cfg.SDRSize, outSDR.Size)
	}
}

func TestFractalCortexMergeJournal(t *testing.T) {
	cfg := fractalTestConfig(t)
	cfg.EnableQuantumInspired = true
	engine := compute.NewCPUEngine()
	fc := NewFractalCortex(cfg, engine)

	if fc.Journal == nil {
		t.Fatal("expected Journal to be non-nil")
	}

	// Record a plasticity entry that targets block 0's feature layer
	if len(fc.Blocks) == 0 {
		t.Fatal("expected at least 1 block")
	}
	block := fc.Blocks[0]
	if len(block.SharedFeatureLayer.Tiles) == 0 {
		t.Fatal("expected tiles in feature layer")
	}

	oldTile := block.SharedFeatureLayer.Tiles[0]
	newTile := TernaryTile(uint32(oldTile) ^ 0xFF)

	fc.Journal.Record(PlasticityEntry{
		ExpertID:  0,
		LayerName: "feature",
		TileIndex: 0,
		OldTile:   oldTile,
		NewTile:   newTile,
		Reason:    "test",
	})

	if fc.Journal.Size() != 1 {
		t.Fatalf("expected 1 journal entry, got %d", fc.Journal.Size())
	}

	applied := fc.MergeJournal()
	if applied != 1 {
		t.Errorf("expected 1 change applied, got %d", applied)
	}

	if block.SharedFeatureLayer.Tiles[0] != newTile {
		t.Error("expected tile to be updated after merge")
	}

	// Journal should be cleared
	if fc.Journal.Size() != 0 {
		t.Errorf("expected journal to be cleared after merge, got %d entries", fc.Journal.Size())
	}
}

func TestFractalCortexMergeJournalNoJournal(t *testing.T) {
	cfg := fractalTestConfig(t)
	cfg.EnableQuantumInspired = false
	engine := compute.NewCPUEngine()
	fc := NewFractalCortex(cfg, engine)

	// MergeJournal with nil journal should return 0 and not panic
	applied := fc.MergeJournal()
	if applied != 0 {
		t.Errorf("expected 0 changes with nil journal, got %d", applied)
	}
}
