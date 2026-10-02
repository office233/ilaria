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

	"swypik-os/core/hal"
	"swypik-os/core/imcnetwork"
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
	LocalTflops        float64                         `json:"local_tflops"`
	MeshNodes          int                             `json:"mesh_nodes"`
	LatencyMs          int                             `json:"latency_ms"`
	HasGPU             bool                            `json:"has_gpu"`
	GPUModel           string                          `json:"gpu_model"`
	CUDAVersion        string                          `json:"cuda_version"`
	VRAMMB             int                             `json:"vram_mb"`
	ResourceBudget     resourcepolicy.BackgroundBudget `json:"resource_budget"`
	ResourceAuditError string                          `json:"resource_audit_error,omitempty"`
	StateError         string                          `json:"state_error,omitempty"`
	HardwareError      string                          `json:"hardware_error,omitempty"`
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
	stopChan        chan struct{}
	stopOnce        sync.Once
	workerDone      chan struct{}
	stateDir        string
	nodeID          string
	localTflops     float64
	hasGPU          bool
	gpuModel        string
	cudaVersion     string
	vramMB          int
	governor        *resourcepolicy.Governor
	governorCancel  context.CancelFunc
	governorDone    chan struct{}
	policy          resourcepolicy.Policy
	signalSource    resourcepolicy.SignalSource
	stateError      string
	hardwareError   string
	verifiedRounds  imcnetwork.RoundRunner
}

func NewDaemon(args ...SwarmConfig) *Daemon {
	cfg := config.Get()
	enabled := cfg.SwarmEnabled
	trainingEnabled := config.GetBool("SWYPIK_SWARM_TRAINING_ENABLED", false)
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
	var hardwareError string
	var vram int
	localTflops := 0.0
	if enabled && trainingEnabled {
		// Hardware inventory is lazy with respect to the feature. A device that
		// does not contribute compute should not pay startup latency for GPU probes.
		halMgr := hal.NewManager()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, scanErr := halMgr.Scan(ctx)
		cancel()
		if scanErr != nil {
			hardwareError = scanErr.Error()
		} else {
			hasGPU, gpuModel, vram, _, cudaVer = halMgr.GetGPUComputeCapability()
		}
	}

	d := &Daemon{
		trainingEnabled: trainingEnabled,
		maxGPUPercent:   maxGPUPercent,
		tasksCompleted:  0,
		stopChan:        make(chan struct{}),
		workerDone:      make(chan struct{}),
		stateDir:        config.GetString("SWYPIK_STATE_DIR", filepath.Join(cfg.WorkspaceDir, "data")),
		nodeID:          cfg.NodeID,
		localTflops:     localTflops,
		hasGPU:          hasGPU,
		gpuModel:        gpuModel,
		cudaVersion:     cudaVer,
		vramMB:          vram,
		governor:        resourcepolicy.NewGovernor(policy),
		policy:          policy,
		signalSource:    systemSignalSource(hasGPU),
		hardwareError:   hardwareError,
	}
	if err := d.LoadState(d.stateDir); err != nil {
		if os.IsNotExist(err) && os.Getenv("SWYPIK_STATE_DIR") == "" {
			if fallbackErr := d.LoadState(cfg.WorkspaceDir); fallbackErr != nil && !os.IsNotExist(fallbackErr) {
				d.stateError = fallbackErr.Error()
			}
		} else if !os.IsNotExist(err) {
			d.stateError = err.Error()
		}
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

// ExecuteVerifiedRound accepts only the injected typed real-round path; no
// float conversion, self-reported TFLOPS reward or simulator fallback.
func (d *Daemon) SetVerifiedRoundAdapter(adapter imcnetwork.RoundRunner) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.verifiedRounds = adapter
}

// NewVerifiedRoundDaemon composes only public injected resource/round authority;
// no hardware scan, state loading, wallet/reward or simulator is initialized.
func NewVerifiedRoundDaemon(policy resourcepolicy.Policy) *Daemon {
	d := &Daemon{trainingEnabled: true, stopChan: make(chan struct{}), workerDone: make(chan struct{}), governor: resourcepolicy.NewGovernor(policy), policy: policy}
	d.enabled.Store(true)
	d.startWorker()
	return d
}
func (d *Daemon) ExecuteVerifiedRound(ctx context.Context, issued imcnetwork.IssuedRound) (imcnetwork.VerifiedReceipt, error) {
	if ctx == nil || d.stopped.Load() || !d.enabled.Load() {
		return imcnetwork.VerifiedReceipt{}, fmt.Errorf("disabled/stopped/context unavailable")
	}
	d.mu.RLock()
	adapter := d.verifiedRounds
	enabled := d.trainingEnabled
	d.mu.RUnlock()
	if !enabled || adapter == nil {
		return imcnetwork.VerifiedReceipt{}, fmt.Errorf("explicit verified training opt-in/adapter required")
	}
	var receipt imcnetwork.VerifiedReceipt
	workCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-d.stopChan:
			cancel()
		case <-workCtx.Done():
		}
	}()
	err := d.governor.Run(workCtx, func(ctx context.Context) error { var e error; receipt, e = adapter.RunRound(ctx, issued); return e })
	if err == nil && receipt.Accepted && receipt.Applied {
		d.mu.Lock()
		d.tasksCompleted++
		d.mu.Unlock()
	}
	return receipt, err
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
		if err := d.SaveState(d.stateDir); err != nil {
			d.mu.Lock()
			d.stateError = err.Error()
			d.mu.Unlock()
		}
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
		TasksCompleted int64 `json:"tasks_completed"`
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	d.mu.Lock()
	d.tasksCompleted = s.TasksCompleted
	d.mu.Unlock()
	return nil
}

func (d *Daemon) SaveState(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	path := filepath.Join(dir, "swarm_state.json")
	d.mu.RLock()
	s := struct {
		TasksCompleted int64 `json:"tasks_completed"`
	}{
		TasksCompleted: d.tasksCompleted,
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
		LocalTflops:    d.localTflops,
		MeshNodes:      0,
		LatencyMs:      0,
		HasGPU:         d.hasGPU,
		GPUModel:       d.gpuModel,
		CUDAVersion:    d.cudaVersion,
		VRAMMB:         d.vramMB,
		StateError:     d.stateError,
		HardwareError:  d.hardwareError,
	}
	d.mu.RUnlock()
	status.ResourceBudget = d.governor.Budget()
	if err := d.governor.AuditError(); err != nil {
		status.ResourceAuditError = err.Error()
	}
	return status
}
