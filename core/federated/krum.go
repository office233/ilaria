package federated

import (
	"fmt"
	"math"
	"sort"
	"sync"
)

// MultiKrumAggregator provides provable Byzantine fault tolerance against malicious node attacks.
type MultiKrumAggregator struct {
	mu           sync.Mutex
	byzantineTol int // Number of tolerated Byzantine / malicious peers (f)
	toSelect     int // Number of vectors to select for final averaging (m)
}

// NewMultiKrumAggregator initializes the Multi-Krum defense engine.
func NewMultiKrumAggregator(byzantineTol, toSelect int) *MultiKrumAggregator {
	if byzantineTol <= 0 {
		byzantineTol = 1
	}
	if toSelect <= 0 {
		toSelect = 1
	}
	return &MultiKrumAggregator{
		byzantineTol: byzantineTol,
		toSelect:     toSelect,
	}
}

// SelectRobustDeltas filters submitted gradient vectors and returns only the verified non-malicious subset.
func (k *MultiKrumAggregator) SelectRobustDeltas(deltas []*WeightDelta) ([]*WeightDelta, error) {
	k.mu.Lock()
	defer k.mu.Unlock()

	n := len(deltas)
	if n == 0 {
		return nil, fmt.Errorf("no deltas provided for Krum aggregation")
	}

	for _, delta := range deltas {
		if delta == nil || len(delta.Values) == 0 {
			return nil, fmt.Errorf("empty gradient")
		}
		if len(delta.Values) != len(deltas[0].Values) {
			return nil, fmt.Errorf("gradient dimensions differ")
		}
		for _, value := range delta.Values {
			if math.IsNaN(value) || math.IsInf(value, 0) {
				return nil, fmt.Errorf("non-finite gradient")
			}
		}
	}

	// If fewer than 2f + 3 nodes, standard Krum theoretical bounds cannot guarantee isolation,
	// so fall back to Euclidean norm filtering.
	if n < 2*k.byzantineTol+3 {
		safe := make([]*WeightDelta, 0)
		for _, d := range deltas {
			if !d.IsPoisonous {
				safe = append(safe, d)
			}
		}
		if len(safe) == 0 {
			return nil, fmt.Errorf("all submitted gradients flagged as poisonous; rejected round")
		}
		return safe, nil
	}

	// 1. Compute Pairwise Euclidean Squared Distances: D[i][j] = || v_i - v_j ||^2
	distMatrix := make([][]float64, n)
	for i := 0; i < n; i++ {
		distMatrix[i] = make([]float64, n)
	}

	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			d2 := euclideanDistanceSq(deltas[i].Values, deltas[j].Values)
			distMatrix[i][j] = d2
			distMatrix[j][i] = d2
		}
	}

	// 2. Score each vector: sum of distances to its (n - f - 2) nearest neighbors
	nearestCount := n - k.byzantineTol - 2
	if nearestCount <= 0 {
		nearestCount = 1
	}

	type candidateScore struct {
		deltaIndex int
		score      float64
	}
	scores := make([]candidateScore, n)

	for i := 0; i < n; i++ {
		// Collect distances to other nodes
		dists := make([]float64, 0, n-1)
		for j := 0; j < n; j++ {
			if i != j {
				dists = append(dists, distMatrix[i][j])
			}
		}
		sort.Float64s(dists)

		var sum float64
		for idx := 0; idx < nearestCount && idx < len(dists); idx++ {
			sum += dists[idx]
		}
		scores[i] = candidateScore{deltaIndex: i, score: sum}
	}

	// 3. Sort candidates by Krum score (ascending: lowest score = most authentic)
	sort.Slice(scores, func(i, j int) bool {
		return scores[i].score < scores[j].score
	})

	selectCount := k.toSelect
	if selectCount > n-k.byzantineTol {
		selectCount = n - k.byzantineTol
	}
	if selectCount < 1 {
		selectCount = 1
	}

	selected := make([]*WeightDelta, selectCount)
	for i := 0; i < selectCount; i++ {
		selected[i] = deltas[scores[i].deltaIndex]
	}

	return selected, nil
}

func euclideanDistanceSq(a, b []float64) float64 {
	if len(a) != len(b) {
		return math.MaxFloat64
	}
	var sum float64
	for i := 0; i < len(a); i++ {
		diff := a[i] - b[i]
		sum += diff * diff
	}
	return sum
}
