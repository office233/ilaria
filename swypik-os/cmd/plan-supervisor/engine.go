package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"swypik-os/core/controlkernel"
	"swypik-os/core/effects"
	"swypik-os/core/resource"
	"swypik-os/core/supervisor"
	wire "swypik-os/generated/swypeffects"
	"swypik-os/internal/planprocess"
)

type engine struct {
	ctx           context.Context
	config        configuration
	policy        resource.Policy
	kernel        *controlkernel.Kernel
	governor      *resource.Governor
	verifier      *streamVerifier
	children      childProcessGroup
	usage         *resource.ProcessSampler
	hostBaseline  resource.ProcessUsage
	activeGuest   *planprocess.Process
	activeMetrics *runMetrics
}

type childProcessGroup interface {
	Start(context.Context, planprocess.Config) (*planprocess.Process, error)
	Mechanism() string
	Close() error
}

type runReport struct {
	ProtocolVersion uint64                     `json:"protocol_version"`
	PlanID          string                     `json:"plan_id"`
	Status          *supervisor.Snapshot       `json:"status,omitempty"`
	Recovery        *supervisor.RecoveryReport `json:"recovery,omitempty"`
	Metrics         runMetrics                 `json:"metrics"`
	ErrorCode       string                     `json:"error_code"`
}

func openEngine(ctx context.Context, c configuration, p resource.Policy) (*engine, error) {
	children, err := planprocess.OpenGroup(planprocess.Limits{CPUPercent: c.KernelCPUPercent, MemoryBytes: c.KernelMemoryBytes,
		MaxProcesses: c.KernelMaxProcesses, LinuxDelegatedRoot: c.LinuxCgroupRoot})
	if err != nil {
		return nil, fmt.Errorf("strict OS process limits unavailable: %w", err)
	}
	return openEngineWithGroup(ctx, c, p, children)
}

func openEngineWithGroup(ctx context.Context, c configuration, p resource.Policy, children childProcessGroup) (*engine, error) {
	if children == nil {
		return nil, fmt.Errorf("strict child process group required")
	}
	resource.ApplyRuntime(p)
	auth := hostAuthentication{executorID: c.ExecutorID, verifierID: c.VerifierID, executorHash: sha256.Sum256([]byte(c.ExecutorCredential)), verifierHash: sha256.Sum256([]byte(c.VerifierCredential))}
	if err := os.MkdirAll(c.LedgerDirectory, 0700); err != nil {
		_ = children.Close()
		return nil, err
	}
	k, err := controlkernel.OpenKernel(c.Journal, controlkernel.WithExecutorAuthenticator(auth), controlkernel.WithVerifierAuthenticator(auth))
	if err != nil {
		_ = children.Close()
		return nil, err
	}
	u, err := resource.NewProcessSampler(os.Getpid())
	if err != nil {
		_ = k.Close()
		_ = children.Close()
		return nil, err
	}
	e := &engine{ctx: ctx, config: c, policy: p, kernel: k, governor: resource.NewGovernor(p), children: children, usage: u}
	e.verifier = &streamVerifier{engine: e}
	if err := e.governor.SetTransitionSink(controlkernel.NewResourceTransitionSink(k)); err != nil {
		_ = e.Close()
		return nil, err
	}
	return e, nil
}

func (e *engine) Close() error {
	result := errors.Join(e.verifier.Close(), e.children.Close(), e.usage.Close(), e.kernel.Close())
	for i := range e.config.ContinuationPolicy.Key {
		e.config.ContinuationPolicy.Key[i] = 0
	}
	return result
}

func hashJSON(value any) string {
	raw, _ := json.Marshal(value)
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:])
}
func validHash(s string) bool {
	b, err := hex.DecodeString(s)
	return err == nil && len(b) == 32 && hex.EncodeToString(b) == s
}

func (e *engine) childConfig(executable string, args []string) planprocess.Config {
	return planprocess.Config{Executable: executable, Args: args, Directory: filepath.Dir(executable), MaxThreads: runtime.GOMAXPROCS(0), MemoryLimitBytes: min(int64(e.config.RSSLimitBytes), int64(e.policy.MemoryLimitMB)<<20), GCPercent: e.policy.GCPercent}
}

func (e *engine) startChild(ctx context.Context, executable string, args []string) (*planprocess.Process, error) {
	return e.children.Start(ctx, e.childConfig(executable, args))
}

