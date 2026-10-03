package controlkernel

import (
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

type testVerifierAuthenticator map[string]string

func (a testVerifierAuthenticator) AuthenticateVerifier(credential string) (VerifierPrincipal, error) {
	id, ok := a[credential]
	if !ok {
		return VerifierPrincipal{}, fmt.Errorf("invalid verifier credential")
	}
	return VerifierPrincipal{ID: id}, nil
}

func (a testVerifierAuthenticator) AuthenticateExecutor(credential string) (ExecutorPrincipal, error) {
	id, ok := a[credential]
	if !ok {
		return ExecutorPrincipal{}, fmt.Errorf("invalid executor credential")
	}
	return ExecutorPrincipal{ID: id}, nil
}

type fakeClock struct {
	now time.Time
}

func (c *fakeClock) Now() time.Time { return c.now }
func (c *fakeClock) Add(d time.Duration) {
	c.now = c.now.Add(d)
}

func openTestKernel(t *testing.T, clock *fakeClock) (*Kernel, string) {
	t.Helper()
	path, err := filepath.Abs(filepath.Join(t.TempDir(), "kernel.journal"))
	if err != nil {
		t.Fatal(err)
	}
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
	return kernel, path
}

func createReadyNode(t *testing.T, kernel *Kernel, taskID, nodeID string) {
	t.Helper()
	if _, err := kernel.CreateTask(Task{ID: taskID, Goal: "test durable control kernel"}); err != nil {
		t.Fatal(err)
	}
	if _, err := kernel.AddNode(Node{ID: nodeID, TaskID: taskID, Kind: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode(nodeID, NodeReady, LeaseToken{}); err != nil {
		t.Fatal(err)
	}
}

func TestInvalidTransitionDoesNotMutateNode(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 18, 0, 0, 0, time.UTC)}
	kernel, _ := openTestKernel(t, clock)
	defer kernel.Close()
	if _, err := kernel.CreateTask(Task{ID: "task", Goal: "invalid transition"}); err != nil {
		t.Fatal(err)
	}
	if _, err := kernel.AddNode(Node{ID: "node", TaskID: "task"}); err != nil {
		t.Fatal(err)
	}

	err := kernel.TransitionNode("node", NodeExecuting, LeaseToken{})
	if !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("error=%v, want ErrInvalidTransition", err)
	}
	node, _ := kernel.Node("node")
	if node.State != NodePending {
		t.Fatalf("state=%s, want PENDING", node.State)
	}
}

func TestLeaseTTLMonotonicFenceAndStaleRejection(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 18, 0, 0, 0, time.UTC)}
	kernel, _ := openTestKernel(t, clock)
	defer kernel.Close()
	createReadyNode(t, kernel, "task", "node")

	first, err := kernel.ClaimLease("node", "executor-credential", "worker-a", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if first.Fence != 1 {
		t.Fatalf("first fence=%d, want 1", first.Fence)
	}
	firstToken := LeaseToken{LeaseID: first.ID, Fence: first.Fence}
	if _, err := kernel.ValidateLease("node", firstToken); err != nil {
		t.Fatal(err)
	}

	clock.Add(6 * time.Second)
	if _, err := kernel.ValidateLease("node", firstToken); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("expired lease error=%v, want ErrLeaseExpired", err)
	}
	if err := kernel.RequeueExpiredLease("node"); err != nil {
		t.Fatal(err)
	}
	node, _ := kernel.Node("node")
	if node.State != NodeReady {
		t.Fatalf("state after expired lease recovery=%s, want READY", node.State)
	}

	second, err := kernel.ClaimLease("node", "executor-credential", "worker-b", 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if second.Fence != 2 || second.ID == first.ID {
		t.Fatalf("second lease=%+v, want new id and fence 2", second)
	}
	if err := kernel.TransitionNode("node", NodePreparing, firstToken); !errors.Is(err, ErrStaleLease) {
		t.Fatalf("stale transition error=%v, want ErrStaleLease", err)
	}
	node, _ = kernel.Node("node")
	if node.State != NodeLeased {
		t.Fatalf("stale owner mutated state to %s", node.State)
	}
	if _, err := kernel.RenewLease("node", firstToken, time.Minute); !errors.Is(err, ErrStaleLease) {
		t.Fatalf("stale renewal error=%v, want ErrStaleLease", err)
	}
	secondToken := LeaseToken{LeaseID: second.ID, Fence: second.Fence}
	if _, err := kernel.RenewLease("node", secondToken, time.Minute); err != nil {
		t.Fatal(err)
	}
}

