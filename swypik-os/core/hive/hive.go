package hive

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"swypik-os/core/evidence"
	resourcepolicy "swypik-os/core/resource"
)

// ErrNoTransport reports that this build has no peer transport (no QUIC, no
// node identity, no discovery), so offloaded work is routed but never runs.
var ErrNoTransport = errors.New("hive: no mesh transport in this build; task was not executed")

// MeshNodeRole designates the node's functional profile within the Hive Mind.
type MeshNodeRole string

const (
	RoleRobotEdge          MeshNodeRole = "ROBOT_EDGE"
	RoleVehicleCompute     MeshNodeRole = "VEHICLE_COMPUTE"
	RoleWorkstationPrimary MeshNodeRole = "WORKSTATION_PRIMARY"
	RoleSensorSatellite    MeshNodeRole = "SENSOR_SATELLITE"
)

// MeshNode is a peer record as registered locally. Its figures are declared by
// whoever registered it; nothing here has contacted or measured the peer.
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
	ID             string         `json:"id"`
	Description    string         `json:"description"`
	ModelName      string         `json:"model_name"`
	Payload        []byte         `json:"payload"`
	Priority       int            `json:"priority"`
	AssignedNodeID string         `json:"assigned_node_id"`
	Status         string         `json:"status"`
	Result         string         `json:"result"`
	ExecutionTime  time.Duration  `json:"execution_time"`
	Evidence       evidence.Level `json:"evidence"`
}

// HiveMind keeps peer records and picks an offload target. Without a
// transport it can only make routing decisions; it cannot run remote work.
type HiveMind struct {
	mu          sync.RWMutex
	localNodeID string
	localRole   MeshNodeRole
	peers       map[string]*MeshNode
	tasks       map[string]*ComputeTask
	taskOrder   []string
	totalTasks  int64
	maxPeers    int
	maxTasks    int
}

// NewHiveMind initializes the distributed hive mind orchestrator.
func NewHiveMind(localID string, role MeshNodeRole) *HiveMind {
	if localID == "" {
		localID = "swypik_node_local"
	}
	policy := resourcepolicy.Default()
	return &HiveMind{
		localNodeID: localID,
		localRole:   role,
		peers:       make(map[string]*MeshNode, min(policy.MaxResidentPeers, 64)),
		tasks:       make(map[string]*ComputeTask, min(policy.MaxHiveTasks, 64)),
		taskOrder:   make([]string, 0, policy.MaxHiveTasks),
		maxPeers:    policy.MaxResidentPeers,
		maxTasks:    policy.MaxHiveTasks,
	}
}

func (h *HiveMind) RegisterPeer(peer *MeshNode) {
	if peer == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, exists := h.peers[peer.ID]; !exists && len(h.peers) >= h.maxPeers {
		oldestID := ""
		var oldest time.Time
		for id, candidate := range h.peers {
			if oldestID == "" || candidate.LastSeen.Before(oldest) {
				oldestID, oldest = id, candidate.LastSeen
			}
		}
		if oldestID != "" {
			delete(h.peers, oldestID)
		}
	}
	peer.LastSeen = time.Now()
	cp := *peer
	h.peers[peer.ID] = &cp
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

// OffloadTask records which peer would receive the task, then returns the
// task together with ErrNoTransport: no bytes were sent and no inference ran.
func (h *HiveMind) OffloadTask(ctx context.Context, task *ComputeTask) (*ComputeTask, error) {
	if task == nil {
		return nil, fmt.Errorf("task cannot be nil")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	peer, err := h.SelectBestOffloadNode()
	if err != nil {
		return nil, err
	}

	h.mu.Lock()
	task.AssignedNodeID = peer.ID
	task.Status = "NOT_EXECUTED"
	task.Evidence = evidence.Simulated
	task.Result = fmt.Sprintf("Routed to %s [%s] on paper only; no transport exists, so nothing was sent and no inference ran.", peer.Name, peer.Role)
	h.totalTasks++
	if _, exists := h.tasks[task.ID]; !exists {
		if len(h.taskOrder) >= h.maxTasks {
			oldest := h.taskOrder[0]
			delete(h.tasks, oldest)
			copy(h.taskOrder, h.taskOrder[1:])
			h.taskOrder = h.taskOrder[:len(h.taskOrder)-1]
		}
		h.taskOrder = append(h.taskOrder, task.ID)
	}
	// Keep resident task history metadata-only. Payloads may be model inputs,
	// frames or activation shards and can be very large; retaining them after
	// routing would let background history dominate RAM on edge devices.
	stored := *task
	stored.Payload = nil
	h.tasks[task.ID] = &stored
	h.mu.Unlock()

	return task, ErrNoTransport
}

// GetMeshStatus reports the local peer registry. Peers are counted when their
// record is fresh, not when they were reached; no health is claimed.
func (h *HiveMind) GetMeshStatus() map[string]interface{} {
	h.mu.RLock()
	defer h.mu.RUnlock()

	registeredPeers := 0
	declaredTFLOPS := 0.0

	for _, p := range h.peers {
		if time.Since(p.LastSeen) <= 30*time.Second {
			registeredPeers++
			declaredTFLOPS += p.TFLOPS
		}
	}

	return map[string]interface{}{
		"local_id":         h.localNodeID,
		"local_role":       h.localRole,
		"registered_peers": registeredPeers,
		"declared_tflops":  declaredTFLOPS,
		"routed_tasks":     h.totalTasks,
		"executed_tasks":   0,
		"transport":        "none",
		"mesh_health":      "UNVERIFIED",
	}
}
