package planapproval

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"swypik-os/core/controlkernel"
	"swypik-os/core/effects"
	"swypik-os/core/supervisor"
	wire "swypik-os/generated/swypeffects"
)

type guestFunc func(context.Context, Execution, EffectHandler) (string, error)

func (f guestFunc) Run(ctx context.Context, execution Execution, handle EffectHandler) (string, error) {
	return f(ctx, execution, handle)
}

type fixtureKernelAuthentication struct{}

func (fixtureKernelAuthentication) AuthenticateExecutor(credential string) (controlkernel.ExecutorPrincipal, error) {
	if credential != "public-fixture-executor-credential" {
		return controlkernel.ExecutorPrincipal{}, controlkernel.ErrExecutorUnauthorized
	}
	return controlkernel.ExecutorPrincipal{ID: "fixture-executor"}, nil
}

func (fixtureKernelAuthentication) AuthenticateVerifier(credential string) (controlkernel.VerifierPrincipal, error) {
	if credential != "public-fixture-verifier-credential" {
		return controlkernel.VerifierPrincipal{}, controlkernel.ErrVerifierUnauthorized
	}
	return controlkernel.VerifierPrincipal{ID: "fixture-effect-verifier"}, nil
}

type fixtureEffectVerifier struct{}

func (fixtureEffectVerifier) Verify(_ context.Context, request wire.EffectRequest, result wire.EffectResult,
	receipt wire.EffectReceipt, expected effects.Binding) (supervisor.Verification, error) {
	requestHash, err := effects.RequestHash(request)
	if err != nil {
		return supervisor.Verification{}, err
	}
	resultHash, err := effects.ResultHash(result)
	if err != nil {
		return supervisor.Verification{}, err
	}
	signingBytes, err := effects.ReceiptSigningBytes(receipt)
	if err != nil {
		return supervisor.Verification{}, err
	}
	// This deterministic public fixture is not the real independent Ilaria
	// evidence verifier. The supervisor still checks receipt signature/binding.
	return supervisor.Verification{Verified: true, RequestHash: requestHash, ResultHash: resultHash,
		ReceiptHash: digest(signingBytes), Expected: expected}, nil
}

type fixtureNoFilesystem struct{}

func (fixtureNoFilesystem) Read(context.Context, string, string, int64) ([]byte, error) {
	return nil, errors.New("public fixture has no filesystem authority")
}

type blockingFixtureEffectVerifier struct{ started chan struct{} }

func (v blockingFixtureEffectVerifier) Verify(ctx context.Context, _ wire.EffectRequest, _ wire.EffectResult,
	_ wire.EffectReceipt, _ effects.Binding) (supervisor.Verification, error) {
	close(v.started)
	<-ctx.Done()
	return supervisor.Verification{}, ctx.Err()
}

func realSupervisorPolicy(t *testing.T) (supervisor.Config, *controlkernel.Kernel) {
	t.Helper()
	dir := t.TempDir()
	kernel, err := controlkernel.OpenKernel(filepath.Join(dir, "kernel.journal"),
		controlkernel.WithExecutorAuthenticator(fixtureKernelAuthentication{}),
		controlkernel.WithVerifierAuthenticator(fixtureKernelAuthentication{}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := kernel.Close(); err != nil {
			t.Error(err)
		}
	})
	p := syntheticProposal()
	return supervisor.Config{Kernel: kernel, LedgerPath: filepath.Join(dir, "supervisor.journal"),
		ExecutionPolicyHash: digest([]byte("public explicit host policy fixture")),
		SignerKeyID:         "public-fixture-signing-key",
		PrivateKey:          ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, ed25519.SeedSize)),
		ExecutorID:          "fixture-executor", ExecutorCredential: "public-fixture-executor-credential",
		VerifierID: "fixture-effect-verifier", VerifierCredential: "public-fixture-verifier-credential",
		Verifier: fixtureEffectVerifier{}, Reader: fixtureNoFilesystem{},
		Plan: supervisor.Plan{TaskID: "fixture-task", RunID: "fixture-run", ModuleHash: p.Plan.ModuleHash, Entry: p.Plan.Entry,
			Effects: p.Plan.Effects, Bindings: []supervisor.Binding{{Function: "main", Effect: "clock.read", Capability: "clock_read"}},
			MaxEffects: 2, FuelLimit: 1000, MaxEffectBytes: 1024, Deadline: time.Now().Add(time.Minute)},
		Scopes: []supervisor.Scope{{Function: "main", Effect: "clock.read", Capability: "clock_read"}},
	}, kernel
}