func (e *engine) checkBudget() error {
	u, err := e.usage.Sample()
	if err != nil {
		return fmt.Errorf("host resource measurement failed")
	}
	if u.RSSBytes > e.config.RSSLimitBytes {
		return fmt.Errorf("host RSS budget exceeded")
	}
	cpu := u.CPUTime - e.hostBaseline.CPUTime + e.activeMetrics.SwypCPU + e.activeMetrics.VerifierCPU
	if e.activeGuest != nil {
		current, err := e.activeGuest.Usage()
		if err != nil {
			return err
		}
		cpu += current.CPUTime
	}
	if cpu > time.Duration(e.config.CPUTimeMS)*time.Millisecond {
		return fmt.Errorf("aggregate plan CPU budget exceeded")
	}
	return nil
}

func (e *engine) compile(ctx context.Context, p configuredPlan, snapshot string, metrics *runMetrics) (wire.EffectPlan, error) {
	var plan wire.EffectPlan
	process, err := e.startChild(ctx, e.config.SwypExecutable, []string{"core-preflight", "--entry", p.Entry, "-o", snapshot, p.Source})
	if err != nil {
		return plan, err
	}
	metrics.ProcessStarts++
	defer process.Close()
	stop := process.Monitor(ctx, time.Duration(e.config.CPUTimeMS)*time.Millisecond, e.config.RSSLimitBytes, time.Duration(e.config.SampleIntervalMS)*time.Millisecond)
	raw, err := process.ReadLine(ctx)
	if err == nil {
		if _, endErr := process.ReadLine(ctx); !errors.Is(endErr, io.EOF) {
			err = fmt.Errorf("ambiguous preflight output")
		}
	}
	if err == nil {
		err = process.Wait(ctx)
	}
	if meterErr := stop(); err == nil {
		err = meterErr
	}
	_ = process.Close()
	usage, usageErr := process.Usage()
	metrics.SwypCPU += usage.CPUTime
	metrics.SwypPeakRSS = max(metrics.SwypPeakRSS, usage.PeakRSSBytes)
	if err == nil {
		err = usageErr
	}
	if err != nil {
		return plan, fmt.Errorf("preflight failed")
	}
	plan, err = wire.DecodePlan(raw)
	if err != nil || plan.Entry != p.Entry {
		return plan, fmt.Errorf("invalid compiled plan")
	}
	if err := verifySnapshotHash(snapshot, plan.ModuleHash); err != nil {
		return plan, err
	}
	return plan, nil
}

func verifySnapshotHash(snapshot, moduleHash string) error {
	f, err := os.Open(snapshot)
	if err != nil {
		return err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	hash := sha256.Sum256(raw)
	if err != nil || len(raw) > 1<<20 || hex.EncodeToString(hash[:]) != moduleHash {
		return fmt.Errorf("compiled snapshot does not match module hash")
	}
	return nil
}

func (e *engine) executionPolicyHash(p configuredPlan) string {
	return hashJSON(struct {
		Plan                 configuredPlan
		Profile, DeviceClass string
		CPUTimeMS            int64
		RSS                  uint64
		SampleMS             int64
		KernelCPUPercent     uint32
		KernelMemoryBytes    uint64
		KernelMaxProcesses   uint32
		LinuxCgroupRoot      string
	}{p, e.config.Profile, e.config.DeviceClass, e.config.CPUTimeMS, e.config.RSSLimitBytes, e.config.SampleIntervalMS,
		e.config.KernelCPUPercent, e.config.KernelMemoryBytes, e.config.KernelMaxProcesses, e.config.LinuxCgroupRoot})
}

func (e *engine) supervisorConfig(p configuredPlan) supervisor.Config {
	return supervisor.Config{Kernel: e.kernel, LedgerPath: filepath.Join(e.config.LedgerDirectory, hashJSON(p.ID)+".jsonl"),
		Scopes: p.Scopes, RootPaths: e.config.Roots, SignerKeyID: e.config.SignerKeyID, PrivateKey: e.config.PrivateKey,
		ExecutorID: e.config.ExecutorID, ExecutorCredential: e.config.ExecutorCredential, VerifierID: e.config.VerifierID,
		VerifierCredential: e.config.VerifierCredential, Verifier: e.verifier, ExecutionPolicyHash: e.executionPolicyHash(p),
		Continuation: e.config.ContinuationPolicy}
}

func (e *engine) openPlan(p configuredPlan, compiled wire.EffectPlan) (*supervisor.Supervisor, error) {
	deadline, _ := time.Parse(time.RFC3339Nano, p.Deadline)
	bindings := make([]supervisor.Binding, 0, len(compiled.CapabilityBindings))
	keys := make([]string, 0, len(compiled.CapabilityBindings))
	for key := range compiled.CapabilityBindings {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		parts := strings.Split(key, "/")
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid compiled binding")
		}
		bindings = append(bindings, supervisor.Binding{Function: parts[0], Effect: parts[1], Capability: compiled.CapabilityBindings[key]})
	}
	c := e.supervisorConfig(p)
	c.Plan = supervisor.Plan{TaskID: p.TaskID, RunID: p.RunID, ModuleHash: compiled.ModuleHash, Entry: compiled.Entry, Bindings: bindings,
		Effects: compiled.Effects, MaxEffects: p.MaxEffects, MaxReadBytes: p.MaxReadBytes, FuelLimit: uint64(p.Fuel),
		MaxEffectBytes: uint64(p.MaxReturnedBytes), Deadline: deadline}
	return supervisor.Open(c)
}