func TestResultUnderDeadFenceRequiresReconciliation(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 18, 0, 0, 0, time.UTC)}
	kernel, _ := openTestKernel(t, clock)
	defer kernel.Close()
	createReadyNode(t, kernel, "task", "node")

	first, err := kernel.ClaimLease("node", "executor-credential", "worker-a", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	firstToken := LeaseToken{LeaseID: first.ID, Fence: first.Fence}
	if err := kernel.TransitionNode("node", NodePreparing, firstToken); err != nil {
		t.Fatal(err)
	}
	intent, _, err := kernel.PrepareIntent(Intent{
		TaskID:         "task",
		NodeID:         "node",
		Kind:           "provider.dispatch",
		IdempotencyKey: "stale-commit-key",
		RequestHash:    "sha256:request",
	}, firstToken)
	if err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", NodeExecuting, firstToken); err != nil {
		t.Fatal(err)
	}
	if _, err := kernel.StartIntent(intent.ID, firstToken); err != nil {
		t.Fatal(err)
	}
	if _, err := kernel.RecordIntentResult(intent.ID, firstToken, "provider:result", "sha256:result"); err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", NodeVerifying, firstToken); err != nil {
		t.Fatal(err)
	}

	clock.Add(6 * time.Second)
	if err := kernel.RequeueExpiredLease("node"); err != nil {
		t.Fatal(err)
	}
	node, _ := kernel.Node("node")
	stored, ok := kernel.IntentByKey("stale-commit-key")
	if node.State != NodeReconciling || !ok || stored.State != IntentReconciling || stored.Fence != first.Fence {
		t.Fatalf("dead-fence RESULT did not enter reconciliation: node=%+v intent=%+v", node, stored)
	}
	if _, err := kernel.CommitIntent(intent.ID, firstToken); !errors.Is(err, ErrInvalidIntentState) {
		t.Fatalf("direct stale result commit error=%v, want ErrInvalidIntentState", err)
	}
	committed, err := kernel.CommitReconciledIntent(intent.ID, "", "")
	if err != nil || committed.State != IntentCommitted || committed.ResultHash != "sha256:result" || committed.ExternalRef != "provider:result" {
		t.Fatalf("reconciled recorded result=%+v err=%v", committed, err)
	}
	if err := kernel.TransitionNode("node", NodeSucceeded, LeaseToken{}); err != nil {
		t.Fatal(err)
	}
}

func TestIntentIdempotencyIsDurableAcrossRestart(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 18, 0, 0, 0, time.UTC)}
	kernel, path := openTestKernel(t, clock)
	createReadyNode(t, kernel, "task", "node")
	lease, err := kernel.ClaimLease("node", "executor-credential", "worker", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	token := LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	if err := kernel.TransitionNode("node", NodePreparing, token); err != nil {
		t.Fatal(err)
	}
	spec := Intent{
		TaskID:         "task",
		NodeID:         "node",
		Kind:           "process.exec",
		IdempotencyKey: "dispatch:task:node:1",
		RequestHash:    "sha256:request-a",
	}
	first, created, err := kernel.PrepareIntent(spec, token)
	if err != nil || !created {
		t.Fatalf("first prepare created=%v err=%v", created, err)
	}
	second, created, err := kernel.PrepareIntent(spec, token)
	if err != nil || created || second.ID != first.ID {
		t.Fatalf("duplicate prepare=%+v created=%v err=%v", second, created, err)
	}
	conflict := spec
	conflict.RequestHash = "sha256:different-request"
	if _, _, err := kernel.PrepareIntent(conflict, token); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("idempotency conflict error=%v", err)
	}
	if err := kernel.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenKernel(path,
		WithClock(clock.Now),
		WithVerifierAuthenticator(testVerifierAuthenticator{"verifier-credential": "verifier-independent"}),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	afterRestart, created, err := reopened.PrepareIntent(spec, token)
	if err != nil || created || afterRestart.ID != first.ID {
		t.Fatalf("restart dedupe=%+v created=%v err=%v", afterRestart, created, err)
	}
}

