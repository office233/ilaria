package planapproval

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"swypik-os/core/controlkernel"
	"swypik-os/core/effects"
	"swypik-os/core/supervisor"
	wire "swypik-os/generated/swypeffects"
)

type verifierFunc func(context.Context, Revision, Proposal) (Verdict, error)

func (f verifierFunc) VerifyPlan(ctx context.Context, revision Revision, p Proposal) (Verdict, error) {
	return f(ctx, revision, p)
}

type executorFunc func(context.Context, Execution) (ExecutionResult, error)

func (f executorFunc) Execute(ctx context.Context, execution Execution) (ExecutionResult, error) {
	return f(ctx, execution)
}

type authFunc func(context.Context, string) (ApproverPrincipal, error)

func (f authFunc) AuthenticateApprover(ctx context.Context, credential string) (ApproverPrincipal, error) {
	return f(ctx, credential)
}

// These are explicit public synthetic fixtures, not compiler output, real
// independent Swyp verification, provider inference, or mobile integration.
func syntheticProposal() Proposal {
	module := []byte("public synthetic module fixture v1")
	return Proposal{Source: []byte("public synthetic source fixture v1"), Module: module,
		Plan: wire.EffectPlan{ProtocolVersion: wire.Version, ModuleHash: digest(module), Entry: "main",
			Effects: []string{"clock.read"}, CapabilityBindings: map[string]string{"main/clock.read": "clock_read"}}}
}

func syntheticVerdict(revision Revision) Verdict {
	return Verdict{Revision: revision, Decision: controlkernel.VerificationPassed,
		EvidenceHash: digest([]byte("public synthetic review:" + revision.PlanHash + revision.SourceHash))}
}

func syntheticResult(execution Execution, state string) ExecutionResult {
	s := supervisor.Snapshot{PlanHash: digest([]byte("public synthetic host policy")), TaskID: "fixture-task",
		RunID: "fixture-run", ModuleHash: execution.Revision.ModuleHash, State: state}
	if state == supervisor.StateSucceeded {
		s.FinalValueHash = digest([]byte("public synthetic terminal frame"))
	}
	if state == supervisor.StateFailed || state == supervisor.StateUncertain {
		s.FailureCode = "fixture_failure"
	}
	return ExecutionResult{Started: true, Status: s}
}

func syntheticConfig(t *testing.T) Config {
	t.Helper()
	return Config{JournalPath: filepath.Join(t.TempDir(), "approval.journal"),
		ApproverID: "host-approver", VerifierID: "host-verifier",
		Authenticator: authFunc(func(_ context.Context, credential string) (ApproverPrincipal, error) {
			if credential != "public-fixture-host-credential" {
				return ApproverPrincipal{}, errors.New("public fixture credential denied")
			}
			return ApproverPrincipal{ID: "host-approver"}, nil
		}),
		Verifier: verifierFunc(func(_ context.Context, revision Revision, p Proposal) (Verdict, error) {
			_, actual, err := pin(revision.ProposalID, revision.Number, p, DefaultLimits().MaxProposalBytes)
			if err != nil || actual != revision {
				return Verdict{}, ErrRevision
			}
			return syntheticVerdict(revision), nil
		}),
		Executor: executorFunc(func(_ context.Context, execution Execution) (ExecutionResult, error) {
			return syntheticResult(execution, supervisor.StateSucceeded), nil
		})}
}

func openTest(t *testing.T, config Config) *Coordinator {
	t.Helper()
	c, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := c.Close(); err != nil {
			t.Error(err)
		}
	})
	return c
}

