package federated

import (
	"fmt"
	"math"
	"sync"
)

// HeterogeneousHardwareProfile holds VRAM and compute capacity for an Exo cluster node.
type HeterogeneousHardwareProfile struct {
	NodeID   string  `json:"node_id"`
	GPUModel string  `json:"gpu_model"`
	VRAMMB   int     `json:"vram_mb"`
	TFLOPS   float64 `json:"tflops"`
}

// ModelPartitionAssignment details the slice of layers and batch size assigned to a worker.
type ModelPartitionAssignment struct {
	NodeID          string   `json:"node_id"`
	AssignedLayers  []string `json:"assigned_layers"`
	LocalBatchSize  int      `json:"local_batch_size"`
	CapacityWeight  float64  `json:"capacity_weight"`
	MaxVRAMBudgetMB int      `json:"max_vram_budget_mb"`
}

// ExoPartitioner clusters heterogeneous GPUs (RTX 1660 Ti 6GB, RTX 4090 24GB, Apple Silicon)
// and partitions model shards and batch sizes proportionally.
type ExoPartitioner struct {
	mu sync.RWMutex
}

// NewExoPartitioner initializes the dynamic hardware partitioner.
func NewExoPartitioner() *ExoPartitioner {
	return &ExoPartitioner{}
}

// PartitionModel determines optimal layer and batch allocation across participating hardware.
func (ep *ExoPartitioner) PartitionModel(
	totalLayers []string,
	baseGlobalBatch int,
	nodes []HeterogeneousHardwareProfile,
) ([]*ModelPartitionAssignment, error) {
	ep.mu.RLock()
	defer ep.mu.RUnlock()

	if len(nodes) == 0 {
		return nil, fmt.Errorf("no nodes available for Exo partitioning")
	}

	totalVRAM := 0
	for _, n := range nodes {
		vram := n.VRAMMB
		if vram <= 0 {
			vram = 2048 // 2GB minimum fallback
		}
		totalVRAM += vram
	}

	assignments := make([]*ModelPartitionAssignment, 0, len(nodes))
	layerCount := len(totalLayers)
	assignedLayerIndex := 0

	for i, n := range nodes {
		vram := n.VRAMMB
		if vram <= 0 {
			vram = 2048
		}
		ratio := float64(vram) / float64(totalVRAM)

		// Calculate batch size proportional to VRAM
		nodeBatch := int(math.Round(float64(baseGlobalBatch) * ratio))
		if nodeBatch < 1 {
			nodeBatch = 1
		}

		// Calculate number of layers assigned to this node
		var numLayers int
		if i == len(nodes)-1 {
			numLayers = layerCount - assignedLayerIndex // Last node takes remainder
			if numLayers < 0 {
				numLayers = 0
			}
		} else {
			numLayers = int(math.Round(float64(layerCount) * ratio))
			if numLayers < 1 && layerCount > assignedLayerIndex {
				numLayers = 1
			}
		}

		endIdx := assignedLayerIndex + numLayers
		if endIdx > layerCount {
			endIdx = layerCount
		}
		if endIdx < assignedLayerIndex {
			endIdx = assignedLayerIndex
		}

		var layers []string
		if assignedLayerIndex < endIdx {
			layers = totalLayers[assignedLayerIndex:endIdx]
			assignedLayerIndex = endIdx
		}

		assignments = append(assignments, &ModelPartitionAssignment{
			NodeID:          n.NodeID,
			AssignedLayers:  layers,
			LocalBatchSize:  nodeBatch,
			CapacityWeight:  math.Round(ratio*1000) / 1000,
			MaxVRAMBudgetMB: int(float64(vram) * 0.85), // 85% safety ceiling
		})
	}

	return assignments, nil
}