// This is a real local supervisor/kernel/broker smoke with a synthetic guest
// and public fixture verifier, not real compiler/model/mobile execution.
func TestSupervisorAdapterRealDurableClockEffectAndDuplicateRefusal(t *testing.T) {
	host, kernel := realSupervisorPolicy(t)
	var guests atomic.Int32
	var evidence supervisor.Evidence
	adapter, err := NewSupervisorExecutor(func(context.Context, Execution) (supervisor.Config, error) {
		return host, nil
	}, guestFunc(func(ctx context.Context, execution Execution, handle EffectHandler) (string, error) {
		guests.Add(1)
		var err error
		evidence, err = handle(ctx, wire.EffectRequest{ProtocolVersion: wire.Version, RequestID: host.Plan.RunID + ":1",
			ModuleHash: execution.Revision.ModuleHash, Function: "main", Effect: "clock.read", Capability: "clock_read"})
		if err != nil {
			return "", err
		}
		return digest([]byte("public validated synthetic terminal frame")), nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	config := syntheticConfig(t)
	config.Executor = adapter
	c := openTest(t, config)
	s := accepted(t, c, "proposal")
	result, err := c.Execute(context.Background(), s.Revision)
	if err != nil || result.State != Succeeded || result.Execution.Status.Committed != 1 ||
		evidence.NodeState != controlkernel.NodeSucceeded || len(evidence.Receipt.Signature) != ed25519.SignatureSize {
		t.Fatalf("real supervisor result=%+v evidence=%+v error=%v", result, evidence, err)
	}
	intent, exists := kernel.IntentByKey("effect:v1:" + host.Plan.RunID + ":1")
	if !exists || intent.State != controlkernel.IntentCommitted {
		t.Fatalf("real broker intent not durably committed: %+v", intent)
	}
	if _, err := c.Execute(context.Background(), s.Revision); !errors.Is(err, ErrReplay) {
		t.Fatalf("coordinator allowed duplicate execution: %v", err)
	}
	// Even a fresh proposal cannot replay the existing host-owned supervisor
	// ledger/task/run. Durable execution ownership is still the supervisor's.
	fresh := accepted(t, c, "new-proposal-same-host-run")
	duplicate, err := c.Execute(context.Background(), fresh.Revision)
	if !errors.Is(err, supervisor.ErrRecoveryRequired) || duplicate.State != Uncertain || guests.Load() != 1 {
		t.Fatalf("durable supervisor replay: %+v err=%v guests=%d", duplicate, err, guests.Load())
	}
}

func TestSupervisorAdapterCancelStopsGuestAndDurablyAborts(t *testing.T) {
	host, _ := realSupervisorPolicy(t)
	started, stopped := make(chan struct{}), make(chan struct{})
	adapter, err := NewSupervisorExecutor(func(context.Context, Execution) (supervisor.Config, error) {
		return host, nil
	}, guestFunc(func(ctx context.Context, _ Execution, _ EffectHandler) (string, error) {
		close(started)
		<-ctx.Done()
		close(stopped)
		return "", ctx.Err()
	}))
	if err != nil {
		t.Fatal(err)
	}
	config := syntheticConfig(t)
	config.Executor = adapter
	c := openTest(t, config)
	s := accepted(t, c, "proposal")
	done := make(chan Snapshot, 1)
	go func() { result, _ := c.Execute(context.Background(), s.Revision); done <- result }()
	await(t, started)
	if _, err := c.Cancel(context.Background(), s.Revision, config.ApproverID, "public-fixture-host-credential"); err != nil {
		t.Fatal(err)
	}
	await(t, stopped)
	result := await(t, done)
	if result.State != Cancelled || result.Execution == nil || result.Execution.Status.State != supervisor.StateFailed ||
		result.Execution.Status.FailureCode != "guest_cancelled" {
		t.Fatalf("cancel did not durably abort supervisor: %+v", result)
	}
	reopened, err := supervisor.Open(host)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.Status().State != supervisor.StateFailed {
		t.Fatalf("abort was not durable: %+v", reopened.Status())
	}
}

func TestSupervisorAdapterRejectsHostPlanSubstitutionAndRequiresPolicyRunner(t *testing.T) {
	if _, err := NewSupervisorExecutor(nil, guestFunc(func(context.Context, Execution, EffectHandler) (string, error) {
		return "", nil
	})); !errors.Is(err, ErrExecutionUnavailable) {
		t.Fatalf("missing host policy: %v", err)
	}
	if _, err := NewSupervisorExecutor(func(context.Context, Execution) (supervisor.Config, error) {
		return supervisor.Config{}, nil
	}, nil); !errors.Is(err, ErrExecutionUnavailable) {
		t.Fatalf("missing host runner: %v", err)
	}
	for _, part := range []string{"module", "entry", "binding", "effect", "policy", "continuation"} {
		t.Run(part, func(t *testing.T) {
			host, _ := realSupervisorPolicy(t)
			var calls atomic.Int32
			adapter, err := NewSupervisorExecutor(func(context.Context, Execution) (supervisor.Config, error) {
				switch part {
				case "module":
					host.Plan.ModuleHash = digest([]byte("substitute module"))
				case "entry":
					host.Plan.Entry = "substitute"
				case "binding":
					host.Plan.Bindings[0].Capability = "substitute"
				case "effect":
					host.Plan.Effects = []string{"fs.read"}
				case "policy":
					host.ExecutionPolicyHash = ""
				case "continuation":
					host.Continuation.Enabled = true
				}
				return host, nil
			}, guestFunc(func(context.Context, Execution, EffectHandler) (string, error) {
				calls.Add(1)
				return digest([]byte("synthetic terminal")), nil
			}))
			if err != nil {
				t.Fatal(err)
			}
			config := syntheticConfig(t)
			config.Executor = adapter
			c := openTest(t, config)
			s := accepted(t, c, "proposal")
			result, err := c.Execute(context.Background(), s.Revision)
			if err == nil || result.State != Failed || calls.Load() != 0 {
				t.Fatalf("host substitution reached guest: %+v err=%v calls=%d", result, err, calls.Load())
			}
		})
	}
}

func TestSupervisorAdapterCancelDuringUncommittedEffectStaysUncertain(t *testing.T) {
	host, _ := realSupervisorPolicy(t)
	started := make(chan struct{})
	host.Verifier = blockingFixtureEffectVerifier{started: started}
	adapter, err := NewSupervisorExecutor(func(context.Context, Execution) (supervisor.Config, error) {
		return host, nil
	}, guestFunc(func(ctx context.Context, e Execution, handle EffectHandler) (string, error) {
		_, err := handle(ctx, wire.EffectRequest{ProtocolVersion: wire.Version, RequestID: host.Plan.RunID + ":1",
			ModuleHash: e.Revision.ModuleHash, Function: "main", Effect: "clock.read", Capability: "clock_read"})
		return "", err
	}))
	if err != nil {
		t.Fatal(err)
	}
	config := syntheticConfig(t)
	config.Executor = adapter
	c := openTest(t, config)
	s := accepted(t, c, "proposal")
	done := make(chan Snapshot, 1)
	go func() { result, _ := c.Execute(context.Background(), s.Revision); done <- result }()
	await(t, started)
	if _, err := c.Cancel(context.Background(), s.Revision, config.ApproverID, "public-fixture-host-credential"); err != nil {
		t.Fatal(err)
	}
	result := await(t, done)
	if result.State != Uncertain || result.Execution == nil || result.Execution.Status.State != supervisor.StateUncertain ||
		result.Execution.Status.Issued != 1 || result.Execution.Status.Committed != 0 {
		t.Fatalf("cancel erased unresolved real effect: %+v", result)
	}
	if _, err := c.Execute(context.Background(), s.Revision); !errors.Is(err, ErrUncertain) {
		t.Fatalf("uncommitted real effect was replayable: %v", err)
	}
}