func proposed(t *testing.T, c *Coordinator, id string) Snapshot {
	t.Helper()
	s, err := c.Propose(context.Background(), id, syntheticProposal())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func accepted(t *testing.T, c *Coordinator, id string) Snapshot {
	t.Helper()
	s := proposed(t, c, id)
	s, err := c.Verify(context.Background(), s.Revision)
	if err != nil {
		t.Fatal(err)
	}
	s, err = c.Accept(context.Background(), s.Revision, "host-approver", "public-fixture-host-credential")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func await[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("fixture operation did not finish")
		var zero T
		return zero
	}
}

func TestApprovalRequiresExactVerifiedRevisionAndAuthenticatedActor(t *testing.T) {
	config := syntheticConfig(t)
	var calls atomic.Int32
	config.Executor = executorFunc(func(_ context.Context, execution Execution) (ExecutionResult, error) {
		calls.Add(1)
		return syntheticResult(execution, supervisor.StateSucceeded), nil
	})
	c := openTest(t, config)
	s := proposed(t, c, "proposal")
	if _, err := c.Accept(context.Background(), s.Revision, config.ApproverID, "public-fixture-host-credential"); !errors.Is(err, ErrState) {
		t.Fatalf("approval without verification: %v", err)
	}
	if _, err := c.Execute(context.Background(), s.Revision); !errors.Is(err, ErrState) {
		t.Fatalf("execution without verification: %v", err)
	}
	verified, err := c.Verify(context.Background(), s.Revision)
	if err != nil || verified.Review == nil || verified.Review.VerifierID != config.VerifierID {
		t.Fatalf("review=%+v error=%v", verified, err)
	}
	for _, tc := range []struct{ actor, credential string }{
		{"proposal-model", "public-fixture-host-credential"},
		{config.ApproverID, "proposal says approved"},
	} {
		if _, err := c.Accept(context.Background(), s.Revision, tc.actor, tc.credential); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("untrusted approval actor=%s: %v", tc.actor, err)
		}
	}
	wrong := s.Revision
	wrong.Number++
	if _, err := c.Accept(context.Background(), wrong, config.ApproverID, "public-fixture-host-credential"); !errors.Is(err, ErrRevision) {
		t.Fatalf("wrong revision: %v", err)
	}
	if _, err := c.Execute(context.Background(), s.Revision); !errors.Is(err, ErrState) {
		t.Fatalf("execution without approval: %v", err)
	}
	approved, err := c.Accept(context.Background(), s.Revision, config.ApproverID, "public-fixture-host-credential")
	if err != nil || approved.Approval.Revision != s.Revision || calls.Load() != 0 {
		t.Fatalf("approve=%+v calls=%d err=%v", approved, calls.Load(), err)
	}
	success, err := c.Execute(context.Background(), approved.Revision)
	if err != nil || success.State != Succeeded || calls.Load() != 1 {
		t.Fatalf("success=%+v calls=%d error=%v", success, calls.Load(), err)
	}
	if _, err := c.Execute(context.Background(), approved.Revision); !errors.Is(err, ErrReplay) || calls.Load() != 1 {
		t.Fatalf("double execution: %v calls=%d", err, calls.Load())
	}
}

