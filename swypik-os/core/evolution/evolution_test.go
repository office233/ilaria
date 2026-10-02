package evolution

import (
	"math"
	"testing"
)

func TestEvolutionEngine(t *testing.T) {
	engine := NewEngine()

	// 1. Verify default kernel
	ver, lat, mutants, err := engine.GetKernelStatus("vector_normalize")
	if err != nil {
		t.Fatalf("Expected vector_normalize kernel registered, got err: %v", err)
	}
	if ver != "baseline_v1" || lat <= 0 || mutants != 0 {
		t.Errorf("Unexpected baseline status: ver=%s, lat=%d, mutants=%d", ver, lat, mutants)
	}

	// 2. Spawn Loop Unroll Mutant
	mUnroll, err := engine.SpawnMutant("vector_normalize", MutUnrollLoop)
	if err != nil {
		t.Fatalf("Failed to spawn loop unroll mutant: %v", err)
	}

	// 3. Spawn Branchless Select Mutant
	mBranchless, err := engine.SpawnMutant("vector_normalize", MutBranchlessSelect)
	if err != nil {
		t.Fatalf("Failed to spawn branchless mutant: %v", err)
	}

	if mUnroll.ID == "" || mBranchless.ID == "" {
		t.Errorf("Mutant IDs must not be empty")
	}

	// 4. Run Darwinian Tournament with rigorous test vectors
	testVectors := [][]float64{
		{3.0, 4.0},           // Expected: [0.6, 0.8]
		{1.0, 1.0, 1.0, 1.0}, // Expected: [0.5, 0.5, 0.5, 0.5]
		{0.0, 0.0, 0.0},      // Zero vector check
		make([]float64, 512), // Large vector check
	}
	for i := range testVectors[3] {
		testVectors[3][i] = float64(i%13) + 0.5
	}

	bestMutant, err := engine.BenchmarkAndSelect("vector_normalize", testVectors)
	if err != nil {
		t.Fatalf("Tournament failed: %v", err)
	}

	// Verify correctness of mutants
	if !mUnroll.Correct {
		t.Errorf("mUnroll should be mathematically correct")
	}
	if !mBranchless.Correct {
		t.Errorf("mBranchless should be mathematically correct")
	}

	// Verify output values of unrolled mutant on 3,4 vector
	normVec := mUnroll.Fn([]float64{3.0, 4.0})
	if math.Abs(normVec[0]-0.6) > 1e-5 || math.Abs(normVec[1]-0.8) > 1e-5 {
		t.Errorf("Normalized 3,4 vector incorrect: %v", normVec)
	}

	t.Logf("Darwinian Tournament Winner: %v, Speedup: %.2fx", bestMutant != nil, mUnroll.Speedup)
}