func (e *engine) recover(ctx context.Context, id string) runReport {
	report := runReport{ProtocolVersion: 1, PlanID: id}
	report.Metrics.KernelLimitMechanism = e.children.Mechanism()
	var p *configuredPlan
	for i := range e.config.Plans {
		if e.config.Plans[i].ID == id {
			p = &e.config.Plans[i]
			break
		}
	}
	if p == nil {
		report.ErrorCode = "unknown_plan"
		return report
	}
	start := time.Now()
	before, sampleErr := e.usage.Sample()
	if sampleErr != nil {
		report.ErrorCode = "resource_measurement_failed"
		return report
	}
	s, err := supervisor.OpenRecovery(e.supervisorConfig(*p))
	if err != nil {
		switch {
		case errors.Is(err, os.ErrNotExist):
			report.ErrorCode = "not_started"
		case errors.Is(err, supervisor.ErrPolicyChanged):
			report.ErrorCode = "policy_changed"
		default:
			report.ErrorCode = "recovery_open_failed"
		}
	} else {
		defer s.Close()
		recovery, recoverErr := s.Recover(ctx)
		report.Recovery = &recovery
		report.Status = &recovery.Status
		if recoverErr != nil {
			report.ErrorCode = "recovery_failed"
		}
	}
	if after, err := e.usage.Sample(); err == nil {
		report.Metrics.HostCPU = after.CPUTime - before.CPUTime
		report.Metrics.HostPeakRSS = after.PeakRSSBytes
	}
	report.Metrics.WallTime = time.Since(start)
	return report
}

type completion struct {
	ProtocolVersion uint64      `json:"protocol_version"`
	Type            string      `json:"type"`
	RunID           string      `json:"run_id"`
	ModuleHash      string      `json:"module_hash"`
	Status          string      `json:"status"`
	Result          *literal    `json:"result,omitempty"`
	Steps           int         `json:"steps"`
	Diagnostic      *diagnostic `json:"diagnostic,omitempty"`
}
type literal struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}
type diagnostic struct {
	Code     string   `json:"code"`
	Message  string   `json:"message"`
	Location location `json:"location"`
}
type location struct {
	File   string `json:"file,omitempty"`
	Line   int    `json:"line,omitempty"`
	Column int    `json:"column,omitempty"`
}

func (e *engine) guestArgs(p configuredPlan, snapshot string, resume bool) []string {
	args := []string{"core-broker", "--ir", "--run-id", p.RunID, "--entry", p.Entry, "--steps", fmt.Sprint(p.Fuel),
		"--timeout", (time.Duration(p.WallTimeMS) * time.Millisecond).String(), "--max-bytes", fmt.Sprint(p.MaxReturnedBytes)}
	if resume {
		args = append(args, "--resume")
	} else if e.config.ContinuationPolicy.Enabled {
		args = append(args, "--continuations")
	}
	args = append(args, snapshot)
	if !resume {
		args = append(args, p.Arguments...)
	}
	return args
}

func (e *engine) execute(ctx context.Context, p configuredPlan, compiled wire.EffectPlan, snapshot string, s *supervisor.Supervisor, metrics *runMetrics) error {
	if err := s.Start(ctx); err != nil {
		return err
	}
	return e.executeGuest(ctx, p, compiled.ModuleHash, e.guestArgs(p, snapshot, false), nil, s, metrics)
}

// resumeWithSnapshot is the integration seam for the immutable attested plan
// cache. The caller must supply the exact verified canonical IR snapshot; this
// function re-hashes it before any guest process is launched.
func (e *engine) resumeWithSnapshot(ctx context.Context, p configuredPlan, snapshot string, s *supervisor.Supervisor, metrics *runMetrics) error {
	resume, err := s.BeginResume(ctx)
	if err != nil {
		return err
	}
	forget := true
	defer func() {
		if forget {
			s.ForgetResumeAuthorization()
		}
	}()
	if resume.Binding.RunID != p.RunID || resume.Binding.Entry != p.Entry || resume.Binding.FuelLimit != uint64(p.Fuel) ||
		resume.Binding.MaxEffectBytes != uint64(p.MaxReturnedBytes) {
		return fmt.Errorf("resume binding does not match configured plan budgets")
	}
	if err := verifySnapshotHash(snapshot, resume.Binding.ModuleHash); err != nil {
		return err
	}
	err = e.executeGuest(ctx, p, resume.Binding.ModuleHash, e.guestArgs(p, snapshot, true), &resume.Checkpoint, s, metrics)
	if err == nil {
		forget = false
	}
	return err
}

