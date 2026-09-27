package federated

import (
	"fmt"
	"math"
	"sync"
	"time"
)

// DiLoCoConfig encapsulates the hyperparameters for Distributed Low-Communication training.
type DiLoCoConfig struct {
	InnerSteps     int     `json:"inner_steps"`      // Default 500 local steps per communication round
	InnerLR        float64 `json:"inner_lr"`         // Local inner optimizer learning rate (e.g. 1e-4)
	OuterLR        float64 `json:"outer_lr"`         // Global outer optimizer learning rate (e.g. 0.7)
	OuterMomentum  float64 `json:"outer_momentum"`   // Nesterov outer momentum (e.g. 0.9)
	MinPeersActive int     `json:"min_peers_active"` // Minimum active peers required to run outer step
}

// DefaultDiLoCoConfig provides initial experimental optimizer settings.
func DefaultDiLoCoConfig() DiLoCoConfig {
	return DiLoCoConfig{
		InnerSteps:     500,
		InnerLR:        0.0001,
		OuterLR:        0.7,
		OuterMomentum:  0.9,
		MinPeersActive: 1,
	}
}

// DiLoCoWorker maintains local weights and applies trainer-provided gradients on CPU.
type DiLoCoWorker struct {
	mu           sync.RWMutex
	nodeID       string
	gpuModel     string
	vramMB       int
	tflops       float64
	cfg          DiLoCoConfig
	innerStep    int
	localWeights map[string][]float64
	initialBase  map[string][]float64
	isIdle       bool
}

// NewDiLoCoWorker initializes an autonomous on-device DiLoCo training worker.
func NewDiLoCoWorker(nodeID, gpuModel string, vramMB int, tflops float64, cfg DiLoCoConfig) *DiLoCoWorker {
	if cfg.InnerSteps <= 0 {
		cfg = DefaultDiLoCoConfig()
	}
	return &DiLoCoWorker{
		nodeID:       nodeID,
		gpuModel:     gpuModel,
		vramMB:       vramMB,
		tflops:       tflops,
		cfg:          cfg,
		innerStep:    0,
		localWeights: make(map[string][]float64),
		initialBase:  make(map[string][]float64),
		isIdle:       true,
	}
}

// SyncBaseModel initializes or resets the local weights to the consolidated checkpoint.
func (w *DiLoCoWorker) SyncBaseModel(checkpoint *ModelCheckpoint) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if checkpoint == nil {
		return
	}
	w.innerStep = 0
	w.localWeights = make(map[string][]float64)
	w.initialBase = make(map[string][]float64)

	for layer, weights := range checkpoint.Weights {
		wCopy := make([]float64, len(weights))
		bCopy := make([]float64, len(weights))
		copy(wCopy, weights)
		copy(bCopy, weights)
		w.localWeights[layer] = wCopy
		w.initialBase[layer] = bCopy
	}
}

// StepInner applies actual gradients supplied by a model trainer. A scalar
// loss cannot determine parameter gradients. This worker does not compute
// backpropagation itself and must not fabricate training progress.
func (w *DiLoCoWorker) StepInner(gradients map[string][]float64) (bool, float64, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	progress := float64(w.innerStep) / float64(w.cfg.InnerSteps)
	if len(w.localWeights) == 0 || len(gradients) != len(w.localWeights) {
		return false, progress, fmt.Errorf("gradients for every initialized layer are required")
	}
	if w.innerStep >= w.cfg.InnerSteps {
		return true, 1, fmt.Errorf("round complete; synchronize a new base before training")
	}
	if w.cfg.InnerLR <= 0 || math.IsNaN(w.cfg.InnerLR) || math.IsInf(w.cfg.InnerLR, 0) {
		return false, progress, fmt.Errorf("invalid learning rate")
	}
	// Validate the whole update first: errors leave both weights and step unchanged.
	for layer, weights := range w.localWeights {
		grad, ok := gradients[layer]
		if !ok || len(grad) != len(weights) {
			return false, progress, fmt.Errorf("gradient shape mismatch: %s", layer)
		}
		for i, g := range grad {
			next := weights[i] - w.cfg.InnerLR*g
			if math.IsNaN(g) || math.IsInf(g, 0) || math.IsNaN(next) || math.IsInf(next, 0) {
				return false, progress, fmt.Errorf("nonfinite gradient/update: %s", layer)
			}
		}
	}
	for layer, weights := range w.localWeights {
		for i, g := range gradients[layer] {
			weights[i] -= w.cfg.InnerLR * g
		}
	}
	w.innerStep++
	return w.innerStep == w.cfg.InnerSteps, float64(w.innerStep) / float64(w.cfg.InnerSteps), nil
}