func TestUncertainIntentCannotBlindReplay(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 18, 0, 0, 0, time.UTC)}
	kernel, _ := openTestKernel(t, clock)
	defer kernel.Close()
	createReadyNode(t, kernel, "task", "node")
	lease, err := kernel.ClaimLease("node", "executor-credential", "worker", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	token := LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	if err := kernel.TransitionNode("node", NodePreparing, token); err != nil {
		t.Fatal(err)
	}
	intent, _, err := kernel.PrepareIntent(Intent{
		TaskID:         "task",
		NodeID:         "node",
		Kind:           "provider.dispatch",
		IdempotencyKey: "dispatch-key",
		RequestHash:    "sha256:dispatch",
	}, token)
	if err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", NodeExecuting, token); err != nil {
		t.Fatal(err)
	}
	started, err := kernel.StartIntent(intent.ID, token)
	if err != nil || started.State != IntentStarted {
		t.Fatalf("start intent=%+v err=%v", started, err)
	}

	clock.Add(6 * time.Second)
	if err := kernel.RequeueExpiredLease("node"); err != nil {
		t.Fatal(err)
	}
	recovered, ok := kernel.IntentByKey("dispatch-key")
	node, _ := kernel.Node("node")
	if !ok || recovered.State != IntentReconciling || node.State != NodeReconciling {
		t.Fatalf("expired STARTED effect was not reconciled: node=%+v intent=%+v", node, recovered)
	}
	if _, err := kernel.StartIntent(intent.ID, token); !errors.Is(err, ErrLeaseExpired) && !errors.Is(err, ErrInvalidIntentState) {
		t.Fatalf("blind replay error=%v", err)
	}
	if _, err := kernel.StartIntent(intent.ID, token); err == nil {
		t.Fatal("reconciling intent was allowed to restart")
	}
	committed, err := kernel.CommitReconciledIntent(intent.ID, "provider:dispatch-42", "sha256:result")
	if err != nil || committed.State != IntentCommitted {
		t.Fatalf("reconciled commit=%+v err=%v", committed, err)
	}
}

func TestIntentResultRequiresCommittingNodeBeforeCommit(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 18, 0, 0, 0, time.UTC)}
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
	intent, _, err := kernel.PrepareIntent(Intent{
		TaskID:         "task",
		NodeID:         "node",
		Kind:           "process.exec",
		IdempotencyKey: "commit-gate",
		RequestHash:    "sha256:request",
	}, token)
	if err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", NodeExecuting, token); err != nil {
		t.Fatal(err)
	}
	if _, err := kernel.StartIntent(intent.ID, token); err != nil {
		t.Fatal(err)
	}
	if _, err := kernel.RecordIntentResult(intent.ID, token, "external:1", "sha256:result"); err != nil {
		t.Fatal(err)
	}
	if _, err := kernel.CommitIntent(intent.ID, token); !errors.Is(err, ErrInvalidIntentState) {
		t.Fatalf("commit before COMMITTING error=%v", err)
	}
	if err := kernel.TransitionNode("node", NodeVerifying, token); err != nil {
		t.Fatal(err)
	}
	if _, err := kernel.RecordVerification("verifier-credential", VerificationRequest{NodeID: "node", Decision: VerificationPassed, EvidenceHash: "sha256:commit-gate"}); err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", NodeCommitting, token); err != nil {
		t.Fatal(err)
	}
	committed, err := kernel.CommitIntent(intent.ID, token)
	if err != nil || committed.State != IntentCommitted {
		t.Fatalf("commit intent=%+v err=%v", committed, err)
	}
	if err := kernel.TransitionNode("node", NodeSucceeded, token); err != nil {
		t.Fatal(err)
	}
}

