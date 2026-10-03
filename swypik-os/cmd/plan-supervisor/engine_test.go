package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"testing"
	"time"

	"swypik-os/core/effects"
	"swypik-os/core/supervisor"
	wire "swypik-os/generated/swypeffects"
	"swypik-os/internal/planprocess"
)

type testChildGroup struct{}

func (testChildGroup) Start(ctx context.Context, config planprocess.Config) (*planprocess.Process, error) {
	return planprocess.Start(ctx, config)
}
func (testChildGroup) Mechanism() string { return "test_unconfined" }
func (testChildGroup) Close() error      { return nil }

// The trusted children are this test executable, selected by their normal CLI
// arguments. No shell, inherited helper environment, external compiler, model,
// or production signing key is needed to exercise the process boundaries.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "core-preflight", "core-broker":
			if err := helperGuest(os.Args[1:]); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			os.Exit(0)
		case "--stream":
			if err := helperObserver(os.Args[1:]); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			os.Exit(0)
		}
	}
	os.Exit(m.Run())
}

type guestScenario struct {
	Mode  string  `json:"mode"`
	Value literal `json:"value"`
}

func helperArgument(args []string, flag string) string {
	for i := range args {
		if args[i] == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func helperFlag(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag {
			return true
		}
	}
	return false
}

func helperGuest(args []string) error {
	var source string
	if args[0] == "core-preflight" {
		source = args[len(args)-1]
	} else if len(args) > 1 {
		source = args[len(args)-1]
	} else {
		return errors.New("missing helper snapshot")
	}
	raw, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	var scenario guestScenario
	if err := json.Unmarshal(raw, &scenario); err != nil {
		return err
	}
	hash := sha256.Sum256(raw)
	moduleHash := hex.EncodeToString(hash[:])
	encoder := json.NewEncoder(os.Stdout)
	if args[0] == "core-preflight" {
		if err := os.WriteFile(helperArgument(args, "-o"), raw, 0600); err != nil {
			return err
		}
		plan := wire.EffectPlan{ProtocolVersion: 1, ModuleHash: moduleHash, Entry: helperArgument(args, "--entry"), Effects: []string{}, CapabilityBindings: map[string]string{}}
		if scenario.Mode == "continuation_suspend" {
			plan.Effects = []string{"clock.read"}
			plan.CapabilityBindings = map[string]string{"main/clock.read": "clock_read"}
		}
		if err := encoder.Encode(plan); err != nil {
			return err
		}
		if scenario.Mode == "preflight_trailing" {
			return encoder.Encode(map[string]string{"unexpected": "frame"})
		}
		return nil
	}
	if scenario.Mode == "continuation_suspend" && helperFlag(args, "--resume") {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64<<10), planprocess.MaxLineBytes+2)
		if !scanner.Scan() {
			return errors.New("missing resume checkpoint")
		}
		var checkpoint supervisor.ContinuationEnvelope
		if err := json.Unmarshal(scanner.Bytes(), &checkpoint); err != nil {
			return err
		}
		fuel, _ := strconv.ParseUint(helperArgument(args, "--steps"), 10, 64)
		maxBytes, _ := strconv.ParseUint(helperArgument(args, "--max-bytes"), 10, 64)
		if checkpoint.ProtocolVersion != 1 || checkpoint.Type != "continuation" || checkpoint.StateVersion != 1 || checkpoint.RunID != helperArgument(args, "--run-id") ||
			checkpoint.ModuleHash != moduleHash || checkpoint.Entry != helperArgument(args, "--entry") || checkpoint.FuelLimit != fuel || checkpoint.MaxEffectBytes != maxBytes ||
			checkpoint.EffectCursor != 1 || checkpoint.StateHash != hashBytes(checkpoint.State) {
			return errors.New("invalid resume checkpoint")
		}
		done := completion{ProtocolVersion: 1, Type: "completion", RunID: checkpoint.RunID, ModuleHash: moduleHash, Status: "succeeded", Result: &scenario.Value, Steps: int(checkpoint.StepsUsed) + 1}
		return encoder.Encode(done)
	}
	if scenario.Mode == "continuation_suspend" && helperFlag(args, "--continuations") {
		request := wire.EffectRequest{ProtocolVersion: 1, RequestID: helperArgument(args, "--run-id") + ":1", ModuleHash: moduleHash,
			Function: "main", Effect: "clock.read", Capability: "clock_read"}
		if err := encoder.Encode(request); err != nil {
			return err
		}
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64<<10), planprocess.MaxLineBytes+2)
		if !scanner.Scan() {
			return errors.New("missing effect result")
		}
		var result wire.EffectResult
		if err := effects.DecodeStrict(scanner.Bytes(), &result); err != nil {
			return err
		}
		requestHash, _ := effects.RequestHash(request)
		resultHash, _ := effects.ResultHash(result)
		state := []byte("synthetic-sensitive-resume-state")
		fuel, _ := strconv.ParseUint(helperArgument(args, "--steps"), 10, 64)
		maxBytes, _ := strconv.ParseUint(helperArgument(args, "--max-bytes"), 10, 64)
		checkpoint := supervisor.ContinuationEnvelope{ProtocolVersion: 1, Type: "continuation", StateVersion: 1,
			RunID: request.RequestID[:strings.LastIndex(request.RequestID, ":")], ModuleHash: moduleHash, Entry: helperArgument(args, "--entry"),
			FuelLimit: fuel, StepsUsed: 2, MaxEffectBytes: maxBytes, EffectBytes: 0, EffectCursor: 1,
			EffectRequestHash: requestHash, EffectResultHash: resultHash, StateHash: hashBytes(state), State: state}
		if err := encoder.Encode(checkpoint); err != nil {
			return err
		}
		if !scanner.Scan() {
			return errors.New("missing continuation acknowledgement")
		}
		var ack continuationAck
		if err := json.Unmarshal(scanner.Bytes(), &ack); err != nil || ack.Status != "accepted" || ack.Type != "continuation_ack" ||
			ack.RunID != checkpoint.RunID || ack.ModuleHash != checkpoint.ModuleHash || ack.Entry != checkpoint.Entry ||
			ack.EffectCursor != checkpoint.EffectCursor || ack.StateHash != checkpoint.StateHash {
			return errors.New("continuation acknowledgement rejected")
		}
		// Simulate a guest/host transport stop immediately after a durable,
		// acknowledged post-effect checkpoint. Recovery must resume from it.
		return nil
	}
	if scenario.Mode == "no_completion" {
		return nil
	}
	if scenario.Mode == "cpu_spin" {
		until := time.Now().Add(10 * time.Second)
		for time.Now().Before(until) {
			for i := 0; i < 10000; i++ {
				hash = sha256.Sum256(hash[:])
			}
		}
	}
	done := completion{ProtocolVersion: 1, Type: "completion", RunID: helperArgument(args, "--run-id"), ModuleHash: moduleHash, Status: "succeeded", Result: &scenario.Value, Steps: 1}
	switch scenario.Mode {
	case "wrong_run":
		done.RunID = "other-run"
	case "wrong_module":
		done.ModuleHash = strings.Repeat("0", 64)
	case "wrong_version":
		done.ProtocolVersion = 2
	case "failed_status":
		done.Status = "failed"
	case "missing_result":
		done.Result = nil
	case "diagnostic":
		done.Diagnostic = &diagnostic{Code: "failed", Message: "sensitive-diagnostic"}
	case "excess_steps":
		done.Steps = 101
	}
	if scenario.Mode == "unknown_field" || scenario.Mode == "missing_steps" || scenario.Mode == "null_steps" || scenario.Mode == "missing_literal_value" {
		raw, _ := json.Marshal(done)
		var fields map[string]any
		_ = json.Unmarshal(raw, &fields)
		switch scenario.Mode {
		case "unknown_field":
			fields["payload"] = "sensitive-payload"
		case "missing_steps":
			delete(fields, "steps")
		case "null_steps":
			fields["steps"] = nil
		case "missing_literal_value":
			fields["result"] = map[string]any{"type": "void"}
		}
		return encoder.Encode(fields)
	}
	if err := encoder.Encode(done); err != nil {
		return err
	}
	if scenario.Mode == "trailing" {
		return encoder.Encode(done)
	}
	if scenario.Mode == "exit_failed" {
		return errors.New("failed after emitting completion")
	}
	return nil
}

