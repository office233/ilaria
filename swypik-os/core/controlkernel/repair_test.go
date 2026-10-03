package controlkernel

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func reopenRepairKernel(t *testing.T, path string, clock *fakeClock) *Kernel {
	t.Helper()
	authenticator := testVerifierAuthenticator{
		"verifier-credential": "verifier-independent",
		"executor-credential": "executor",
	}
	kernel, err := OpenKernel(path,
		WithClock(clock.Now),
		WithExecutorAuthenticator(authenticator),
		WithVerifierAuthenticator(authenticator),
	)
	if err != nil {
		t.Fatal(err)
	}
	return kernel
}

func advanceToVerifying(t *testing.T, kernel *Kernel, nodeID string, token LeaseToken) {
	t.Helper()
	for _, state := range []NodeState{NodePreparing, NodeExecuting, NodeVerifying} {
		if err := kernel.TransitionNode(nodeID, state, token); err != nil {
			t.Fatal(err)
		}
	}
}

func TestQAA1VerificationIsBoundToAuthenticatedCurrentEpoch(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 19, 0, 0, 0, time.UTC)}
	kernel, _ := openTestKernel(t, clock)
	defer kernel.Close()
	createReadyNode(t, kernel, "task", "node")

	first, err := kernel.ClaimLease("node", "executor-credential", "executor", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	firstToken := LeaseToken{LeaseID: first.ID, Fence: first.Fence}
	advanceToVerifying(t, kernel, "node", firstToken)

	if _, err := kernel.RecordVerification("forged-credential", VerificationRequest{
		NodeID:       "node",
		Decision:     VerificationPassed,
		EvidenceHash: "sha256:forged",
	}); !errors.Is(err, ErrVerifierUnauthorized) {
		t.Fatalf("forged verifier credential error=%v, want ErrVerifierUnauthorized", err)
	}
	if _, err := kernel.RecordVerification("executor-credential", VerificationRequest{
		NodeID:       "node",
		Decision:     VerificationPassed,
		EvidenceHash: "sha256:self",
	}); !errors.Is(err, ErrConflict) {
		t.Fatalf("executor self-verification error=%v, want ErrConflict", err)
	}
	firstVerification, err := kernel.RecordVerification("verifier-credential", VerificationRequest{
		NodeID:       "node",
		Decision:     VerificationPassed,
		EvidenceHash: "sha256:first-attempt",
	})
	if err != nil {
		t.Fatal(err)
	}
	if firstVerification.AttemptID != first.AttemptID || firstVerification.LeaseID != first.ID || firstVerification.Fence != first.Fence || firstVerification.VerifierID != "verifier-independent" {
		t.Fatalf("verification not bound to first epoch: %+v lease=%+v", firstVerification, first)
	}

	clock.Add(6 * time.Second)
	if err := kernel.RequeueExpiredLease("node"); err != nil {
		t.Fatal(err)
	}
	second, err := kernel.ClaimLease("node", "executor-credential", "executor", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if second.AttemptID == first.AttemptID || second.Fence == first.Fence {
		t.Fatalf("retry reused execution epoch: first=%+v second=%+v", first, second)
	}
	secondToken := LeaseToken{LeaseID: second.ID, Fence: second.Fence}
	advanceToVerifying(t, kernel, "node", secondToken)
	if err := kernel.TransitionNode("node", NodeCommitting, secondToken); !errors.Is(err, ErrConflict) {
		t.Fatalf("historical PASS authorized retry: %v", err)
	}
	secondVerification, err := kernel.RecordVerification("verifier-credential", VerificationRequest{
		NodeID:       "node",
		Decision:     VerificationPassed,
		EvidenceHash: "sha256:second-attempt",
	})
	if err != nil {
		t.Fatal(err)
	}
	if secondVerification.AttemptID != second.AttemptID || secondVerification.LeaseID != second.ID || secondVerification.Fence != second.Fence || secondVerification.EvidenceHash != "sha256:second-attempt" {
		t.Fatalf("verification not bound to second epoch: %+v lease=%+v", secondVerification, second)
	}
	if err := kernel.TransitionNode("node", NodeCommitting, secondToken); err != nil {
		t.Fatal(err)
	}
}

func TestQAA2PreparedIntentRebindsSafelyAfterCrash(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 19, 10, 0, 0, time.UTC)}
	kernel, path := openTestKernel(t, clock)
	createReadyNode(t, kernel, "task", "node")
	first, err := kernel.ClaimLease("node", "executor-credential", "worker-a", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	firstToken := LeaseToken{LeaseID: first.ID, Fence: first.Fence}
	if err := kernel.TransitionNode("node", NodePreparing, firstToken); err != nil {
		t.Fatal(err)
	}
	spec := Intent{TaskID: "task", NodeID: "node", Kind: "process.exec", IdempotencyKey: "prepared-rebind", RequestHash: "sha256:request"}
	prepared, created, err := kernel.PrepareIntent(spec, firstToken)
	if err != nil || !created {
		t.Fatalf("prepare created=%v err=%v", created, err)
	}
	if err := kernel.Close(); err != nil {
		t.Fatal(err)
	}
	clock.Add(6 * time.Second)
	kernel = reopenRepairKernel(t, path, clock)
	defer kernel.Close()
	if err := kernel.RequeueExpiredLease("node"); err != nil {
		t.Fatal(err)
	}
	second, err := kernel.ClaimLease("node", "executor-credential", "worker-b", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	secondToken := LeaseToken{LeaseID: second.ID, Fence: second.Fence}
	if err := kernel.TransitionNode("node", NodePreparing, secondToken); err != nil {
		t.Fatal(err)
	}
	rebound, created, err := kernel.PrepareIntent(spec, secondToken)
	if err != nil || created || rebound.ID != prepared.ID {
		t.Fatalf("prepared rebind=%+v created=%v err=%v", rebound, created, err)
	}
	if rebound.AttemptID != second.AttemptID || rebound.LeaseID != second.ID || rebound.Fence != second.Fence || rebound.State != IntentPrepared {
		t.Fatalf("prepared intent not rebound to new epoch: %+v second=%+v", rebound, second)
	}
	if err := kernel.TransitionNode("node", NodeExecuting, secondToken); err != nil {
		t.Fatal(err)
	}
	started, err := kernel.StartIntent(rebound.ID, secondToken)
	if err != nil || started.State != IntentStarted {
		t.Fatalf("rebound PREPARED could not start safely: %+v err=%v", started, err)
	}
}

func TestQAA2CommittingCrashRecoveryIsTotal(t *testing.T) {
	t.Run("committed intent finalizes node", func(t *testing.T) {
		clock := &fakeClock{now: time.Date(2026, 9, 28, 19, 20, 0, 0, time.UTC)}
		kernel, path := openTestKernel(t, clock)
		createReadyNode(t, kernel, "task", "node")
		lease, err := kernel.ClaimLease("node", "executor-credential", "executor", 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		token := LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
		if err := kernel.TransitionNode("node", NodePreparing, token); err != nil {
			t.Fatal(err)
		}
		intent, _, err := kernel.PrepareIntent(Intent{TaskID: "task", NodeID: "node", Kind: "provider.dispatch", IdempotencyKey: "commit-crash", RequestHash: "sha256:req"}, token)
		if err != nil {
			t.Fatal(err)
		}
		if err := kernel.TransitionNode("node", NodeExecuting, token); err != nil {
			t.Fatal(err)
		}
		if _, err := kernel.StartIntent(intent.ID, token); err != nil {
			t.Fatal(err)
		}
		if _, err := kernel.RecordIntentResult(intent.ID, token, "provider:42", "sha256:result"); err != nil {
			t.Fatal(err)
		}
		if err := kernel.TransitionNode("node", NodeVerifying, token); err != nil {
			t.Fatal(err)
		}
		if _, err := kernel.RecordVerification("verifier-credential", VerificationRequest{NodeID: "node", Decision: VerificationPassed, EvidenceHash: "sha256:evidence"}); err != nil {
			t.Fatal(err)
		}
		if err := kernel.TransitionNode("node", NodeCommitting, token); err != nil {
			t.Fatal(err)
		}
		if _, err := kernel.CommitIntent(intent.ID, token); err != nil {
			t.Fatal(err)
		}
		if err := kernel.Close(); err != nil {
			t.Fatal(err)
		}
		clock.Add(6 * time.Second)
		kernel = reopenRepairKernel(t, path, clock)
		defer kernel.Close()
		if err := kernel.RequeueExpiredLease("node"); err != nil {
			t.Fatal(err)
		}
		node, _ := kernel.Node("node")
		if node.State != NodeSucceeded {
			t.Fatalf("COMMITTING recovery state=%s, want SUCCEEDED", node.State)
		}
	})

	t.Run("uncommitted result reconciles without replay", func(t *testing.T) {
		clock := &fakeClock{now: time.Date(2026, 9, 28, 19, 30, 0, 0, time.UTC)}
		kernel, path := openTestKernel(t, clock)
		createReadyNode(t, kernel, "task", "node")
		lease, err := kernel.ClaimLease("node", "executor-credential", "executor", 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		token := LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
		if err := kernel.TransitionNode("node", NodePreparing, token); err != nil {
			t.Fatal(err)
		}
		intent, _, err := kernel.PrepareIntent(Intent{TaskID: "task", NodeID: "node", Kind: "provider.dispatch", IdempotencyKey: "result-crash", RequestHash: "sha256:req"}, token)
		if err != nil {
			t.Fatal(err)
		}
		if err := kernel.TransitionNode("node", NodeExecuting, token); err != nil {
			t.Fatal(err)
		}
		if _, err := kernel.StartIntent(intent.ID, token); err != nil {
			t.Fatal(err)
		}
		if _, err := kernel.RecordIntentResult(intent.ID, token, "provider:43", "sha256:result-43"); err != nil {
			t.Fatal(err)
		}
		if err := kernel.TransitionNode("node", NodeVerifying, token); err != nil {
			t.Fatal(err)
		}
		if _, err := kernel.RecordVerification("verifier-credential", VerificationRequest{NodeID: "node", Decision: VerificationPassed, EvidenceHash: "sha256:evidence-43"}); err != nil {
			t.Fatal(err)
		}
		if err := kernel.TransitionNode("node", NodeCommitting, token); err != nil {
			t.Fatal(err)
		}
		if err := kernel.Close(); err != nil {
			t.Fatal(err)
		}
		clock.Add(6 * time.Second)
		kernel = reopenRepairKernel(t, path, clock)
		defer kernel.Close()
		if err := kernel.RequeueExpiredLease("node"); err != nil {
			t.Fatal(err)
		}
		node, _ := kernel.Node("node")
		stored, _ := kernel.IntentByKey("result-crash")
		if node.State != NodeReconciling || stored.State != IntentReconciling {
			t.Fatalf("RESULT crash did not reconcile: node=%+v intent=%+v", node, stored)
		}
		if _, err := kernel.CommitReconciledIntent(stored.ID, "provider:different", "sha256:different"); !errors.Is(err, ErrConflict) {
			t.Fatalf("conflicting reconciliation evidence error=%v, want ErrConflict", err)
		}
		committed, err := kernel.CommitReconciledIntent(stored.ID, "", "")
		if err != nil || committed.State != IntentCommitted || committed.ExternalRef != "provider:43" || committed.ResultHash != "sha256:result-43" {
			t.Fatalf("recorded RESULT not finalized exactly once: %+v err=%v", committed, err)
		}
		if err := kernel.TransitionNode("node", NodeSucceeded, LeaseToken{}); err != nil {
			t.Fatal(err)
		}
	})
}

func TestQAA3UnresolvedExternalRealityCannotTerminalize(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 19, 40, 0, 0, time.UTC)}
	kernel, _ := openTestKernel(t, clock)
	defer kernel.Close()
	createReadyNode(t, kernel, "task", "node")
	lease, err := kernel.ClaimLease("node", "executor-credential", "worker", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	token := LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	if err := kernel.TransitionNode("node", NodePreparing, token); err != nil {
		t.Fatal(err)
	}
	intent, _, err := kernel.PrepareIntent(Intent{TaskID: "task", NodeID: "node", Kind: "provider.dispatch", IdempotencyKey: "terminal-guard", RequestHash: "sha256:req"}, token)
	if err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", NodeExecuting, token); err != nil {
		t.Fatal(err)
	}
	if _, err := kernel.StartIntent(intent.ID, token); err != nil {
		t.Fatal(err)
	}
	for _, terminal := range []NodeState{NodeFailed, NodeCancelled, NodeBlocked} {
		if err := kernel.TransitionNode("node", terminal, token); !errors.Is(err, ErrConflict) {
			t.Fatalf("STARTED intent allowed terminal %s: %v", terminal, err)
		}
	}
	if _, err := kernel.MarkIntentUncertain(intent.ID, token); err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", NodeUncertain, token); err != nil {
		t.Fatal(err)
	}
	for _, terminal := range []NodeState{NodeFailed, NodeCancelled, NodeBlocked} {
		if err := kernel.TransitionNode("node", terminal, LeaseToken{}); !errors.Is(err, ErrConflict) {
			t.Fatalf("UNCERTAIN intent allowed terminal %s: %v", terminal, err)
		}
	}
	reconciling, err := kernel.BeginReconciliation(intent.ID)
	if err != nil || reconciling.State != IntentReconciling {
		t.Fatalf("begin reconciliation=%+v err=%v", reconciling, err)
	}
	for _, terminal := range []NodeState{NodeFailed, NodeCancelled, NodeBlocked} {
		if err := kernel.TransitionNode("node", terminal, LeaseToken{}); !errors.Is(err, ErrConflict) {
			t.Fatalf("RECONCILING intent allowed terminal %s: %v", terminal, err)
		}
	}
	if err := kernel.TransitionNode("node", NodeOperatorRequired, LeaseToken{}); err != nil {
		t.Fatalf("explicit operator escalation rejected: %v", err)
	}
}