func TestAuthenticatedPrincipalCannotBeChosenByActorLabel(t *testing.T) {
	config := syntheticConfig(t)
	config.Authenticator = authFunc(func(context.Context, string) (ApproverPrincipal, error) {
		return ApproverPrincipal{ID: "proposal-model"}, nil
	})
	c := openTest(t, config)
	s := proposed(t, c, "proposal")
	if _, err := c.Verify(context.Background(), s.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Accept(context.Background(), s.Revision, config.ApproverID, "public-fixture-host-credential"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("actor label selected principal: %v", err)
	}
}

func TestPinnedArtifactsAndSnapshotsCannotTamperAfterApproval(t *testing.T) {
	config := syntheticConfig(t)
	p := syntheticProposal()
	wantSource, wantModule := string(p.Source), string(p.Module)
	config.Executor = executorFunc(func(_ context.Context, execution Execution) (ExecutionResult, error) {
		if string(execution.Proposal.Source) != wantSource || string(execution.Proposal.Module) != wantModule ||
			execution.Proposal.Plan.CapabilityBindings["main/clock.read"] != "clock_read" {
			return ExecutionResult{}, ErrRevision
		}
		return syntheticResult(execution, supervisor.StateSucceeded), nil
	})
	c := openTest(t, config)
	s, err := c.Propose(context.Background(), "proposal", p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Verify(context.Background(), s.Revision); err != nil {
		t.Fatal(err)
	}
	s, err = c.Accept(context.Background(), s.Revision, config.ApproverID, "public-fixture-host-credential")
	if err != nil {
		t.Fatal(err)
	}
	p.Source[0], p.Module[0] = 'X', 'X'
	p.Plan.Effects[0] = "fs.read"
	p.Plan.CapabilityBindings["main/clock.read"] = "model_grant"
	s.Plan.CapabilityBindings["main/clock.read"] = "snapshot_grant"
	s.Approval.ActorID = "proposal-model"
	s.History[len(s.History)-1].Approval.ActorID = "proposal-model"
	if result, err := c.Execute(context.Background(), s.Revision); err != nil || result.State != Succeeded {
		t.Fatalf("caller mutation changed pinned execution: %+v %v", result, err)
	}
}

func TestInternalTamperingFailsClosedBeforeAdapter(t *testing.T) {
	for _, part := range []string{"source", "module", "plan", "approval", "review"} {
		t.Run(part, func(t *testing.T) {
			config := syntheticConfig(t)
			var calls atomic.Int32
			config.Executor = executorFunc(func(_ context.Context, execution Execution) (ExecutionResult, error) {
				calls.Add(1)
				return syntheticResult(execution, supervisor.StateSucceeded), nil
			})
			c := openTest(t, config)
			s := accepted(t, c, "proposal")
			c.mu.Lock()
			p := c.entries[s.Revision.ProposalID].proposal
			switch part {
			case "source":
				p.Source[0] = 'X'
			case "module":
				p.Module[0] = 'X'
			case "plan":
				p.Plan.CapabilityBindings["main/clock.read"] = "model_grant"
			case "approval":
				c.entries[s.Revision.ProposalID].record.Approval.Revision.Number++
			case "review":
				c.entries[s.Revision.ProposalID].record.Review.Verdict.Revision.Number++
			}
			c.mu.Unlock()
			if _, err := c.Execute(context.Background(), s.Revision); err == nil || calls.Load() != 0 {
				t.Fatalf("tampered execution reached adapter: %v calls=%d", err, calls.Load())
			}
		})
	}
}

func TestCorrectionInvalidatesVerificationApprovalAndOldRequests(t *testing.T) {
	c := openTest(t, syntheticConfig(t))
	old := accepted(t, c, "proposal")
	p := syntheticProposal()
	p.Source = []byte("corrected public synthetic source")
	fresh, err := c.Correct(context.Background(), old.Revision, p)
	if err != nil || fresh.State != Proposed || fresh.Review != nil || fresh.Approval != nil ||
		fresh.Revision.Number != 2 || fresh.Revision.SourceHash == old.Revision.SourceHash {
		t.Fatalf("correction=%+v err=%v", fresh, err)
	}
	if _, err := c.Execute(context.Background(), old.Revision); !errors.Is(err, ErrRevision) {
		t.Fatalf("stale approval executed: %v", err)
	}
	if _, err := c.Accept(context.Background(), fresh.Revision, "host-approver", "public-fixture-host-credential"); !errors.Is(err, ErrState) {
		t.Fatalf("correction reused review: %v", err)
	}
	if _, err := c.Execute(context.Background(), fresh.Revision); !errors.Is(err, ErrState) {
		t.Fatalf("correction reused approval: %v", err)
	}
}

func TestCorrectionAndCancelDiscardLateVerification(t *testing.T) {
	for _, action := range []string{"correct", "cancel"} {
		t.Run(action, func(t *testing.T) {
			config := syntheticConfig(t)
			started, release := make(chan struct{}), make(chan struct{})
			config.Verifier = verifierFunc(func(_ context.Context, revision Revision, _ Proposal) (Verdict, error) {
				close(started)
				<-release
				return syntheticVerdict(revision), nil
			})
			c := openTest(t, config)
			s := proposed(t, c, "proposal")
			done := make(chan error, 1)
			go func() { _, err := c.Verify(context.Background(), s.Revision); done <- err }()
			await(t, started)
			var fresh Snapshot
			var err error
			if action == "correct" {
				fresh, err = c.Correct(context.Background(), s.Revision, syntheticProposal())
			} else {
				fresh, err = c.Cancel(context.Background(), s.Revision, config.ApproverID, "public-fixture-host-credential")
			}
			if err != nil {
				t.Fatal(err)
			}
			if action == "correct" {
				if _, err := c.Verify(context.Background(), fresh.Revision); !errors.Is(err, ErrBusy) {
					t.Fatalf("correction released an unfinished verifier slot: %v", err)
				}
			}
			close(release)
			if err := await(t, done); err == nil {
				t.Fatal("stale verification published success")
			}
			current, err := c.Status("proposal")
			if err != nil || current.Revision != fresh.Revision || current.Review != nil || current.Approval != nil ||
				current.State != fresh.State {
				t.Fatalf("stale verification modified corrected/cancelled state: %+v %v", current, err)
			}
		})
	}
}

func TestVerificationRejectionAndOperationalFailureRemainDistinct(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state State
		reply func(Revision) (Verdict, error)
	}{
		{"rejected", Rejected, func(r Revision) (Verdict, error) {
			v := syntheticVerdict(r)
			v.Decision, v.Code = controlkernel.VerificationFailed, "synthetic_contract_rejected"
			return v, nil
		}},
		{"unavailable", Failed, func(Revision) (Verdict, error) { return Verdict{}, errors.New("synthetic unavailable verifier") }},
		{"wrong_revision", Failed, func(r Revision) (Verdict, error) {
			v := syntheticVerdict(r)
			v.Revision.SourceHash = digest([]byte("different source"))
			return v, nil
		}},
		{"missing_evidence", Failed, func(r Revision) (Verdict, error) {
			v := syntheticVerdict(r)
			v.EvidenceHash = ""
			return v, nil
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config := syntheticConfig(t)
			config.Verifier = verifierFunc(func(_ context.Context, r Revision, _ Proposal) (Verdict, error) { return tc.reply(r) })
			c := openTest(t, config)
			p := proposed(t, c, "proposal")
			s, err := c.Verify(context.Background(), p.Revision)
			if !errors.Is(err, ErrVerification) || s.State != tc.state {
				t.Fatalf("state=%s err=%v", s.State, err)
			}
			if tc.state == Rejected && (s.Review == nil || s.Review.Verdict.Decision != controlkernel.VerificationFailed) {
				t.Fatal("canonical rejection evidence missing")
			}
			if _, err := c.Accept(context.Background(), p.Revision, config.ApproverID, "public-fixture-host-credential"); !errors.Is(err, ErrState) {
				t.Fatalf("rejected verification approved: %v", err)
			}
		})
	}
}

func TestDoubleExecutionConcurrentAndCorrectionAfterReservation(t *testing.T) {
	config := syntheticConfig(t)
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	config.Executor = executorFunc(func(_ context.Context, execution Execution) (ExecutionResult, error) {
		calls.Add(1)
		close(started)
		<-release
		return syntheticResult(execution, supervisor.StateSucceeded), nil
	})
	c := openTest(t, config)
	s := accepted(t, c, "proposal")
	done := make(chan error, 1)
	go func() { _, err := c.Execute(context.Background(), s.Revision); done <- err }()
	await(t, started)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Execute(context.Background(), s.Revision); !errors.Is(err, ErrReplay) {
				t.Errorf("duplicate execution: %v", err)
			}
		}()
	}
	if _, err := c.Correct(context.Background(), s.Revision, syntheticProposal()); !errors.Is(err, ErrReplay) {
		t.Fatalf("correction reopened execution reservation: %v", err)
	}
	wg.Wait()
	close(release)
	if err := await(t, done); err != nil || calls.Load() != 1 {
		t.Fatalf("calls=%d error=%v", calls.Load(), err)
	}
}

