package evolution

import (
	"fmt"
	"math"
	"sync"
	"time"
)

// MutationKind defines the algorithmic optimization applied.
type MutationKind string

const (
	MutUnrollLoop       MutationKind = "loop_unrolling_4x"
	MutBranchlessSelect MutationKind = "branchless_ternary_select"
	MutCacheTiling      MutationKind = "cache_aligned_tiling"
	MutFastInvSqrt      MutationKind = "fast_inverse_sqrt"
)

// KernelFunc is a numerical or data-processing kernel executed by SwypikOS.
type KernelFunc func(input []float64) []float64

// Mutant represents a mutated variant of a core algorithm.
type Mutant struct {
	ID         string       `json:"id"`
	KernelName string       `json:"kernel_name"`
	Kind       MutationKind `json:"kind"`
	Fn         KernelFunc   `json:"-"`
	LatencyNs  int64        `json:"latency_ns"`
	Correct    bool         `json:"correct"`
	Speedup    float64      `json:"speedup"`
}

// KernelEntry holds the active baseline kernel and its evolutionary lineage.
type KernelEntry struct {
	Name          string     `json:"name"`
	ActiveKernel  KernelFunc `json:"-"`
	BaselineNs    int64      `json:"baseline_ns"`
	Mutants       []*Mutant  `json:"mutants"`
	ActiveVersion string     `json:"active_version"`
}

// Engine coordinates Darwinian algorithmic evolution across the OS.
type Engine struct {
	mu      sync.RWMutex
	kernels map[string]*KernelEntry
}

// NewEngine initializes the autonomous Darwinian evolution system.
func NewEngine() *Engine {
	e := &Engine{
		kernels: make(map[string]*KernelEntry),
	}
	e.seedDefaultKernels()
	return e
}

func (e *Engine) seedDefaultKernels() {
	// Baseline Vector Normalization Kernel
	baselineNorm := func(input []float64) []float64 {
		out := make([]float64, len(input))
		var sumSq float64
		for i := 0; i < len(input); i++ {
			sumSq += input[i] * input[i]
		}
		invNorm := 0.0
		if sumSq > 0 {
			invNorm = 1.0 / math.Sqrt(sumSq)
		}
		for i := 0; i < len(input); i++ {
			out[i] = input[i] * invNorm
		}
		return out
	}

	e.RegisterKernel("vector_normalize", baselineNorm)
}

// RegisterKernel registers a baseline kernel for Darwinian benchmarking and optimization.
func (e *Engine) RegisterKernel(name string, fn KernelFunc) {
	e.mu.Lock()
	defer e.mu.Unlock()

	// Initial baseline benchmark
	dummy := make([]float64, 1024)
	for i := range dummy {
		dummy[i] = float64(i%17) + 1.0
	}

	start := time.Now()
	runs := 2000
	for r := 0; r < runs; r++ {
		_ = fn(dummy)
	}
	baselineNs := time.Since(start).Nanoseconds() / int64(runs)
	if baselineNs <= 0 {
		baselineNs = 100
	}

	e.kernels[name] = &KernelEntry{
		Name:          name,
		ActiveKernel:  fn,
		BaselineNs:    baselineNs,
		Mutants:       make([]*Mutant, 0),
		ActiveVersion: "baseline_v1",
	}
}