func TestQAA4TopologyFreezesBeforeScheduling(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 19, 50, 0, 0, time.UTC)}
	kernel, _ := openTestKernel(t, clock)
	defer kernel.Close()
	if _, err := kernel.CreateTask(Task{ID: "task", Goal: "freeze topology"}); err != nil {
		t.Fatal(err)
	}
	for _, node := range []Node{{ID: "a", TaskID: "task"}, {ID: "b", TaskID: "task"}} {
		if _, err := kernel.AddNode(node); err != nil {
			t.Fatal(err)
		}
	}
	if err := kernel.TransitionNode("b", NodeReady, LeaseToken{}); err != nil {
		t.Fatal(err)
	}
	task, _ := kernel.Task("task")
	if !task.TopologyFrozen {
		t.Fatal("task topology was not frozen atomically before READY")
	}
	if _, err := kernel.AddEdge(Edge{ID: "a-b", TaskID: "task", From: "a", To: "b"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("retroactive dependency accepted after READY: %v", err)
	}
	if _, err := kernel.AddNode(Node{ID: "c", TaskID: "task"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("node added after topology freeze: %v", err)
	}
	if _, err := kernel.ClaimLease("b", "executor-credential", "worker", time.Minute); err != nil {
		t.Fatal(err)
	}
}

func TestQAA5AttemptEpochIsKernelOwnedUniqueAndValidated(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 20, 0, 0, 0, time.UTC)}
	kernel, path := openTestKernel(t, clock)
	createReadyNode(t, kernel, "task", "node")
	lease, err := kernel.ClaimLease("node", "executor-credential", "worker", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	token := LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	current := kernel.projection.Attempts[lease.AttemptID]
	if current.ID == "" || current.Number <= 0 || current.Fence != lease.Fence || current.LeaseID != lease.ID || current.Status != AttemptPreparing {
		t.Fatalf("invalid kernel-minted attempt: %+v lease=%+v", current, lease)
	}
	if _, err := kernel.RecordAttempt(Attempt{ID: "caller-forged", NodeID: "node", Number: current.Number, Status: AttemptPreparing}, token); !errors.Is(err, ErrConflict) {
		t.Fatalf("caller forged duplicate attempt epoch: %v", err)
	}
	if _, err := kernel.RecordAttempt(Attempt{NodeID: "node", Status: AttemptStatus("INVALID")}, token); !errors.Is(err, ErrConflict) {
		t.Fatalf("invalid attempt status accepted: %v", err)
	}
	if got, err := kernel.RecordAttempt(Attempt{NodeID: "node", ID: current.ID, Number: current.Number, Status: current.Status}, token); err != nil || got.ID != current.ID {
		t.Fatalf("current kernel-owned attempt not queryable: %+v err=%v", got, err)
	}
	if err := kernel.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := OpenEventStore(path)
	if err != nil {
		t.Fatal(err)
	}
	duplicate := current
	duplicate.ID = "duplicate-attempt-event"
	raw, _ := json.Marshal(duplicate)
	if _, err := store.Append(controlStream, store.Sequence(controlStream), Event{Type: eventAttemptRecorded, Data: raw}); err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	broken, err := OpenKernel(path, WithClock(clock.Now), WithVerifierAuthenticator(testVerifierAuthenticator{"verifier-credential": "verifier-independent"}))
	if broken != nil {
		_ = broken.Close()
	}
	if err == nil {
		t.Fatal("replay accepted duplicate durable attempt number/epoch")
	}
}