func TestCancelBeforeAndDuringExecutionIsIdempotent(t *testing.T) {
	t.Run("before", func(t *testing.T) {
		config := syntheticConfig(t)
		var calls atomic.Int32
		config.Executor = executorFunc(func(_ context.Context, execution Execution) (ExecutionResult, error) {
			calls.Add(1)
			return syntheticResult(execution, supervisor.StateSucceeded), nil
		})
		c := openTest(t, config)
		s := accepted(t, c, "proposal")
		first, err := c.Cancel(context.Background(), s.Revision, config.ApproverID, "public-fixture-host-credential")
		if err != nil || first.State != Cancelled {
			t.Fatalf("cancel: %+v %v", first, err)
		}
		second, err := c.Cancel(context.Background(), s.Revision, config.ApproverID, "public-fixture-host-credential")
		if err != nil || len(second.History) != len(first.History) {
			t.Fatalf("cancel was not idempotent: %+v %v", second, err)
		}
		if _, err := c.Execute(context.Background(), s.Revision); !errors.Is(err, ErrState) || calls.Load() != 0 {
			t.Fatalf("cancelled proposal executed: %v", err)
		}
	})
	t.Run("during", func(t *testing.T) {
		config := syntheticConfig(t)
		started, stopped := make(chan struct{}), make(chan struct{})
		config.Executor = executorFunc(func(ctx context.Context, execution Execution) (ExecutionResult, error) {
			close(started)
			<-ctx.Done()
			close(stopped)
			return syntheticResult(execution, supervisor.StateFailed), ctx.Err()
		})
		c := openTest(t, config)
		s := accepted(t, c, "proposal")
		done := make(chan Snapshot, 1)
		go func() { result, _ := c.Execute(context.Background(), s.Revision); done <- result }()
		await(t, started)
		requested, err := c.Cancel(context.Background(), s.Revision, config.ApproverID, "public-fixture-host-credential")
		if err != nil || !requested.CancelRequested || requested.State != Running {
			t.Fatalf("cancel request forged terminal stop: %+v %v", requested, err)
		}
		await(t, stopped)
		result := await(t, done)
		if result.State != Cancelled || !result.Attempted || result.Execution == nil {
			t.Fatalf("owned execution not cancelled: %+v", result)
		}
		if _, err := c.Execute(context.Background(), s.Revision); !errors.Is(err, ErrReplay) {
			t.Fatalf("cancelled execution replayed: %v", err)
		}
	})
}