func (e *engine) executeGuest(ctx context.Context, p configuredPlan, moduleHash string, args []string, initial *supervisor.ContinuationEnvelope, s *supervisor.Supervisor, metrics *runMetrics) error {
	process, err := e.startChild(ctx, e.config.SwypExecutable, args)
	if err != nil {
		return err
	}
	metrics.ProcessStarts++
	e.activeGuest = process
	accounted := false
	defer func() {
		_ = process.Close()
		if !accounted {
			usage, _ := process.Usage()
			metrics.SwypCPU += usage.CPUTime
			metrics.SwypPeakRSS = max(metrics.SwypPeakRSS, usage.PeakRSSBytes)
		}
		e.activeGuest = nil
	}()
	remaining := time.Duration(e.config.CPUTimeMS)*time.Millisecond - metrics.SwypCPU
	if remaining <= 0 {
		return fmt.Errorf("plan CPU budget exhausted")
	}
	stop := process.Monitor(ctx, remaining, e.config.RSSLimitBytes, time.Duration(e.config.SampleIntervalMS)*time.Millisecond)
	stopped := false
	defer func() {
		if !stopped {
			_ = stop()
		}
	}()
	if initial != nil {
		if err := process.SendJSON(ctx, *initial); err != nil {
			return fmt.Errorf("resume checkpoint transport failed: %w", err)
		}
	}
	for {
		raw, err := process.ReadLine(ctx)
		if err != nil {
			return fmt.Errorf("guest transport ended before completion: %w", err)
		}
		var request wire.EffectRequest
		if err := effects.DecodeStrict(raw, &request); err == nil {
			usage, err := process.Usage()
			if err != nil {
				return err
			}
			e.verifier.remainingCPU = time.Duration(e.config.CPUTimeMS)*time.Millisecond - metrics.SwypCPU - usage.CPUTime - metrics.VerifierCPU
			if e.verifier.remainingCPU <= 0 {
				return fmt.Errorf("plan CPU budget exhausted")
			}
			evidence, err := s.Handle(ctx, request)
			if err != nil {
				return err
			}
			if err := process.SendJSON(ctx, evidence.Result); err != nil {
				return err
			}
			continue
		}
		var tagged struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(raw, &tagged)
		if tagged.Type == "continuation" {
			if !e.config.ContinuationPolicy.Enabled {
				return fmt.Errorf("guest emitted continuation while host persistence is disabled")
			}
			checkpoint, decodeErr := supervisor.DecodeContinuationEnvelope(raw, e.config.ContinuationPolicy.MaxEnvelopeBytes)
			if decodeErr != nil {
				return fmt.Errorf("guest continuation rejected: %w", decodeErr)
			}
			binding, storeErr := s.StoreContinuation(ctx, raw)
			if storeErr != nil {
				code := "host_persistence_failed"
				if errors.Is(storeErr, supervisor.ErrContinuationRejected) {
					code = "continuation_rejected"
				}
				_ = process.SendJSON(ctx, rejectedContinuationAck(checkpoint, code))
				return storeErr
			}
			if err := process.SendJSON(ctx, acceptedContinuationAck(binding)); err != nil {
				return fmt.Errorf("continuation acknowledgement transport failed: %w", err)
			}
			continue
		}
		var done completion
		if err := decodeFrame(raw, &done); err != nil || done.ProtocolVersion != 1 || done.Type != "completion" || done.RunID != p.RunID || done.ModuleHash != moduleHash || done.Status != "succeeded" || done.Result == nil || done.Diagnostic != nil || done.Steps < 0 || done.Steps > p.Fuel {
			if err != nil {
				return fmt.Errorf("guest completion rejected: %w", err)
			}
			return fmt.Errorf("guest completion rejected")
		}
		if err := validateLiteral(*done.Result); err != nil {
			return err
		}
		// A valid completion must also be the last frame and have a clean exit.
		if _, err := process.ReadLine(ctx); !errors.Is(err, io.EOF) {
			if err != nil {
				return fmt.Errorf("guest emitted data after completion: %w", err)
			}
			return fmt.Errorf("guest emitted data after completion")
		}
		if err := process.Wait(ctx); err != nil {
			return fmt.Errorf("guest failed after completion: %w", err)
		}
		err = stop()
		stopped = true
		usage, usageErr := process.Usage()
		metrics.SwypCPU += usage.CPUTime
		metrics.SwypPeakRSS = max(metrics.SwypPeakRSS, usage.PeakRSSBytes)
		accounted = true
		e.activeGuest = nil
		if err != nil {
			return fmt.Errorf("guest monitor failed: %w", err)
		}
		if usageErr != nil {
			return fmt.Errorf("guest usage measurement failed: %w", usageErr)
		}
		if metrics.SwypCPU+metrics.VerifierCPU > time.Duration(e.config.CPUTimeMS)*time.Millisecond {
			return fmt.Errorf("plan CPU budget exhausted")
		}
		if err := e.checkBudget(); err != nil {
			return err
		}
		valueHash := hashJSON(done.Result)
		if p.ExpectedValueHash != "" && valueHash != p.ExpectedValueHash {
			return fmt.Errorf("guest final value does not match host expectation")
		}
		_, err = s.Finish(ctx, hashJSON(done))
		return err
	}
}

