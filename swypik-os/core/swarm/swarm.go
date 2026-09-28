package swarm

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"swypik-os/config"
	"swypik-os/internal/storage"
	"sync"
	"sync/atomic"
	"time"

	"swypik-os/core/federated"
	"swypik-os/core/hal"
)

type SwarmConfig struct {
	Enabled         bool    `json:"enabled"`
	TrainingEnabled bool    `json:"training_enabled"`
	SendIntervalSec int     `json:"send_interval_sec"`
	MaxCPUPercent   float64 `json:"max_cpu_percent"`
	MaxGPUPercent   float64 `json:"max_gpu_percent"`
}

type Status struct {
	Enabled        bool    `json:"enabled"`
	TasksCompleted int64   `json:"tasks_completed"`
	CoinsEarned    float64 `json:"coins_earned"`
	LocalTflops    float64 `json:"local_tflops"`
	MeshNodes      int     `json:"mesh_nodes"`
	LatencyMs      int     `json:"latency_ms"`
	RealHashRate   float64 `json:"real_hashrate_khs"`
	HasGPU         bool    `json:"has_gpu"`
	GPUModel       string  `json:"gpu_model"`
	CUDAVersion    string  `json:"cuda_version"`
	VRAMMB         int     `json:"vram_mb"`
}

type Daemon struct {
	mu              sync.RWMutex
	enabled         atomic.Bool
	trainingEnabled bool
	maxGPUPercent   float64
	tasksCompleted  int64
	coinsEarned     float64
	stopChan        chan struct{}
	stopOnce        sync.Once
	workerDone      chan struct{}
	stateDir        string
	rewardPerTflop  float64
	nodeID          string
	totalHashes     int64
	realHashRate    float64
	localTflops     float64
	hasGPU          bool
	gpuModel        string
	cudaVersion     string
	vramMB          int
	trainer         *federated.LocalTrainer
}

func NewDaemon(args ...SwarmConfig) *Daemon {
	cfg := config.Get()
	enabled := cfg.SwarmEnabled
	trainingEnabled := true
	maxGPUPercent := 35.0

	for _, override := range args {
		enabled = override.Enabled
		trainingEnabled = override.TrainingEnabled
		if override.MaxGPUPercent > 0 && override.MaxGPUPercent <= 100 {
			maxGPUPercent = override.MaxGPUPercent
		}
	}

	// Auto-detect physical hardware compute capabilities via HAL
	halMgr := hal.NewManager()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _ = halMgr.Scan(ctx)

	hasGPU, gpuModel, vram, tflops, cudaVer := halMgr.GetGPUComputeCapability()
	localTflops := 0.0
	if hasGPU && tflops > 0 {
		localTflops = tflops
	}

	d := &Daemon{
		trainingEnabled: trainingEnabled,
		maxGPUPercent:   maxGPUPercent,
		tasksCompleted:  0,
		coinsEarned:     0.0,
		stopChan:        make(chan struct{}),
		workerDone:      make(chan struct{}),
		stateDir:        config.GetString("SWYPIK_STATE_DIR", filepath.Join(cfg.WorkspaceDir, "data")),
		rewardPerTflop:  cfg.RewardPerTflop,
		nodeID:          cfg.NodeID,
		localTflops:     localTflops,
		hasGPU:          hasGPU,
		gpuModel:        gpuModel,
		cudaVersion:     cudaVer,
		vramMB:          vram,
		trainer:         federated.NewLocalTrainer(cfg.NodeID, maxGPUPercent),
	}
	if err := d.LoadState(d.stateDir); os.IsNotExist(err) && os.Getenv("SWYPIK_STATE_DIR") == "" {
		_ = d.LoadState(cfg.WorkspaceDir)
	}
	d.enabled.Store(enabled)
	d.startWorker()
	return d
}

