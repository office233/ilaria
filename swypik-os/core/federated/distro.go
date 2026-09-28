package federated

import (
	"math"
	"sort"
	"sync"
)

// CompressedGradient represents a sparse, quantized gradient packet transmitting over residential internet.
type CompressedGradient struct {
	OriginalDim      int     `json:"original_dim"`
	TopKIndices      []int32 `json:"top_k_indices"`
	Signs            []int8  `json:"signs"` // +1 or -1 for top magnitude components
	MeanMagnitude    float64 `json:"mean_magnitude"`
	CompressionRatio float64 `json:"compression_ratio"` // e.g. 1000.0x - 10000.0x
}

// DeMoCompressor implements Nous Research's Decoupled Momentum Optimization (DisTrO).
// It enables GPU training across normal domestic internet connections by decoupling
// and compressing momentum updates by up to 10,000x.
type DeMoCompressor struct {
	mu            sync.Mutex
	sparsityRatio float64 // Fraction of parameters retained (e.g. 0.001 = 99.9% sparse = 1000x compression)
	residuals     map[string][]float64
}

// NewDeMoCompressor creates a DisTrO compressor with target sparsity ratio.
func NewDeMoCompressor(sparsityRatio float64) *DeMoCompressor {
	if sparsityRatio <= 0 || sparsityRatio > 1.0 {
		sparsityRatio = 0.002 // 0.2% retention => 500x - 1000x compression
	}
	return &DeMoCompressor{
		sparsityRatio: sparsityRatio,
		residuals:     make(map[string][]float64),
	}
}

// Compress takes a dense gradient or weight delta, adds accumulated residuals,
// and extracts only the top-k most critical updates.
func (c *DeMoCompressor) Compress(layerName string, values []float64) *CompressedGradient {
	c.mu.Lock()
	defer c.mu.Unlock()

	n := len(values)
	if n == 0 {
		return &CompressedGradient{CompressionRatio: 1.0}
	}

	// Add residual from previous compression step if exists
	effective := make([]float64, n)
	res, hasRes := c.residuals[layerName]
	for i := 0; i < n; i++ {
		effective[i] = values[i]
		if hasRes && i < len(res) {
			effective[i] += res[i]
		}
	}

	// Determine top-k count
	k := int(float64(n) * c.sparsityRatio)
	if k < 1 {
		k = 1
	}
	if k > n {
		k = n
	}

	// Sort indices by absolute magnitude
	type idxMag struct {
		idx int
		mag float64
	}
	entries := make([]idxMag, n)
	for i := 0; i < n; i++ {
		entries[i] = idxMag{idx: i, mag: math.Abs(effective[i])}
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].mag > entries[j].mag
	})

	topKIndices := make([]int32, k)
	signs := make([]int8, k)
	var sumMag float64

	newResidual := make([]float64, n)
	copy(newResidual, effective)

	for i := 0; i < k; i++ {
		idx := entries[i].idx
		val := effective[idx]
		topKIndices[i] = int32(idx)
		if val >= 0 {
			signs[i] = 1
		} else {
			signs[i] = -1
		}
		sumMag += math.Abs(val)
		newResidual[idx] = 0 // Reset residual for transmitted coordinates
	}

	c.residuals[layerName] = newResidual
	meanMag := sumMag / float64(k)
	ratio := float64(n) / float64(k)

	return &CompressedGradient{
		OriginalDim:      n,
		TopKIndices:      topKIndices,
		Signs:            signs,
		MeanMagnitude:    meanMag,
		CompressionRatio: math.Round(ratio*10) / 10,
	}
}

// Decompress unpacks a compressed DisTrO gradient back into a dense parameter vector.
func (c *DeMoCompressor) Decompress(cg *CompressedGradient) []float64 {
	dense := make([]float64, cg.OriginalDim)
	for i, idx := range cg.TopKIndices {
		if int(idx) < cg.OriginalDim {
			dense[idx] = float64(cg.Signs[i]) * cg.MeanMagnitude
		}
	}
	return dense
}
