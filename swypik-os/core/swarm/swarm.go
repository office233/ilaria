package swarm

import (
	"context"
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
	resourcepolicy "swypik-os/core/resource"
)

type SwarmConfig struct {
	Enabled         bool    `json:"enabled"`
	TrainingEnabled bool    `json:"training_enabled"`
	SendIntervalSec int     `json:"send_interval_sec"`
	MaxCPUPercent   float64 `json:"max_cpu_percent"`
	MaxGPUPercent   float64 `json:"max_gpu_percent"`
}

type Status struct {
	Enabled            bool                            `json:"enabled"`
	TasksCompleted     int64                           `json:"tasks_completed"`
	CoinsEarned        float64                         `json:"coins_earned"`
	LocalTflops        float64                         `json:"local_tflops"`
	MeshNodes          int                             `json:"mesh_nodes"`
	LatencyMs          int                             `json:"latency_ms"`
	RealHashRate       float64                         `json:"real_hashrate_khs"`
	HasGPU             bool                            `json:"has_gpu"`
	GPUModel           string                          `json:"gpu_model"`
	CUDAVersion        string                          `json:"cuda_version"`
	VRAMMB             int                             `json:"vram_mb"`
	ResourceBudget     resourcepolicy.BackgroundBudget `json:"resource_budget"`
	ResourceAuditError string                          `json:"resource_audit_error,omitempty"`
}

type adaptiveSignalSource struct {
	base    resourcepolicy.SignalSource
	thermal func() (int, bool)
}

func (s adaptiveSignalSource) Sample(ctx context.Context) (resourcepolicy.RuntimeSignals, error) {
	signals, err := s.base.Sample(ctx)
	if err != nil {
		return resourcepolicy.RuntimeSignals{}, err
	}
	if s.thermal != nil {
		if temperature, ok := s.thermal(); ok {
			signals.ThermalCelsius = temperature
		}
	}
	return signals, nil
}

func systemSignalSource(hasGPU bool) resourcepolicy.SignalSource {
	base := resourcepolicy.SystemSignalSource{}
	if !hasGPU {
		return base
	}
	driver := hal.NewCUDADriver()
	if err := driver.Init(); err != nil {
		return base
	}
	return adaptiveSignalSource{
		base: base,
		thermal: func() (int, bool) {
			telemetry, err := driver.GetTelemetry()
			if err != nil || telemetry == nil || telemetry.TemperatureC == 0 {
				return 0, false
			}
			return int(telemetry.TemperatureC), true
		},
	}
}

type Daemon struct {
	mu              sync.RWMutex
	enabled         atomic.Bool
	stopped         atomic.Bool
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
	realHashRate    float64
	localTflops     float64
	hasGPU          bool
	gpuModel        string
	cudaVersion     string
	vramMB          int
	trainer         *federated.LocalTrainer
	governor        *resourcepolicy.Governor
	governorCancel  context.CancelFunc
	governorDone    chan struct{}
	policy          resourcepolicy.Policy
	signalSource    resourcepolicy.SignalSource
}

func NewDaemon(args ...SwarmConfig) *Daemon {
	cfg := config.Get()
	enabled := cfg.SwarmEnabled
	trainingEnabled := true
	policy := resourcepolicy.Default()
	maxGPUPercent := float64(policy.MaxBackgroundGPUPercent)

	for _, override := range args {
		enabled = override.Enabled
		trainingEnabled = override.TrainingEnabled
		if override.MaxGPUPercent > 0 && override.MaxGPUPercent <= 100 {
			maxGPUPercent = override.MaxGPUPercent
		}
	}

	var hasGPU bool
	var gpuModel, cudaVer string
	var vram int
	localTflops := 0.0
	if enabled && trainingEnabled {
		// Hardware inventory is lazy with respect to the feature. A device that
		// does not contribute compute should not pay startup latency for GPU probes.
		halMgr := hal.NewManager()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, _ = halMgr.Scan(ctx)
		cancel()
		hasGPU, gpuModel, vram, _, cudaVer = halMgr.GetGPUComputeCapability()
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
		trainer:         nil,
		governor:        resourcepolicy.NewGovernor(policy),
		policy:          policy,
		signalSource:    systemSignalSource(hasGPU),
	}
	if err := d.LoadState(d.stateDir); os.IsNotExist(err) && os.Getenv("SWYPIK_STATE_DIR") == "" {
		_ = d.LoadState(cfg.WorkspaceDir)
	}
	d.enabled.Store(enabled)
	if enabled && trainingEnabled {
		d.startGovernorMonitor()
	}
	d.startWorker()
	return d
}

