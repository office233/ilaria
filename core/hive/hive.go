package hive

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
)

// MeshNodeRole designates the node's functional profile within the Hive Mind.
type MeshNodeRole string

const (
	RoleRobotEdge          MeshNodeRole = "ROBOT_EDGE"
	RoleVehicleCompute     MeshNodeRole = "VEHICLE_COMPUTE"
	RoleWorkstationPrimary MeshNodeRole = "WORKSTATION_PRIMARY"
	RoleSensorSatellite    MeshNodeRole = "SENSOR_SATELLITE"
)

// MeshNode represents a peer SwypikOS node participating in the distributed neural mesh.
type MeshNode struct {
	ID             string       `json:"id"`
	Name           string       `json:"name"`
	Role           MeshNodeRole `json:"role"`
	Endpoint       string       `json:"endpoint"`
	TFLOPS         float64      `json:"tflops"`
	BatteryPercent float64      `json:"battery_percent"`
	CurrentLoad    float64      `json:"current_load"` // 0.0 - 1.0
	LatencyMs      int64        `json:"latency_ms"`
	LastSeen       time.Time    `json:"last_seen"`
}

// ComputeTask represents an offloaded neural inference or computer vision workload.
type ComputeTask struct {
	ID             string        `json:"id"`
	Description    string        `json:"description"`
	ModelName      string        `json:"model_name"`
	Payload        []byte        `json:"payload"`
	Priority       int           `json:"priority"`
	AssignedNodeID string        `json:"assigned_node_id"`
	Status         string        `json:"status"`
	Result         string        `json:"result"`
	ExecutionTime  time.Duration `json:"execution_time"`
}

// HiveMind coordinates peer-to-peer compute sharing across cars, robots, workstations, and appliances.
type HiveMind struct {
	mu           sync.RWMutex
	localNodeID  string
	localRole    MeshNodeRole
	peers        map[string]*MeshNode
	tasks        map[string]*ComputeTask
	totalTasks   int64
	offloadedOps int64
}

// NewHiveMind initializes the distributed hive mind orchestrator.
func NewHiveMind(localID string, role MeshNodeRole) *HiveMind {
	if localID == "" {
		localID = "swypik_node_local"
	}
	return &HiveMind{
		localNodeID: localID,
		localRole:   role,
		peers:       make(map[string]*MeshNode),
		tasks:       make(map[string]*ComputeTask),
	}
}

func (h *HiveMind) RegisterPeer(peer *MeshNode) {
	if peer == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	peer.LastSeen = time.Now()
	h.peers[peer.ID] = peer
}

// SelectBestOffloadNode selects the peer with the highest available compute power and lowest thermal/battery penalty.
func (h *HiveMind) SelectBestOffloadNode() (*MeshNode, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	var best *MeshNode
	bestScore := -1.0

	for _, p := range h.peers {
		// Filter out nodes with low battery or stale connections
		if p.BatteryPercent < 20.0 || time.Since(p.LastSeen) > 30*time.Second {
			continue
		}

		// Compute score = TFLOPS * (1.0 - CurrentLoad) * (Battery / 100) / (Latency + 1)
		availableCompute := p.TFLOPS * (1.0 - p.CurrentLoad)
		score := availableCompute * (p.BatteryPercent / 100.0) / float64(p.LatencyMs+1)

		if score > bestScore {
			bestScore = score
			best = p
		}
	}

	if best == nil {
		return nil, fmt.Errorf("no eligible compute peers available in mesh")
	}

	return best, nil
}

func (h *HiveMind) OffloadTask(ctx context.Context, task *ComputeTask) (*ComputeTask, error) {
	if task == nil {
		return nil, fmt.Errorf("task cannot be nil")
	}
	start := time.Now()

	peer, err := h.SelectBestOffloadNode()
	if err != nil {
		return nil, err
	}

	h.mu.Lock()
	task.AssignedNodeID = peer.ID
	task.Status = "RUNNING"
	h.tasks[task.ID] = task
	if len(h.tasks) > 500 {
		keys := make([]string, 0, len(h.tasks))
		for k := range h.tasks {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			delete(h.tasks, k)
			if len(h.tasks) <= 500 {
				break
			}
		}
	}
	h.mu.Unlock()

	// In real network: gRPC / QUIC P2P stream.
	// Here: Deterministic simulated neural processing latency
	select {
	case <-time.After(10 * time.Millisecond):
		task.Result = fmt.Sprintf("Inference completed by %s [%s]: Tensor outputs synthesized with zero latency penalty.", peer.Name, peer.Role)
		task.Status = "COMPLETED"
		task.ExecutionTime = time.Since(start)
	case <-ctx.Done():
		task.Status = "TIMEOUT"
		return nil, ctx.Err()
	}

	h.mu.Lock()
	h.totalTasks++
	h.offloadedOps++
	h.mu.Unlock()

	return task, nil
}

// GetMeshStatus returns live network topology metrics for UI display.
func (h *HiveMind) GetMeshStatus() map[string]interface{} {
	h.mu.RLock()
	defer h.mu.RUnlock()

	activePeers := 0
	totalTFLOPS := 0.0

	for _, p := range h.peers {
		if time.Since(p.LastSeen) <= 30*time.Second {
			activePeers++
			totalTFLOPS += p.TFLOPS
		}
	}

	return map[string]interface{}{
		"local_id":       h.localNodeID,
		"local_role":     h.localRole,
		"active_peers":   activePeers,
		"total_tflops":   totalTFLOPS,
		"offloaded_ops":  h.offloadedOps,
		"mesh_health":    "OPTIMAL",
	}
}