func (e *engine) run(ctx context.Context, id string, statusOnly bool) runReport {
	report := runReport{ProtocolVersion: 1, PlanID: id}
	report.Metrics.KernelLimitMechanism = e.children.Mechanism()
	var configured *configuredPlan
	for i := range e.config.Plans {
		if e.config.Plans[i].ID == id {
			configured = &e.config.Plans[i]
			break
		}
	}
	if configured == nil {
		report.ErrorCode = "unknown_plan"
		return report
	}
	p := *configured
	if statusOnly {
		state, err := supervisor.Inspect(e.kernel, filepath.Join(e.config.LedgerDirectory, hashJSON(p.ID)+".jsonl"), p.TaskID, p.RunID)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				report.ErrorCode = "not_started"
			} else {
				report.ErrorCode = "status_unavailable"
			}
		} else {
			report.Status = &state
		}
		return report
	}
	start := time.Now()
	before, err := e.usage.Sample()
	if err != nil {
		report.ErrorCode = "resource_measurement_failed"
		return report
	}
	e.hostBaseline = before
	e.activeMetrics = &report.Metrics
	ctx, cancel := context.WithTimeout(ctx, time.Duration(p.WallTimeMS)*time.Millisecond)
	defer cancel()
	directory, err := os.MkdirTemp("", "nexus-plan-snapshot-")
	if err != nil {
		report.ErrorCode = "snapshot_unavailable"
		return report
	}
	defer os.RemoveAll(directory)
	snapshot := filepath.Join(directory, "snapshot.core.json")
	compiled, err := e.compile(ctx, p, snapshot, &report.Metrics)
	if err == nil {
		err = e.checkBudget()
	}
	if err != nil {
		report.ErrorCode = "preflight_failed"
	} else {
		s, openErr := e.openPlan(p, compiled)
		if openErr != nil {
			if errors.Is(openErr, supervisor.ErrRecoveryRequired) {
				report.ErrorCode = "recovery_required"
			} else if errors.Is(openErr, supervisor.ErrPolicyChanged) {
				report.ErrorCode = "policy_changed"
			} else {
				report.ErrorCode = "plan_open_failed"
			}
		} else {
			defer s.Close()
			{
				e.verifier.metrics = &report.Metrics
				err = e.execute(ctx, p, compiled, snapshot, s, &report.Metrics)
				if err != nil {
					fmt.Fprintf(os.Stderr, "engine execute plan %s failed: %v\n", p.ID, err)
					if errors.Is(err, supervisor.ErrRecoveryRequired) {
						report.ErrorCode = "recovery_required"
					} else if errors.Is(err, supervisor.ErrVerification) {
						report.ErrorCode = "verification_failed"
					} else {
						report.ErrorCode = "execution_failed"
					}
					// Never overwrite a terminal or uncertain replay state after Start denial.
					if !errors.Is(err, supervisor.ErrRecoveryRequired) && s.Status().State == supervisor.StateRunning {
						_, _ = s.Abort(context.Background(), report.ErrorCode)
					}
				}
			}
			state := s.Status()
			report.Status = &state
		}
	}
	after, err := e.usage.Sample()
	if err == nil {
		report.Metrics.HostCPU = after.CPUTime - before.CPUTime
		report.Metrics.HostPeakRSS = after.PeakRSSBytes
	}
	report.Metrics.WallTime = time.Since(start)
	return report
}