func (d *Daemon) startGovernorMonitor() {
	d.mu.Lock()
	if d.stopped.Load() || d.governorCancel != nil || !d.trainingEnabled {
		d.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	d.governorCancel = cancel
	d.governorDone = done
	interval := d.policy.StatusPollInterval
	governor := d.governor
	source := d.signalSource
	d.mu.Unlock()
	go func() {
		defer close(done)
		_ = resourcepolicy.WatchGovernor(ctx, governor, source, interval)
	}()
}

func (d *Daemon) stopGovernorMonitor() {
	d.mu.Lock()
	cancel := d.governorCancel
	done := d.governorDone
	d.governorCancel = nil
	d.governorDone = nil
	d.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}

// ExecuteTrainingMicroBatch runs the local training simulator. Rewards are local estimates.
func (d *Daemon) ExecuteTrainingMicroBatch(roundID int) (*federated.WeightDelta, float64, error) {
	return d.ExecuteTrainingMicroBatchContext(context.Background(), roundID)
}

// ExecuteTrainingMicroBatchContext runs one cooperative training unit under the
// OS-wide background worker/CPU budget. Future real GPU kernels must also
// observe ctx internally for prompt foreground preemption.
func (d *Daemon) ExecuteTrainingMicroBatchContext(ctx context.Context, roundID int) (*federated.WeightDelta, float64, error) {
	if d.stopped.Load() {
		return nil, 0, fmt.Errorf("daemon stopped")
	}
	if !d.enabled.Load() || !d.trainingEnabled {
		return nil, 0, fmt.Errorf("training disabled")
	}
	if ctx == nil {
		return nil, 0, fmt.Errorf("nil training context")
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

	var delta *federated.WeightDelta
	err := d.governor.Run(ctx, func(ctx context.Context) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		budget := d.governor.Budget()
		gpuPercent := float64(budget.MaxGPUPercent)
		if d.maxGPUPercent > 0 && d.maxGPUPercent < gpuPercent {
			gpuPercent = d.maxGPUPercent
		}
		trainer.SetMaxGPUPercent(gpuPercent)
		var trainErr error
		delta, trainErr = trainer.ComputeMicroBatch(roundID, "transformer.lora_a", 32)
		return trainErr
	})
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
		// Idle means truly idle. Older prototypes burned CPU continuously hashing
		// synthetic buffers merely to display a "hashrate". That work contributed
		// nothing to Ilaria training and caused needless wakeups on every device.
		// Real compute is initiated explicitly through ExecuteTrainingMicroBatch
		// (and future signed Compute Fabric jobs), so the background worker can
		// remain parked until shutdown.
		<-d.stopChan
	}()
}

func (d *Daemon) IsEnabled() bool {
	return d.enabled.Load()
}

// SetResourceTransitionSink attaches OS-level resource authority/auditing.
// The caller owns the sink lifecycle (for example a Control Kernel journal);
// Swarm never creates or closes that authority implicitly.
func (d *Daemon) SetResourceTransitionSink(sink resourcepolicy.TransitionSink) error {
	if d == nil {
		return fmt.Errorf("swarm daemon is nil")
	}
	if d.stopped.Load() {
		return fmt.Errorf("daemon stopped")
	}
	return d.governor.SetTransitionSink(sink)
}

func (d *Daemon) Toggle() {
	if d.stopped.Load() {
		return
	}
	for {
		old := d.enabled.Load()
		if d.enabled.CompareAndSwap(old, !old) {
			if old {
				d.stopGovernorMonitor()
			} else {
				d.startGovernorMonitor()
			}
			return
		}
	}
}

func (d *Daemon) Stop() {
	d.stopOnce.Do(func() {
		d.stopped.Store(true)
		d.stopGovernorMonitor()
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
	status := Status{
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
	d.mu.RUnlock()
	status.ResourceBudget = d.governor.Budget()
	if err := d.governor.AuditError(); err != nil {
		status.ResourceAuditError = err.Error()
	}
	return status
}