func TestVerifierFailsClosedWithoutAuthenticator(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 20, 10, 0, 0, time.UTC)}
	path, err := filepath.Abs(filepath.Join(t.TempDir(), "no-verifier-auth.journal"))
	if err != nil {
		t.Fatal(err)
	}
	kernel, err := OpenKernel(path,
		WithClock(clock.Now),
		WithExecutorAuthenticator(testVerifierAuthenticator{"executor-credential": "executor"}),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer kernel.Close()
	createReadyNode(t, kernel, "task", "node")
	lease, err := kernel.ClaimLease("node", "executor-credential", "executor", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	token := LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	advanceToVerifying(t, kernel, "node", token)
	if _, err := kernel.RecordVerification("anything", VerificationRequest{NodeID: "node", Decision: VerificationPassed, EvidenceHash: "sha256:evidence"}); !errors.Is(err, ErrVerifierUnauthorized) {
		t.Fatalf("kernel without verifier authority accepted verdict: %v", err)
	}
}

func TestQAA1ExecutorAliasCannotConfuseVerifierIdentity(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 20, 20, 0, 0, time.UTC)}
	kernel, _ := openTestKernel(t, clock)
	defer kernel.Close()
	createReadyNode(t, kernel, "task", "node")

	if _, err := kernel.ClaimLease("node", "forged-executor-credential", "executor-alias", time.Minute); !errors.Is(err, ErrExecutorUnauthorized) {
		t.Fatalf("forged executor credential error=%v, want ErrExecutorUnauthorized", err)
	}

	lease, err := kernel.ClaimLease("node", "executor-credential", "executor-alias", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if lease.Owner != "executor-alias" || lease.ExecutorID != "executor" {
		t.Fatalf("lease did not separate display alias from authenticated executor identity: %+v", lease)
	}
	token := LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	advanceToVerifying(t, kernel, "node", token)

	if _, err := kernel.RecordVerification("executor-credential", VerificationRequest{
		NodeID:       "node",
		Decision:     VerificationPassed,
		EvidenceHash: "sha256:self-via-alias",
	}); !errors.Is(err, ErrConflict) {
		t.Fatalf("same executor principal self-verified via different owner alias: %v", err)
	}
	if _, err := kernel.RecordVerification("verifier-credential", VerificationRequest{
		NodeID:       "node",
		Decision:     VerificationPassed,
		EvidenceHash: "sha256:independent",
	}); err != nil {
		t.Fatalf("independent verifier rejected after alias-confusion guard: %v", err)
	}
}