// ExecuteTrainingMicroBatch runs the local training simulator. Rewards are local estimates.
func (d *Daemon) ExecuteTrainingMicroBatch(roundID int) (*federated.WeightDelta, float64, error) {
	if !d.enabled.Load() || !d.trainingEnabled {
		return nil, 0, fmt.Errorf("training disabled")
	}
	select {
	case <-d.stopChan:
		return nil, 0, fmt.Errorf("daemon stopped")
	default:
	}
	d.mu.Lock()
	if d.trainer == nil {
		d.trainer = federated.NewLocalTrainer(d.nodeID, d.maxGPUPercent)
	}
	trainer := d.trainer
	d.mu.Unlock()

	delta, err := trainer.ComputeMicroBatch(roundID, "transformer.lora_a", 32)
	if err != nil {
		return nil, 0, err
	}

	reward := delta.TFLOPSComputed * d.rewardPerTflop
	d.mu.Lock()
	d.coinsEarned += reward
	d.tasksCompleted++
	d.mu.Unlock()

	return delta, reward, nil
}

func (d *Daemon) startWorker() {
	go func() {
		defer close(d.workerDone)
		var nonce uint64 = 0
		buf := make([]byte, 32)
		binary.LittleEndian.PutUint64(buf[0:8], uint64(time.Now().UnixNano()))

		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()

		var hashesInInterval int64 = 0

		for {
			select {
			case <-d.stopChan:
				return
			case <-ticker.C:
				if d.enabled.Load() {
					d.mu.Lock()
					d.realHashRate = float64(atomic.LoadInt64(&hashesInInterval)) / 2000.0
					d.mu.Unlock()
				}
				atomic.StoreInt64(&hashesInInterval, 0)
			default:
				if d.enabled.Load() {
					for i := 0; i < 64; i++ {
						binary.LittleEndian.PutUint64(buf[8:16], nonce)
						sha256.Sum256(buf)
						nonce++
						atomic.AddInt64(&d.totalHashes, 1)
						atomic.AddInt64(&hashesInInterval, 1)
					}
					// Controlled backoff to maintain low CPU overhead (sub-5%)
					time.Sleep(10 * time.Millisecond)
				} else {
					time.Sleep(100 * time.Millisecond)
				}
			}
		}
	}()
}

func (d *Daemon) IsEnabled() bool {
	return d.enabled.Load()
}

func (d *Daemon) Toggle() {
	for {
		old := d.enabled.Load()
		if d.enabled.CompareAndSwap(old, !old) {
			return
		}
	}
}

func (d *Daemon) Stop() {
	d.stopOnce.Do(func() {
		close(d.stopChan)
		<-d.workerDone
		_ = d.SaveState(d.stateDir)
	})
}

func (d *Daemon) SetGPUMetrics(tflops float64, _, _ int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.localTflops = tflops
}

func (d *Daemon) LoadState(dir string) error {
	path := filepath.Join(dir, "swarm_state.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var s struct {
		TasksCompleted int64   `json:"tasks_completed"`
		CoinsEarned    float64 `json:"coins_earned"`
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	d.mu.Lock()
	d.tasksCompleted = s.TasksCompleted
	d.coinsEarned = s.CoinsEarned
	d.mu.Unlock()
	return nil
}

func (d *Daemon) SaveState(dir string) error {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	path := filepath.Join(dir, "swarm_state.json")
	d.mu.RLock()
	s := struct {
		TasksCompleted int64   `json:"tasks_completed"`
		CoinsEarned    float64 `json:"coins_earned"`
	}{
		TasksCompleted: d.tasksCompleted,
		CoinsEarned:    d.coinsEarned,
	}
	d.mu.RUnlock()
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return storage.WriteFile(path, data, 0600)
}

func (d *Daemon) GetStatus() Status {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return Status{
		Enabled:        d.enabled.Load(),
		TasksCompleted: d.tasksCompleted,
		CoinsEarned:    d.coinsEarned,
		LocalTflops:    d.localTflops,
		MeshNodes:      0,
		LatencyMs:      0,
		RealHashRate:   d.realHashRate,
		HasGPU:         d.hasGPU,
		GPUModel:       d.gpuModel,
		CUDAVersion:    d.cudaVersion,
		VRAMMB:         d.vramMB,
	}
}