// SpawnMutant generates an algorithmic mutation for a target kernel.
func (e *Engine) SpawnMutant(kernelName string, kind MutationKind) (*Mutant, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	entry, ok := e.kernels[kernelName]
	if !ok {
		return nil, fmt.Errorf("kernel '%s' not found in genome registry", kernelName)
	}

	var mutantFn KernelFunc
	switch kind {
	case MutUnrollLoop:
		// 4x Loop unrolling with superscalar accumulator interleaving
		mutantFn = func(input []float64) []float64 {
			n := len(input)
			out := make([]float64, n)
			var sumSq0, sumSq1, sumSq2, sumSq3 float64

			i := 0
			for ; i <= n-4; i += 4 {
				sumSq0 += input[i] * input[i]
				sumSq1 += input[i+1] * input[i+1]
				sumSq2 += input[i+2] * input[i+2]
				sumSq3 += input[i+3] * input[i+3]
			}
			sumSq := sumSq0 + sumSq1 + sumSq2 + sumSq3
			for ; i < n; i++ {
				sumSq += input[i] * input[i]
			}

			invNorm := 0.0
			if sumSq > 0 {
				invNorm = 1.0 / math.Sqrt(sumSq)
			}

			j := 0
			for ; j <= n-4; j += 4 {
				out[j] = input[j] * invNorm
				out[j+1] = input[j+1] * invNorm
				out[j+2] = input[j+2] * invNorm
				out[j+3] = input[j+3] * invNorm
			}
			for ; j < n; j++ {
				out[j] = input[j] * invNorm
			}
			return out
		}

	case MutBranchlessSelect:
		// Branchless ternary select eliminating pipeline stall penalties
		mutantFn = func(input []float64) []float64 {
			n := len(input)
			out := make([]float64, n)
			var sumSq float64
			for i := 0; i < n; i++ {
				sumSq += input[i] * input[i]
			}
			// Branchless EPS guard
			safeSum := math.Max(sumSq, 1e-18)
			invNorm := 1.0 / math.Sqrt(safeSum)
			for i := 0; i < n; i++ {
				out[i] = input[i] * invNorm
			}
			return out
		}

	default:
		return nil, fmt.Errorf("unsupported mutation kind: %s", kind)
	}

	mutantID := fmt.Sprintf("%s_mut_%s_%d", kernelName, kind, time.Now().UnixNano()%10000)
	mutant := &Mutant{
		ID:         mutantID,
		KernelName: kernelName,
		Kind:       kind,
		Fn:         mutantFn,
	}

	entry.Mutants = append(entry.Mutants, mutant)
	if len(entry.Mutants) > 20 {
		entry.Mutants = entry.Mutants[len(entry.Mutants)-20:]
	}
	return mutant, nil
}

// BenchmarkAndSelect runs a survival-of-the-fittest verification tournament.
func (e *Engine) BenchmarkAndSelect(kernelName string, testVectors [][]float64) (*Mutant, error) {
	if len(testVectors) == 0 {
		return nil, fmt.Errorf("no test vectors provided")
	}
	e.mu.Lock()
	defer e.mu.Unlock()

	entry, ok := e.kernels[kernelName]
	if !ok {
		return nil, fmt.Errorf("kernel '%s' not found", kernelName)
	}

	if len(entry.Mutants) == 0 {
		return nil, fmt.Errorf("no mutants spawned for kernel '%s'", kernelName)
	}

	var bestMutant *Mutant
	var highestSpeedup float64 = 1.0 // Must beat 1.0x (baseline)

	for _, m := range entry.Mutants {
		// 1. Correctness Gate: Output must match baseline within 1e-6 tolerance
		isCorrect := true
		for _, vec := range testVectors {
			expected := entry.ActiveKernel(vec)
			actual := m.Fn(vec)

			if len(expected) != len(actual) {
				isCorrect = false
				break
			}
			for i := range expected {
				if math.Abs(expected[i]-actual[i]) > 1e-6 {
					isCorrect = false
					break
				}
			}
			if !isCorrect {
				break
			}
		}

		m.Correct = isCorrect
		if !isCorrect {
			continue // Discard hallucinating or corrupt mutants
		}

		// 2. Performance Tournament: Measure execution latency over repeated passes
		benchmarkData := testVectors[0]
		start := time.Now()
		runs := 2000
		for r := 0; r < runs; r++ {
			_ = m.Fn(benchmarkData)
		}
		elapsed := time.Since(start).Nanoseconds() / int64(runs)
		if elapsed <= 0 {
			elapsed = 80
		}
		m.LatencyNs = elapsed

		if entry.BaselineNs > 0 && elapsed > 0 {
			m.Speedup = float64(entry.BaselineNs) / float64(elapsed)
		}

		if m.Speedup > highestSpeedup {
			highestSpeedup = m.Speedup
			bestMutant = m
		}
	}

	// Hot-swap if a genetically superior mutant was discovered
	if bestMutant != nil {
		entry.ActiveKernel = bestMutant.Fn
		entry.ActiveVersion = bestMutant.ID
		entry.BaselineNs = bestMutant.LatencyNs
	}

	return bestMutant, nil
}

// GetKernelStatus returns the current version and performance metrics for a registered kernel.
func (e *Engine) GetKernelStatus(kernelName string) (version string, latencyNs int64, mutants int, err error) {
	e.mu.RLock()
	defer e.mu.RUnlock()

	entry, ok := e.kernels[kernelName]
	if !ok {
		return "", 0, 0, fmt.Errorf("kernel not found: %s", kernelName)
	}

	return entry.ActiveVersion, entry.BaselineNs, len(entry.Mutants), nil
}