// ComputeOuterPseudoGradient computes Delta = W_inner - W_initial to transmit to the outer coordinator.
func (w *DiLoCoWorker) ComputeOuterPseudoGradient(layerName string) ([]float64, error) {
	w.mu.RLock()
	defer w.mu.RUnlock()

	init, exists := w.initialBase[layerName]
	if !exists {
		return nil, fmt.Errorf("layer %s not found in base checkpoint", layerName)
	}
	current := w.localWeights[layerName]
	delta := make([]float64, len(init))

	for i := range init {
		delta[i] = current[i] - init[i]
	}

	return delta, nil
}

// ElasticDeviceMesh manages churn (computers joining, sleeping, or opening games).
type ElasticDeviceMesh struct {
	mu           sync.RWMutex
	workers      map[string]*MeshWorkerState
	maxHeartbeat time.Duration
}

// MeshWorkerState tracks the availability and churn state of a single participant node.
type MeshWorkerState struct {
	NodeID        string    `json:"node_id"`
	GPUModel      string    `json:"gpu_model"`
	VRAMMB        int       `json:"vram_mb"`
	TFLOPS        float64   `json:"tflops"`
	IsIdle        bool      `json:"is_idle"`     // true = available for training
	IsCharging    bool      `json:"is_charging"` // true = plugged into AC wall power
	LastHeartbeat time.Time `json:"last_heartbeat"`
	Status        string    `json:"status"` // "ACTIVE", "PAUSED_USER_ACTIVE", "OFFLINE"
}

// NewElasticDeviceMesh creates a fault-tolerant device mesh coordinator.
func NewElasticDeviceMesh() *ElasticDeviceMesh {
	return &ElasticDeviceMesh{
		workers:      make(map[string]*MeshWorkerState),
		maxHeartbeat: 45 * time.Second,
	}
}

// RegisterOrUpdateWorker handles incoming telemetry from a participant PC.
func (m *ElasticDeviceMesh) RegisterOrUpdateWorker(nodeID, gpu string, vram int, tflops float64, isIdle, isCharging bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	status := "ACTIVE"
	if !isIdle {
		status = "PAUSED_USER_ACTIVE"
	} else if !isCharging {
		status = "PAUSED_BATTERY_CONSERVATION"
	}

	m.workers[nodeID] = &MeshWorkerState{
		NodeID:        nodeID,
		GPUModel:      gpu,
		VRAMMB:        vram,
		TFLOPS:        tflops,
		IsIdle:        isIdle,
		IsCharging:    isCharging,
		LastHeartbeat: time.Now(),
		Status:        status,
	}
}

// GetActiveWorkers returns the set of nodes currently ready to contribute compute.
func (m *ElasticDeviceMesh) GetActiveWorkers() []*MeshWorkerState {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	active := make([]*MeshWorkerState, 0)

	for _, w := range m.workers {
		if now.Sub(w.LastHeartbeat) > m.maxHeartbeat {
			w.Status = "OFFLINE"
			continue
		}
		if w.IsIdle && w.IsCharging {
			copy := *w
			active = append(active, &copy)
		}
	}

	return active
}