func hashBytes(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

type observerEnvelope struct {
	ProtocolVersion uint64             `json:"protocol_version"`
	Request         wire.EffectRequest `json:"request"`
	Result          wire.EffectResult  `json:"result"`
	Receipt         wire.EffectReceipt `json:"receipt"`
	Expected        effects.Binding    `json:"expected"`
}

func helperObserver(args []string) error {
	mode, err := os.ReadFile(helperArgument(args, "--keys"))
	if err != nil {
		return err
	}
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var envelope observerEnvelope
		if err := json.Unmarshal(scanner.Bytes(), &envelope); err != nil {
			return err
		}
		r, result, receipt, binding := envelope.Request, envelope.Result, envelope.Receipt, envelope.Expected
		requestHash, _ := effects.RequestHash(r)
		resultHash, _ := effects.ResultHash(result)
		signed, _ := effects.ReceiptSigningBytes(receipt)
		digest := sha256.Sum256(signed)
		o := observation{Format: "ilaria-effect-observation-v1", ProtocolVersion: 1, Verified: true, Purpose: "execution_evidence_only", PrivacyClass: "local_private", RequestID: r.RequestID, RequestHash: requestHash, ResultHash: resultHash, ReceiptHash: hex.EncodeToString(digest[:]), ModuleHash: r.ModuleHash, Function: r.Function, Effect: r.Effect, Capability: r.Capability, TaskID: binding.TaskID, NodeID: binding.NodeID, AttemptID: binding.AttemptID, ExecutorID: binding.ExecutorID, GrantID: binding.GrantID, LeaseID: binding.LeaseID, Fence: binding.Fence, IntentID: receipt.IntentID, SignerKeyID: receipt.SignerKeyID, OccurredAtUnixMS: receipt.OccurredAtUnixMS, ValueType: result.ValueType, ValueBytes: len(result.Value)}
		response := map[string]any{"protocol_version": uint64(1), "request_id": r.RequestID, "accepted": true, "error_code": "", "observation": o}
		switch string(mode) {
		case "unknown_field":
			response["payload"] = "sensitive-payload"
		case "correlation":
			response["request_id"] = "unrelated"
		case "negative":
			response["accepted"] = false
			response["error_code"] = "evidence_rejected"
		case "missing_error_code":
			delete(response, "error_code")
		case "null_error_code":
			response["error_code"] = nil
		case "privacy":
			o.PrivacyClass = "public"
		case "training":
			o.TrainingEligible = true
		case "request_hash":
			o.RequestHash = strings.Repeat("0", 64)
		case "result_hash":
			o.ResultHash = strings.Repeat("0", 64)
		case "receipt_hash":
			o.ReceiptHash = strings.Repeat("0", 64)
		case "fence":
			o.Fence++
		case "executor":
			o.ExecutorID = "other-worker"
		case "timestamp":
			o.OccurredAtUnixMS++
		case "value_size":
			o.ValueBytes++
		}
		response["observation"] = o
		if string(mode) == "missing_training_policy" || string(mode) == "missing_value_size" {
			raw, _ := json.Marshal(o)
			var fields map[string]any
			_ = json.Unmarshal(raw, &fields)
			if string(mode) == "missing_training_policy" {
				delete(fields, "training_eligible")
			} else {
				delete(fields, "value_bytes")
			}
			response["observation"] = fields
		}
		if err := encoder.Encode(response); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func newEngineFixture(t *testing.T, scenario guestScenario) (*engine, configuredPlan) {
	t.Helper()
	directory := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	p := configuredPlan{ID: "test-plan", TaskID: "test-task", RunID: "test-run", Source: filepath.Join(directory, "scenario.json"), Entry: "main", Deadline: time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), MaxEffects: 1, Fuel: 100, MaxReturnedBytes: 1024, WallTimeMS: 10000}
	raw, _ := json.Marshal(scenario)
	if err := os.WriteFile(p.Source, raw, 0600); err != nil {
		t.Fatal(err)
	}
	c := configuration{Version: 2, Journal: filepath.Join(directory, "kernel.journal"), LedgerDirectory: filepath.Join(directory, "ledgers"), SwypExecutable: executable, VerifierExecutable: executable, TrustRegistry: filepath.Join(directory, "test-observer-mode"), ExecutorID: "worker", ExecutorCredential: "fixture-executor", VerifierID: "observer", VerifierCredential: "fixture-verifier", SignerKeyID: "ephemeral-test-key", PrivateKey: private, Roots: map[string]string{}, Profile: "performance", DeviceClass: "workstation", CPUTimeMS: 5000, RSSLimitBytes: 512 << 20, SampleIntervalMS: 10, KernelCPUPercent: 25, KernelMemoryBytes: 512 << 20, KernelMaxProcesses: 16, Plans: []configuredPlan{p}}
	if runtime.GOOS == "linux" {
		// Validation still requires an explicit host path. Unit tests inject a
		// non-authoritative process group; real cgroup integration is separate.
		c.LinuxCgroupRoot = filepath.Join(directory, "delegated-cgroup-fixture")
	}
	policy, err := validateConfiguration(c)
	if err != nil {
		t.Fatal(err)
	}
	procs := runtime.GOMAXPROCS(0)
	memory := debug.SetMemoryLimit(-1)
	gc := debug.SetGCPercent(100)
	debug.SetGCPercent(gc)
	t.Cleanup(func() { runtime.GOMAXPROCS(procs); debug.SetMemoryLimit(memory); debug.SetGCPercent(gc) })
	e, err := openEngineWithGroup(context.Background(), c, policy, testChildGroup{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Close() })
	return e, p
}

func enableEngineContinuation(t *testing.T, e *engine, p configuredPlan) configuredPlan {
	t.Helper()
	p.MaxEffects = 2
	p.Scopes = []supervisor.Scope{{Function: "main", Effect: "clock.read", Capability: "clock_read"}}
	e.config.Version = 3
	e.config.Plans[0] = p
	e.config.ContinuationPolicy = supervisor.ContinuationPolicy{
		Enabled: true, Mode: supervisor.ContinuationModeAES256GCM,
		Directory: filepath.Join(filepath.Dir(e.config.Journal), "continuations"), KeyID: "synthetic-host-key",
		MaxEnvelopeBytes: 1 << 20,
	}
	copy(e.config.ContinuationPolicy.Key[:], []byte("0123456789abcdef0123456789abcdef"))
	if err := os.WriteFile(e.config.TrustRegistry, []byte("valid"), 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestConfigurationV3RequiresExplicitProtectedContinuationPolicy(t *testing.T) {
	e, _ := newEngineFixture(t, guestScenario{Value: literal{"i64", "42"}})
	c := e.config
	c.Version = 3
	keyFile := filepath.Join(t.TempDir(), "continuation.key")
	if err := os.WriteFile(keyFile, []byte("0123456789abcdef0123456789abcdef"), 0600); err != nil {
		t.Fatal(err)
	}
	c.Continuation = &continuationConfiguration{Mode: supervisor.ContinuationModeAES256GCM,
		Directory: filepath.Join(t.TempDir(), "continuation-data"), KeyFile: keyFile, KeyID: "host-key", MaxEnvelopeBytes: 1 << 20}
	if _, err := validateConfiguration(c); err != nil {
		t.Fatalf("valid v3 configuration rejected: %v", err)
	}
	policy, err := loadContinuationPolicy(c)
	if err != nil || !policy.Enabled || policy.KeyID != "host-key" || policy.Key == [32]byte{} {
		t.Fatalf("protected continuation policy not loaded: policy=%+v err=%v", policy, err)
	}
	c.Continuation.MaxEnvelopeBytes = planprocess.MaxLineBytes + 1
	if _, err := validateConfiguration(c); err == nil {
		t.Fatal("configuration widened continuation beyond the bounded process transport")
	}
	c.Continuation = &continuationConfiguration{Mode: "disabled", KeyFile: keyFile}
	if _, err := validateConfiguration(c); err == nil {
		t.Fatal("disabled continuation policy retained key authority")
	}
}

func TestContinuationCheckpointAckAndResumeUsesVerifiedSnapshotWithoutEffectReplay(t *testing.T) {
	e, p := newEngineFixture(t, guestScenario{Mode: "continuation_suspend", Value: literal{"i64", "42"}})
	p = enableEngineContinuation(t, e, p)
	metrics := &runMetrics{}
	e.activeMetrics, e.verifier.metrics = metrics, metrics
	e.hostBaseline, _ = e.usage.Sample()
	dir := t.TempDir()
	snapshot := filepath.Join(dir, "snapshot.core.json")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	compiled, err := e.compile(ctx, p, snapshot, metrics)
	if err != nil {
		t.Fatal(err)
	}
	s, err := e.openPlan(p, compiled)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.execute(ctx, p, compiled, snapshot, s, metrics); err == nil {
		t.Fatal("synthetic suspension unexpectedly completed")
	}
	status := s.Status()
	if status.State != supervisor.StateRunning || status.Issued != 1 || status.Committed != 1 {
		t.Fatalf("durable checkpoint was not left resumable: %+v", status)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	recovered, err := supervisor.OpenRecovery(e.supervisorConfig(p))
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	recovery, err := recovered.Recover(ctx)
	if err != nil || recovery.Outcome != supervisor.RecoveryResumeAvailable || !recovery.ContinuationAvailable || recovery.ContinuationResumed {
		t.Fatalf("recovery did not expose validated resume: %+v err=%v", recovery, err)
	}

	tampered := filepath.Join(dir, "tampered.core.json")
	if err := os.WriteFile(tampered, []byte(`{"tampered":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	starts := metrics.ProcessStarts
	if err := e.resumeWithSnapshot(ctx, p, tampered, recovered, metrics); err == nil || metrics.ProcessStarts != starts {
		t.Fatalf("tampered snapshot launched a guest: err=%v starts=%d->%d", err, starts, metrics.ProcessStarts)
	}
	if err := e.resumeWithSnapshot(ctx, p, snapshot, recovered, metrics); err != nil {
		t.Fatal(err)
	}
	status = recovered.Status()
	if status.State != supervisor.StateSucceeded || status.Issued != 1 || status.Committed != 1 {
		t.Fatalf("resume replayed the resolved provider effect or did not complete: %+v", status)
	}
}

func TestConfigurationStrictKernelCPUCannotExceedResourceEnvelope(t *testing.T) {
	e, _ := newEngineFixture(t, guestScenario{Value: literal{"i64", "42"}})
	c := e.config
	c.KernelCPUPercent = 26 // performance/workstation ceiling is 25%.
	if _, err := validateConfiguration(c); err == nil {
		t.Fatal("strict kernel CPU cap widened the selected resource profile")
	}
	c.KernelCPUPercent = 25
	if _, err := validateConfiguration(c); err != nil {
		t.Fatalf("profile CPU ceiling rejected: %v", err)
	}
	c.DeviceClass = "mobile"
	c.KernelCPUPercent = 4 // mobile tightens every base profile to 3%.
	if _, err := validateConfiguration(c); err == nil {
		t.Fatal("strict kernel CPU cap widened the device-class envelope")
	}
}

func TestPlanCompletionRequiresTypedBoundValueAndCleanExit(t *testing.T) {
	valid := []literal{{"i64", "-42"}, {"u64", "18446744073709551615"}, {"f64", "1.25"}, {"bool", "true"}, {"bytes", "aGVsbG8="}, {"void", ""}, {"ieee64", "NaN"}}
	for _, value := range valid {
		t.Run(value.Type, func(t *testing.T) {
			e, p := newEngineFixture(t, guestScenario{Value: value})
			p.ExpectedValueHash = hashJSON(value)
			e.config.Plans[0] = p
			report := e.run(context.Background(), p.ID, false)
			if report.ErrorCode != "" || report.Status == nil || report.Status.State != supervisor.StateSucceeded || report.Status.FinalValueHash == "" || report.Metrics.ProcessStarts != 2 {
				t.Fatalf("valid typed completion did not commit: %+v", report)
			}
		})
	}
	invalid := []struct {
		name, mode string
		value      literal
	}{
		{"unknown_type", "", literal{"pointer", "1"}},
		{"noncanonical_integer", "", literal{"i64", "+1"}},
		{"overflow_integer", "", literal{"i64", "9223372036854775808"}},
		{"nonfinite_f64", "", literal{"f64", "NaN"}},
		{"noncanonical_base64", "", literal{"bytes", "aGVsbG8=\n"}},
	}
	for _, mode := range []string{"wrong_run", "wrong_module", "wrong_version", "failed_status", "missing_result", "diagnostic", "excess_steps", "unknown_field", "missing_steps", "null_steps", "missing_literal_value", "trailing", "exit_failed", "no_completion"} {
		invalid = append(invalid, struct {
			name, mode string
			value      literal
		}{mode, mode, literal{"i64", "42"}})
	}
	for _, scenario := range invalid {
		t.Run(scenario.name, func(t *testing.T) {
			e, p := newEngineFixture(t, guestScenario{Mode: scenario.mode, Value: scenario.value})
			report := e.run(context.Background(), p.ID, false)
			if report.ErrorCode != "execution_failed" || report.Status == nil || report.Status.State != supervisor.StateFailed || report.Status.FinalValueHash != "" || report.Status.Committed != 0 {
				t.Fatalf("invalid completion committed or did not fail durably: %+v", report)
			}
			raw, _ := json.Marshal(report)
			if strings.Contains(string(raw), "sensitive-") {
				t.Fatal("failure report exposed child diagnostics or payload")
			}
		})
	}
}

func TestPlanRejectsUnexpectedFinalValueAndTrailingPreflight(t *testing.T) {
	for _, mode := range []string{"value_mismatch", "preflight_trailing"} {
		t.Run(mode, func(t *testing.T) {
			e, p := newEngineFixture(t, guestScenario{Mode: mode, Value: literal{"i64", "42"}})
			if mode == "value_mismatch" {
				p.ExpectedValueHash = hashJSON(literal{"i64", "43"})
				e.config.Plans[0] = p
			}
			report := e.run(context.Background(), p.ID, false)
			if report.ErrorCode == "" || report.Status != nil && report.Status.State == supervisor.StateSucceeded {
				t.Fatalf("ambiguous or unexpected result was accepted: %+v", report)
			}
		})
	}
}

func TestPlanChildCPUBudgetFailsClosed(t *testing.T) {
	e, p := newEngineFixture(t, guestScenario{Mode: "cpu_spin", Value: literal{"i64", "42"}})
	e.config.CPUTimeMS = 500
	start := time.Now()
	report := e.run(context.Background(), p.ID, false)
	if report.ErrorCode == "" || report.Status != nil && report.Status.State == supervisor.StateSucceeded || report.Metrics.SwypCPU <= 0 {
		t.Fatalf("CPU exhaustion was not rejected with measured usage: %+v", report)
	}
	if time.Since(start) > 6*time.Second {
		t.Fatal("CPU limit waited for the ten-second child instead of terminating it")
	}
}

func verifierFixture(t *testing.T, e *engine) (wire.EffectRequest, wire.EffectResult, wire.EffectReceipt, effects.Binding) {
	t.Helper()
	r := wire.EffectRequest{ProtocolVersion: 1, RequestID: "run:1", ModuleHash: strings.Repeat("1", 64), Function: "main", Effect: "clock.read", Capability: "clock_read"}
	result := wire.EffectResult{ProtocolVersion: 1, RequestID: r.RequestID, Status: "succeeded", ValueType: "i64", Value: []byte("42")}
	binding := effects.Binding{TaskID: "task", NodeID: "node", AttemptID: "attempt", ExecutorID: "worker", GrantID: "grant", LeaseID: "lease", Fence: 1}
	requestHash, _ := effects.RequestHash(r)
	resultHash, _ := effects.ResultHash(result)
	receipt := wire.EffectReceipt{ProtocolVersion: 1, RequestID: r.RequestID, RequestHash: requestHash, ResultHash: resultHash, Effect: r.Effect, Capability: r.Capability, TaskID: binding.TaskID, NodeID: binding.NodeID, AttemptID: binding.AttemptID, ExecutorID: binding.ExecutorID, GrantID: binding.GrantID, LeaseID: binding.LeaseID, Fence: binding.Fence, IntentID: "intent", Status: "succeeded", OccurredAtUnixMS: 42, PrivacyClass: "local_private", SignerKeyID: e.config.SignerKeyID}
	if err := effects.SignReceipt(&receipt, e.config.PrivateKey); err != nil {
		t.Fatal(err)
	}
	return r, result, receipt, binding
}

func TestIndependentVerifierRejectsAndResetsUntrustedResponses(t *testing.T) {
	for _, mode := range []string{"unknown_field", "correlation", "negative", "missing_error_code", "null_error_code", "missing_training_policy", "missing_value_size", "privacy", "training", "request_hash", "result_hash", "receipt_hash", "fence", "executor", "timestamp", "value_size"} {
		t.Run(mode, func(t *testing.T) {
			e, _ := newEngineFixture(t, guestScenario{Value: literal{"i64", "42"}})
			metrics := &runMetrics{}
			e.activeMetrics, e.verifier.metrics = metrics, metrics
			e.hostBaseline, _ = e.usage.Sample()
			e.verifier.remainingCPU = 5 * time.Second
			request, result, receipt, binding := verifierFixture(t, e)
			if mode == "missing_value_size" {
				// An empty bytes result makes omitted value_bytes indistinguishable
				// from an explicitly supplied zero unless nested presence is checked.
				request.Effect, request.Capability, request.Path = "fs.read", "workspace_read", "empty.txt"
				result.ValueType, result.Value = "bytes", []byte{}
				receipt.Effect, receipt.Capability = request.Effect, request.Capability
				receipt.RequestHash, _ = effects.RequestHash(request)
				receipt.ResultHash, _ = effects.ResultHash(result)
				if err := effects.SignReceipt(&receipt, e.config.PrivateKey); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(e.config.TrustRegistry, []byte(mode), 0600); err != nil {
				t.Fatal(err)
			}
			verified, err := e.verifier.Verify(context.Background(), request, result, receipt, binding)
			if err == nil || verified.Verified || e.verifier.process != nil {
				t.Fatalf("untrusted observer response accepted or child reused: verification=%+v error=%v", verified, err)
			}
			if err := os.WriteFile(e.config.TrustRegistry, []byte("valid"), 0600); err != nil {
				t.Fatal(err)
			}
			verified, err = e.verifier.Verify(context.Background(), request, result, receipt, binding)
			if err != nil || !verified.Verified || verified.Expected != binding || metrics.ProcessStarts != 2 {
				t.Fatalf("valid fresh observer could not recover after rejection: verification=%+v error=%v starts=%d", verified, err, metrics.ProcessStarts)
			}
			// A successful response keeps the same worker; changing its startup
			// input cannot silently reload trust or start another process.
			if err := os.WriteFile(e.config.TrustRegistry, []byte("privacy"), 0600); err != nil {
				t.Fatal(err)
			}
			verified, err = e.verifier.Verify(context.Background(), request, result, receipt, binding)
			if err != nil || !verified.Verified || metrics.ProcessStarts != 2 {
				t.Fatalf("successful persistent observer was unnecessarily restarted: %+v, %v", verified, err)
			}
		})
	}
}

func readControlResponse(t *testing.T, decoder *json.Decoder, value any) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- decoder.Decode(value) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("control response did not arrive")
	}
}

func awaitServeStop(t *testing.T, done <-chan error, wantCancelled bool) {
	t.Helper()
	select {
	case err := <-done:
		if wantCancelled && !errors.Is(err, context.Canceled) || !wantCancelled && err != nil {
			t.Fatalf("unexpected serve shutdown: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("serve did not stop promptly")
	}
}

func TestServeIdleStatusAndShutdownNeedNoCompilerOrVerifier(t *testing.T) {
	for _, ending := range []string{"eof", "shutdown", "interrupt"} {
		t.Run(ending, func(t *testing.T) {
			e, p := newEngineFixture(t, guestScenario{Value: literal{"i64", "42"}})
			// Persist success, then make both executables unavailable. Status
			// must read the durable snapshot and cannot launch a compiler.
			report := e.run(context.Background(), p.ID, false)
			if report.ErrorCode != "" {
				t.Fatalf("fixture plan failed: %+v", report)
			}
			e.config.SwypExecutable = filepath.Join(t.TempDir(), "missing-compiler")
			e.config.VerifierExecutable = filepath.Join(t.TempDir(), "missing-observer")
			input, send := io.Pipe()
			output, receive := io.Pipe()
			t.Cleanup(func() { input.Close(); send.Close(); output.Close(); receive.Close() })
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- serveCommands(ctx, cancel, e, input, receive) }()
			decoder := json.NewDecoder(output)
			var ready struct {
				Type string `json:"type"`
			}
			readControlResponse(t, decoder, &ready)
			if ready.Type != "ready" || e.verifier.process != nil || e.activeGuest != nil {
				t.Fatal("idle serve launched work or did not become ready")
			}
			if err := json.NewEncoder(send).Encode(command{Op: "status", PlanID: p.ID}); err != nil {
				t.Fatal(err)
			}
			var status runReport
			readControlResponse(t, decoder, &status)
			if status.ErrorCode != "" || status.Status == nil || status.Status.State != supervisor.StateSucceeded || status.Metrics.ProcessStarts != 0 {
				t.Fatalf("durable status tried to execute or lost completion: %+v", status)
			}
			switch ending {
			case "eof":
				_ = send.Close()
			case "shutdown":
				if err := json.NewEncoder(send).Encode(command{Op: "shutdown"}); err != nil {
					t.Fatal(err)
				}
			case "interrupt":
				// This is the cancellation delivered by main's NotifyContext.
				cancel()
			}
			awaitServeStop(t, done, ending == "interrupt")
		})
	}
}

func TestServeRejectsMalformedControlWithoutStartingWork(t *testing.T) {
	for _, raw := range []string{`{"op":"status","plan_id":"test-plan","payload":"private"}`, `{"op":"run","op":"shutdown","plan_id":"test-plan"}`, `{"op":"run","plan_id":"test-plan","signals":{}}`, strings.Repeat("x", (64<<10)+1)} {
		t.Run(fmt.Sprint(len(raw), "-", raw[:min(20, len(raw))]), func(t *testing.T) {
			e, _ := newEngineFixture(t, guestScenario{Value: literal{"i64", "42"}})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var output strings.Builder
			err := serveCommands(ctx, cancel, e, strings.NewReader(raw+"\n"), &output)
			if err == nil || e.activeGuest != nil || e.verifier.process != nil || strings.Contains(output.String(), "private") {
				t.Fatalf("malformed control accepted, launched work, or leaked payload: error=%v output=%s", err, output.String())
			}
		})
	}
}

func TestRunCommandServeStartsWithoutCompilerAndReadsDurableStatus(t *testing.T) {
	e, p := newEngineFixture(t, guestScenario{Value: literal{"i64", "42"}})
	report := e.run(context.Background(), p.ID, false)
	if report.ErrorCode != "" {
		t.Fatalf("fixture plan failed: %+v", report)
	}
	c := e.config
	if err := e.Close(); err != nil {
		t.Fatal(err)
	}
	c.SwypExecutable = filepath.Join(t.TempDir(), "unavailable-compiler")
	c.VerifierExecutable = filepath.Join(t.TempDir(), "unavailable-observer")
	c.Plans[0].Source = filepath.Join(t.TempDir(), "unavailable-source")
	if runtime.GOOS == "linux" {
		root := os.Getenv("NEXUS_TEST_CGROUP_ROOT")
		if root == "" {
			t.Skip("production CLI startup on Linux requires an explicitly delegated cgroup root")
		}
		c.LinuxCgroupRoot = root
	}
	// This is an ephemeral synthetic fixture identity, never a user key. The
	// normal configuration loader is included in this CLI-level regression.
	raw, _ := json.Marshal(c)
	path := filepath.Join(t.TempDir(), "test-host.json")
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	input, send := io.Pipe()
	output, receive := io.Pipe()
	t.Cleanup(func() { input.Close(); send.Close(); output.Close(); receive.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runCommand(ctx, []string{"--config", path, "--serve"}, input, receive) }()
	decoder := json.NewDecoder(output)
	var ready map[string]any
	readControlResponse(t, decoder, &ready)
	if ready["type"] != "ready" {
		t.Fatalf("CLI did not become ready without children: %v", ready)
	}
	if err := json.NewEncoder(send).Encode(command{Op: "status", PlanID: p.ID}); err != nil {
		t.Fatal(err)
	}
	var status runReport
	readControlResponse(t, decoder, &status)
	if status.ErrorCode != "" || status.Status == nil || status.Status.State != supervisor.StateSucceeded || status.Metrics.ProcessStarts != 0 || status.Status.FinalValueHash != report.Status.FinalValueHash {
		t.Fatalf("CLI did not read durable completion without children: %+v", status)
	}
	_ = send.Close()
	awaitServeStop(t, done, false)
}