func TestTimeoutQuarantinesUncooperativeCallbacksAndRefusesReplay(t *testing.T) {
	config := syntheticConfig(t)
	config.Limits = DefaultLimits()
	config.Limits.ExecuteTimeout = 30 * time.Millisecond
	started, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	config.Executor = executorFunc(func(_ context.Context, execution Execution) (ExecutionResult, error) {
		close(started)
		<-release
		defer close(finished)
		return syntheticResult(execution, supervisor.StateSucceeded), nil
	})
	c := openTest(t, config)
	s := accepted(t, c, "proposal")
	done := make(chan Snapshot, 1)
	go func() { result, _ := c.Execute(context.Background(), s.Revision); done <- result }()
	await(t, started)
	timedOut := await(t, done)
	if timedOut.State != Uncertain {
		t.Fatalf("timeout without terminal evidence=%s", timedOut.State)
	}
	if _, err := c.Execute(context.Background(), s.Revision); !errors.Is(err, ErrUncertain) {
		t.Fatalf("uncertain guest replayed: %v", err)
	}
	if _, err := c.Correct(context.Background(), s.Revision, syntheticProposal()); !errors.Is(err, ErrReplay) {
		t.Fatalf("uncertain guest reopened by correction: %v", err)
	}
	next := proposed(t, c, "second")
	if _, err := c.Verify(context.Background(), next.Revision); !errors.Is(err, ErrBusy) {
		t.Fatalf("unresponsive callback escaped concurrency bound: %v", err)
	}
	close(release)
	await(t, finished)
	current, err := c.Status("proposal")
	if err != nil || current.State != Uncertain {
		t.Fatalf("late success overwrote uncertainty: %+v %v", current, err)
	}
}

func TestVerificationTimeoutIsNotExecutionUncertainty(t *testing.T) {
	config := syntheticConfig(t)
	config.Limits = DefaultLimits()
	config.Limits.VerifyTimeout = 25 * time.Millisecond
	config.Verifier = verifierFunc(func(ctx context.Context, _ Revision, _ Proposal) (Verdict, error) {
		<-ctx.Done()
		return Verdict{}, ctx.Err()
	})
	c := openTest(t, config)
	s := proposed(t, c, "proposal")
	result, err := c.Verify(context.Background(), s.Revision)
	if !errors.Is(err, context.DeadlineExceeded) || result.State != Failed || result.Attempted {
		t.Fatalf("verification timeout=%+v error=%v", result, err)
	}
}

func TestExecutionOutcomesAndMissingAdapterFailClosed(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state State
		run   executorFunc
	}{
		{"failed", Failed, func(_ context.Context, e Execution) (ExecutionResult, error) {
			return syntheticResult(e, supervisor.StateFailed), errors.New("public fixture failure")
		}},
		{"uncertain", Uncertain, func(_ context.Context, e Execution) (ExecutionResult, error) {
			return syntheticResult(e, supervisor.StateUncertain), errors.New("public fixture uncertainty")
		}},
		{"missing_terminal", Uncertain, func(_ context.Context, e Execution) (ExecutionResult, error) {
			return syntheticResult(e, supervisor.StateRunning), nil
		}},
		{"wrong_module", Uncertain, func(_ context.Context, e Execution) (ExecutionResult, error) {
			r := syntheticResult(e, supervisor.StateSucceeded)
			r.Status.ModuleHash = digest([]byte("other module"))
			return r, nil
		}},
		{"forged_no_start_success", Uncertain, func(context.Context, Execution) (ExecutionResult, error) {
			return ExecutionResult{}, nil
		}},
		{"not_started", Failed, func(context.Context, Execution) (ExecutionResult, error) {
			return ExecutionResult{}, errors.New("public fixture launch rejected")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config := syntheticConfig(t)
			config.Executor = tc.run
			c := openTest(t, config)
			s := accepted(t, c, "proposal")
			result, err := c.Execute(context.Background(), s.Revision)
			if err == nil || result.State != tc.state {
				t.Fatalf("outcome=%+v error=%v", result, err)
			}
			if _, err := c.Execute(context.Background(), s.Revision); err == nil {
				t.Fatal("terminal outcome replayed")
			}
		})
	}
	config := syntheticConfig(t)
	config.Executor = nil
	c := openTest(t, config)
	s := accepted(t, c, "boundary-only")
	if _, err := c.Execute(context.Background(), s.Revision); !errors.Is(err, ErrExecutionUnavailable) {
		t.Fatalf("missing adapter did not surface: %v", err)
	}
	current, _ := c.Status("boundary-only")
	if current.Attempted {
		t.Fatal("missing adapter consumed a fictitious execution")
	}
}