func TestVerificationRequiredBeforeCommit(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 18, 0, 0, 0, time.UTC)}
	kernel, _ := openTestKernel(t, clock)
	defer kernel.Close()
	createReadyNode(t, kernel, "task", "node")
	lease, err := kernel.ClaimLease("node", "executor-credential", "executor", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	token := LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	for _, state := range []NodeState{NodePreparing, NodeExecuting, NodeVerifying} {
		if err := kernel.TransitionNode("node", state, token); err != nil {
			t.Fatal(err)
		}
	}
	if err := kernel.TransitionNode("node", NodeCommitting, token); !errors.Is(err, ErrConflict) {
		t.Fatalf("commit without verification error=%v", err)
	}
	if _, err := kernel.RecordVerification("executor-credential", VerificationRequest{NodeID: "node", Decision: VerificationPassed, EvidenceHash: "sha256:self"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("executor self-verification error=%v, want ErrConflict", err)
	}
	if _, err := kernel.RecordVerification("verifier-credential", VerificationRequest{NodeID: "node", Decision: VerificationPassed, EvidenceHash: "sha256:evidence"}); err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", NodeCommitting, token); err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", NodeSucceeded, token); err != nil {
		t.Fatal(err)
	}
}

func TestVerificationCanBindAuthenticatedVerifierIdentity(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 30, 9, 0, 0, 0, time.UTC)}
	kernel, _ := openTestKernel(t, clock)
	defer kernel.Close()
	createReadyNode(t, kernel, "task", "node")
	lease, err := kernel.ClaimLease("node", "executor-credential", "executor", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	token := LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	for _, state := range []NodeState{NodePreparing, NodeExecuting, NodeVerifying} {
		if err := kernel.TransitionNode("node", state, token); err != nil {
			t.Fatal(err)
		}
	}
	request := VerificationRequest{
		NodeID:             "node",
		Decision:           VerificationPassed,
		EvidenceHash:       "sha256:identity-bound",
		ExpectedVerifierID: "different-verifier",
	}
	if _, err := kernel.RecordVerification("verifier-credential", request); !errors.Is(err, ErrVerifierUnauthorized) {
		t.Fatalf("mismatched verifier identity error=%v", err)
	}
	request.ExpectedVerifierID = "verifier-independent"
	verification, err := kernel.RecordVerification("verifier-credential", request)
	if err != nil {
		t.Fatal(err)
	}
	if verification.VerifierID != request.ExpectedVerifierID {
		t.Fatalf("verifier id=%q want %q", verification.VerifierID, request.ExpectedVerifierID)
	}
}

func TestTaskGraphRejectsCycleAndQueriesReadyNodes(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 28, 18, 0, 0, 0, time.UTC)}
	kernel, _ := openTestKernel(t, clock)
	defer kernel.Close()
	if _, err := kernel.CreateTask(Task{ID: "task", Goal: "dag"}); err != nil {
		t.Fatal(err)
	}
	for _, node := range []Node{
		{ID: "a", TaskID: "task", Priority: 1},
		{ID: "b", TaskID: "task", Priority: 10},
		{ID: "c", TaskID: "task", Priority: 5},
	} {
		if _, err := kernel.AddNode(node); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := kernel.AddEdge(Edge{ID: "a-b", From: "a", To: "b"}); err != nil {
		t.Fatal(err)
	}
	if _, err := kernel.AddEdge(Edge{ID: "b-c", From: "b", To: "c"}); err != nil {
		t.Fatal(err)
	}
	if _, err := kernel.AddEdge(Edge{ID: "c-a", From: "c", To: "a"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("cycle error=%v, want ErrConflict", err)
	}
	if err := kernel.TransitionNode("a", NodeReady, LeaseToken{}); err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("b", NodeReady, LeaseToken{}); !errors.Is(err, ErrConflict) {
		t.Fatalf("dependent node became ready early: %v", err)
	}
	ready := kernel.ReadyNodes("task")
	if len(ready) != 1 || ready[0].ID != "a" {
		t.Fatalf("ready nodes=%+v, want only a", ready)
	}
}