func TestProposalCountRevisionsBytesHistoryAndPolicyAreBounded(t *testing.T) {
	config := syntheticConfig(t)
	config.Limits = DefaultLimits()
	config.Limits.MaxProposals, config.Limits.MaxRevisions, config.Limits.MaxHistory = 1, 2, 11
	c := openTest(t, config)
	s := accepted(t, c, "proposal")
	if _, err := c.Propose(context.Background(), "second", syntheticProposal()); !errors.Is(err, ErrLimit) {
		t.Fatalf("proposal count unbounded: %v", err)
	}
	fresh, err := c.Correct(context.Background(), s.Revision, syntheticProposal())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Correct(context.Background(), fresh.Revision, syntheticProposal()); !errors.Is(err, ErrLimit) {
		t.Fatalf("revision count unbounded: %v", err)
	}
	if _, err := c.Verify(context.Background(), fresh.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Accept(context.Background(), fresh.Revision, config.ApproverID, "public-fixture-host-credential"); err != nil {
		t.Fatal(err)
	}
	terminal, err := c.Execute(context.Background(), fresh.Revision)
	if err != nil || len(terminal.History) > config.Limits.MaxHistory {
		t.Fatalf("terminal history=%d error=%v", len(terminal.History), err)
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	changed := config
	changed.Limits.MaxHistory++
	if _, err := Open(changed); !errors.Is(err, ErrPolicyChanged) {
		t.Fatalf("reopen changed durable policy: %v", err)
	}
	bytesConfig := syntheticConfig(t)
	bytesCoordinator := openTest(t, bytesConfig)
	p := syntheticProposal()
	p.Source = make([]byte, effects.MaxValueBytes+1)
	if _, err := bytesCoordinator.Propose(context.Background(), "too-big", p); !errors.Is(err, ErrLimit) {
		t.Fatalf("source bytes unbounded: %v", err)
	}
	invalidLimits := syntheticConfig(t)
	invalidLimits.Limits = DefaultLimits()
	invalidLimits.Limits.MaxHistory = 1
	if _, err := Open(invalidLimits); !errors.Is(err, ErrInvalid) {
		t.Fatalf("mandatory terminal history not reserved: %v", err)
	}
}

func TestReopenIsStatusOnlyAndInterruptedExecutionIsNeverReplayed(t *testing.T) {
	config := syntheticConfig(t)
	c := openTest(t, config)
	approved := accepted(t, c, "approved")
	interrupted := accepted(t, c, "interrupted")
	// Simulate host loss immediately after the durable launch reservation.
	c.mu.Lock()
	r := cloneRecord(c.entries["interrupted"].record)
	r.State, r.Attempted = Running, true
	if err := c.append(r); err != nil {
		t.Fatal(err)
	}
	if err := c.store.Close(); err != nil {
		t.Fatal(err)
	}
	c.closed = true
	c.mu.Unlock()
	reopened := openTest(t, config)
	if _, err := reopened.Execute(context.Background(), approved.Revision); !errors.Is(err, ErrArtifactsUnavailable) {
		t.Fatalf("reopen rehydrated executable approval: %v", err)
	}
	if _, err := reopened.Execute(context.Background(), interrupted.Revision); !errors.Is(err, ErrUncertain) {
		t.Fatalf("interrupted launch replayed: %v", err)
	}
	status, _ := reopened.Status("interrupted")
	if status.State != Uncertain || status.Code != "execution_interrupted" {
		t.Fatalf("interruption not durable: %+v", status)
	}
	fresh, err := reopened.Correct(context.Background(), approved.Revision, syntheticProposal())
	if err != nil || fresh.State != Proposed || fresh.Approval != nil || fresh.Review != nil {
		t.Fatalf("status-only correction reused approval: %+v %v", fresh, err)
	}
	raw, err := os.ReadFile(config.JournalPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, secretOrContent := range []string{"public-fixture-host-credential", string(syntheticProposal().Source), string(syntheticProposal().Module)} {
		if strings.Contains(string(raw), secretOrContent) {
			t.Fatalf("journal persisted proposal content or credential: %q", secretOrContent)
		}
	}
}

func TestStorageFailureCancelsOwnedExecutionAndNeverPublishesSuccess(t *testing.T) {
	config := syntheticConfig(t)
	started, stopped := make(chan struct{}), make(chan struct{})
	config.Executor = executorFunc(func(ctx context.Context, e Execution) (ExecutionResult, error) {
		close(started)
		<-ctx.Done()
		close(stopped)
		return syntheticResult(e, supervisor.StateFailed), ctx.Err()
	})
	c := openTest(t, config)
	s := accepted(t, c, "proposal")
	done := make(chan error, 1)
	go func() { _, err := c.Execute(context.Background(), s.Revision); done <- err }()
	await(t, started)
	if err := c.store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Cancel(context.Background(), s.Revision, config.ApproverID, "public-fixture-host-credential"); err == nil {
		t.Fatal("cancel concealed journal failure")
	}
	await(t, stopped)
	if err := await(t, done); !errors.Is(err, controlkernel.ErrStorageFailed) {
		t.Fatalf("execution concealed storage failure: %v", err)
	}
	// The intentionally failed store is already closed; Close must still
	// surface its failure rather than claim that a durable terminal was saved.
	if err := c.Close(); !errors.Is(err, controlkernel.ErrStorageFailed) {
		t.Fatalf("close concealed storage failure: %v", err)
	}
}

func TestCancelRaceCannotPublishLateSuccess(t *testing.T) {
	config := syntheticConfig(t)
	started, release := make(chan struct{}), make(chan struct{})
	config.Executor = executorFunc(func(_ context.Context, e Execution) (ExecutionResult, error) {
		close(started)
		<-release
		return syntheticResult(e, supervisor.StateSucceeded), nil
	})
	c := openTest(t, config)
	s := accepted(t, c, "proposal")
	done := make(chan Snapshot, 1)
	go func() { result, _ := c.Execute(context.Background(), s.Revision); done <- result }()
	await(t, started)
	if _, err := c.Cancel(context.Background(), s.Revision, config.ApproverID, "public-fixture-host-credential"); err != nil {
		t.Fatal(err)
	}
	close(release)
	result := await(t, done)
	if result.State != Uncertain || result.Code != "cancel_raced_completion" || result.Execution == nil ||
		result.Execution.Status.State != supervisor.StateSucceeded {
		t.Fatalf("cancel race published success or lost evidence: %+v", result)
	}
}

func TestCloseCancelsOwnedExecutionAndRestoresUncertainty(t *testing.T) {
	config := syntheticConfig(t)
	started, stopped := make(chan struct{}), make(chan struct{})
	config.Executor = executorFunc(func(ctx context.Context, e Execution) (ExecutionResult, error) {
		close(started)
		<-ctx.Done()
		close(stopped)
		return syntheticResult(e, supervisor.StateSucceeded), nil
	})
	c := openTest(t, config)
	s := accepted(t, c, "proposal")
	done := make(chan error, 1)
	go func() { _, err := c.Execute(context.Background(), s.Revision); done <- err }()
	await(t, started)
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	await(t, stopped)
	if err := await(t, done); !errors.Is(err, controlkernel.ErrClosed) {
		t.Fatalf("late completion after close: %v", err)
	}
	reopened := openTest(t, config)
	current, err := reopened.Status("proposal")
	if err != nil || current.State != Uncertain || !current.Attempted {
		t.Fatalf("close lost execution reservation: %+v %v", current, err)
	}
	if _, err := reopened.Execute(context.Background(), s.Revision); !errors.Is(err, ErrUncertain) {
		t.Fatalf("closed execution replayed: %v", err)
	}
}

func TestCancellationWithoutStopProofRemainsUncertain(t *testing.T) {
	config := syntheticConfig(t)
	config.Limits = DefaultLimits()
	config.Limits.ExecuteTimeout = 2 * time.Second
	started, cancelled, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	config.Executor = executorFunc(func(ctx context.Context, e Execution) (ExecutionResult, error) {
		close(started)
		<-ctx.Done()
		close(cancelled)
		<-release
		defer close(finished)
		return syntheticResult(e, supervisor.StateFailed), ctx.Err()
	})
	c := openTest(t, config)
	s := accepted(t, c, "proposal")
	done := make(chan Snapshot, 1)
	go func() { result, _ := c.Execute(context.Background(), s.Revision); done <- result }()
	await(t, started)
	requested, err := c.Cancel(context.Background(), s.Revision, config.ApproverID, "public-fixture-host-credential")
	if err != nil {
		t.Fatal(err)
	}
	await(t, cancelled)
	result := await(t, done)
	close(release)
	await(t, finished)
	if result.State != Uncertain || result.Execution != nil ||
		requested.State == Running && !result.CancelRequested {
		t.Fatalf("cancellation signal forged stop proof: %+v", result)
	}
}

func TestVerifierCannotMutatePinnedExecutionArtifacts(t *testing.T) {
	config := syntheticConfig(t)
	config.Verifier = verifierFunc(func(_ context.Context, r Revision, p Proposal) (Verdict, error) {
		p.Source[0], p.Module[0] = 'X', 'X'
		p.Plan.CapabilityBindings["main/clock.read"] = "model_grant"
		return syntheticVerdict(r), nil
	})
	config.Executor = executorFunc(func(_ context.Context, e Execution) (ExecutionResult, error) {
		_, actual, err := pin(e.Revision.ProposalID, e.Revision.Number, e.Proposal, DefaultLimits().MaxProposalBytes)
		if err != nil || actual != e.Revision {
			return ExecutionResult{}, ErrRevision
		}
		return syntheticResult(e, supervisor.StateSucceeded), nil
	})
	c := openTest(t, config)
	s := accepted(t, c, "proposal")
	result, err := c.Execute(context.Background(), s.Revision)
	if err != nil || result.State != Succeeded {
		t.Fatalf("verifier callback mutated owned artifacts: %+v %v", result, err)
	}
}

func TestCanonicalPlanValidationAndCombinedByteBounds(t *testing.T) {
	for _, part := range []string{"module_hash", "unsupported_effect", "excess_bindings", "combined_bytes", "source_required"} {
		t.Run(part, func(t *testing.T) {
			c := openTest(t, syntheticConfig(t))
			p := syntheticProposal()
			switch part {
			case "module_hash":
				p.Plan.ModuleHash = digest([]byte("wrong module"))
			case "unsupported_effect":
				p.Plan.Effects = []string{"network.send"}
			case "excess_bindings":
				for i := 0; i <= wire.MaxPlanBindings; i++ {
					p.Plan.CapabilityBindings[strings.Repeat("x", i+1)] = "clock_read"
				}
			case "combined_bytes":
				p.Source, p.Module = make([]byte, effects.MaxValueBytes), make([]byte, effects.MaxValueBytes)
				p.Plan.ModuleHash = digest(p.Module)
			case "source_required":
				p.Source = nil
			}
			if _, err := c.Propose(context.Background(), "invalid", p); err == nil {
				t.Fatal("invalid or unbounded proposal admitted")
			}
			if _, err := c.Status("invalid"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("invalid proposal acquired state: %v", err)
			}
		})
	}
}

func TestMinimumHistoryReservesCancellationAndTerminalAtRevisionLimit(t *testing.T) {
	config := syntheticConfig(t)
	config.Limits = DefaultLimits()
	config.Limits.MaxProposals, config.Limits.MaxRevisions, config.Limits.MaxHistory = 1, 2, 11
	started := make(chan struct{})
	config.Executor = executorFunc(func(ctx context.Context, e Execution) (ExecutionResult, error) {
		close(started)
		<-ctx.Done()
		return syntheticResult(e, supervisor.StateFailed), ctx.Err()
	})
	c := openTest(t, config)
	old := accepted(t, c, "proposal")
	fresh, err := c.Correct(context.Background(), old.Revision, syntheticProposal())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Verify(context.Background(), fresh.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Accept(context.Background(), fresh.Revision, config.ApproverID, "public-fixture-host-credential"); err != nil {
		t.Fatal(err)
	}
	done := make(chan Snapshot, 1)
	go func() { result, _ := c.Execute(context.Background(), fresh.Revision); done <- result }()
	await(t, started)
	if _, err := c.Cancel(context.Background(), fresh.Revision, config.ApproverID, "public-fixture-host-credential"); err != nil {
		t.Fatal(err)
	}
	result := await(t, done)
	if result.State != Cancelled || len(result.History) != config.Limits.MaxHistory {
		t.Fatalf("terminal record did not fit exact history ceiling: state=%s history=%d", result.State, len(result.History))
	}
	repeated, err := c.Cancel(context.Background(), fresh.Revision, config.ApproverID, "public-fixture-host-credential")
	if err != nil || len(repeated.History) != config.Limits.MaxHistory {
		t.Fatalf("idempotent cancel exceeded history ceiling: %+v %v", repeated, err)
	}
	if _, err := c.Propose(context.Background(), "second", syntheticProposal()); !errors.Is(err, ErrLimit) {
		t.Fatalf("terminal tombstone lost proposal bound: %v", err)
	}
	if _, err := c.Propose(context.Background(), "proposal", syntheticProposal()); !errors.Is(err, ErrState) {
		t.Fatalf("terminal proposal ID recycled: %v", err)
	}
}

func TestReopenRejectsMalformedApprovalEvenInValidJournalFrame(t *testing.T) {
	config := syntheticConfig(t)
	c := openTest(t, config)
	s := proposed(t, c, "proposal")
	forged := cloneRecord(s.Record)
	forged.State = Approved
	forged.Approval = &Approval{Revision: s.Revision, ActorID: config.ApproverID}
	raw, err := json.Marshal(forged)
	if err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	_, err = c.store.Append(ledgerStream, c.sequence, controlkernel.Event{Type: eventRecord, Data: raw})
	if err == nil {
		err = c.store.Close()
	}
	c.closed = true
	c.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open(config); !errors.Is(err, controlkernel.ErrCorruptJournal) {
		t.Fatalf("journal checksum alone authorized an unverified approval: %v", err)
	}
}
