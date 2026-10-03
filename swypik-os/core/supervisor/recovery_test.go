package supervisor

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"swypik-os/core/controlkernel"
	"swypik-os/core/effects"
)

type crashBoundary string

const (
	crashStarted             crashBoundary = "plan_started"
	crashIssued              crashBoundary = "request_issued"
	crashLeased              crashBoundary = "lease_claimed"
	crashPrepared            crashBoundary = "intent_prepared"
	crashIntentStarted       crashBoundary = "intent_started"
	crashResult              crashBoundary = "intent_result"
	crashVerified            crashBoundary = "verification_recorded"
	crashCommitting          crashBoundary = "node_committing"
	crashIntentCommitted     crashBoundary = "intent_committed"
	crashNodeSucceeded       crashBoundary = "node_succeeded"
	crashSupervisorCommitted crashBoundary = "supervisor_committed"
	crashFinished            crashBoundary = "plan_finished"
)

func seedCrashBoundary(t *testing.T, f *fixture, boundary crashBoundary, validEvidence bool) {
	t.Helper()
	f.start()
	if boundary == crashStarted {
		return
	}
	request := f.request(1, "fs.read")
	requestHash, err := effects.RequestHash(request)
	if err != nil {
		t.Fatal(err)
	}
	id, grant := nodeID(f.sup.planHash, 1), grantID(f.sup.planHash, 1)
	f.sup.mu.Lock()
	err = f.sup.appendLocked(eventIssued, issuedPayload{Sequence: 1, RequestID: request.RequestID, RequestHash: requestHash,
		NodeID: id, GrantID: grant, ReservedReadBytes: 4})
	f.sup.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if boundary == crashIssued {
		return
	}
	lease, err := f.kernel.ClaimLease(id, f.config.ExecutorCredential, f.config.ExecutorID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if boundary == crashLeased {
		return
	}
	token := controlkernel.LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	if err := f.kernel.TransitionNode(id, controlkernel.NodePreparing, token); err != nil {
		t.Fatal(err)
	}
	intent, _, err := f.kernel.PrepareIntent(controlkernel.Intent{TaskID: f.config.Plan.TaskID, NodeID: id,
		Kind: request.Effect, IdempotencyKey: "effect:v1:" + request.RequestID, RequestHash: requestHash}, token)
	if err != nil {
		t.Fatal(err)
	}
	if boundary == crashPrepared {
		return
	}
	if err := f.kernel.TransitionNode(id, controlkernel.NodeExecuting, token); err != nil {
		t.Fatal(err)
	}
	if _, err := f.kernel.StartIntent(intent.ID, token); err != nil {
		t.Fatal(err)
	}
	if boundary == crashIntentStarted {
		return
	}
	resultHash := strings.Repeat("2", 64)
	if _, err := f.kernel.RecordIntentResult(intent.ID, token, "", resultHash); err != nil {
		t.Fatal(err)
	}
	if boundary == crashResult {
		return
	}
	if err := f.kernel.TransitionNode(id, controlkernel.NodeVerifying, token); err != nil {
		t.Fatal(err)
	}
	evidenceHash := strings.Repeat("3", 64)
	if !validEvidence {
		evidenceHash = "not-a-sha256"
	}
	if _, err := f.kernel.RecordVerification(f.config.VerifierCredential, controlkernel.VerificationRequest{NodeID: id,
		Decision: controlkernel.VerificationPassed, EvidenceHash: evidenceHash, ExpectedVerifierID: f.config.VerifierID}); err != nil {
		t.Fatal(err)
	}
	if boundary == crashVerified {
		return
	}
	if err := f.kernel.TransitionNode(id, controlkernel.NodeCommitting, token); err != nil {
		t.Fatal(err)
	}
	if boundary == crashCommitting {
		return
	}
	if _, err := f.kernel.CommitIntent(intent.ID, token); err != nil {
		t.Fatal(err)
	}
	if boundary == crashIntentCommitted {
		return
	}
	if err := f.kernel.TransitionNode(id, controlkernel.NodeSucceeded, token); err != nil {
		t.Fatal(err)
	}
	if boundary == crashNodeSucceeded {
		return
	}
	f.sup.mu.Lock()
	err = f.sup.appendLocked(eventCommitted, committedPayload{Sequence: 1, RequestHash: requestHash, ResultHash: resultHash,
		ReceiptHash: evidenceHash, IntentID: intent.ID})
	f.sup.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if boundary == crashSupervisorCommitted {
		return
	}
	f.sup.mu.Lock()
	err = f.sup.appendLocked(eventFinished, finishedPayload{ValueHash: strings.Repeat("4", 64)})
	f.sup.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
}

func reopenForRecovery(t *testing.T, f *fixture) *Supervisor {
	t.Helper()
	if err := f.sup.Close(); err != nil {
		t.Fatal(err)
	}
	f.sup = nil
	if err := f.kernel.Close(); err != nil {
		t.Fatal(err)
	}
	f.openKernel()
	f.config.Kernel = f.kernel
	c := f.config
	c.Plan = Plan{} // Recovery identity must come from the durable ledger.
	c.Reader = nil
	s, err := OpenRecovery(c)
	if err != nil {
		t.Fatal(err)
	}
	f.sup = s
	return s
}

func TestRecoveryCrashMatrixNeverReplaysEffectsOrInventsProgramSuccess(t *testing.T) {
	cases := []struct {
		boundary crashBoundary
		outcome  string
		verified bool
		terminal string
	}{
		{crashStarted, RecoveryNoContinuation, false, StateUncertain},
		{crashIssued, RecoveryNoContinuation, false, StateUncertain},
		{crashLeased, RecoveryNoContinuation, false, StateUncertain},
		{crashPrepared, RecoveryNoContinuation, false, StateUncertain},
		{crashIntentStarted, RecoveryEvidenceUnverified, false, StateUncertain},
		{crashResult, RecoveryEvidenceUnverified, false, StateUncertain},
		{crashVerified, RecoveryReconciledNoContinuation, true, StateUncertain},
		{crashCommitting, RecoveryReconciledNoContinuation, true, StateUncertain},
		{crashIntentCommitted, RecoveryReconciledNoContinuation, true, StateUncertain},
		{crashNodeSucceeded, RecoveryReconciledNoContinuation, true, StateUncertain},
		{crashSupervisorCommitted, RecoveryNoContinuation, false, StateUncertain},
		{crashFinished, RecoveryTerminal, false, StateSucceeded},
	}
	for _, tc := range cases {
		t.Run(string(tc.boundary), func(t *testing.T) {
			f := newFixture(t)
			seedCrashBoundary(t, f, tc.boundary, true)
			if f.reads != 0 || f.verifies != 0 {
				t.Fatal("crash fixture unexpectedly executed provider or verifier callback")
			}
			f.now = f.now.Add(2 * time.Hour) // expire any original lease/fence authority
			s := reopenForRecovery(t, f)
			report, err := s.Recover(context.Background())
			if err != nil {
				t.Fatalf("recover %s: %v", tc.boundary, err)
			}
			if report.Outcome != tc.outcome || report.EvidenceVerified != tc.verified || report.ContinuationResumed || report.Status.State != tc.terminal {
				t.Fatalf("boundary=%s report=%+v", tc.boundary, report)
			}
			if f.reads != 0 || f.verifies != 0 {
				t.Fatalf("recovery replayed provider/verifier: reads=%d verifies=%d", f.reads, f.verifies)
			}
		})
	}
}

func TestRecoveryWaitsForLiveLeaseThenUsesOnlyDurableVerifiedEvidence(t *testing.T) {
	f := newFixture(t)
	seedCrashBoundary(t, f, crashVerified, true)
	s := reopenForRecovery(t, f)
	report, err := s.Recover(context.Background())
	if err != nil || report.Outcome != RecoveryWaitingLease || report.Status.State != StateRunning || report.ContinuationResumed {
		t.Fatalf("live lease recovery=%+v err=%v", report, err)
	}
	f.now = f.now.Add(2 * time.Hour)
	report, err = s.Recover(context.Background())
	if err != nil || report.Outcome != RecoveryReconciledNoContinuation || !report.EvidenceVerified || report.Status.Committed != 1 || report.Status.State != StateUncertain {
		t.Fatalf("expired lease recovery=%+v err=%v", report, err)
	}
}

func TestRecoveryRejectsInvalidIndependentEvidenceAndChangedPolicy(t *testing.T) {
	t.Run("invalid-evidence", func(t *testing.T) {
		f := newFixture(t)
		seedCrashBoundary(t, f, crashVerified, false)
		f.now = f.now.Add(2 * time.Hour)
		s := reopenForRecovery(t, f)
		report, err := s.Recover(context.Background())
		if err != nil || report.Outcome != RecoveryEvidenceUnverified || report.EvidenceVerified || report.Status.State != StateUncertain || report.Status.Committed != 0 {
			t.Fatalf("invalid evidence recovery=%+v err=%v", report, err)
		}
	})
	t.Run("changed-policy", func(t *testing.T) {
		f := newFixture(t)
		seedCrashBoundary(t, f, crashStarted, true)
		if err := f.sup.Close(); err != nil {
			t.Fatal(err)
		}
		f.sup = nil
		if err := f.kernel.Close(); err != nil {
			t.Fatal(err)
		}
		f.openKernel()
		f.config.Kernel = f.kernel
		c := f.config
		c.Plan = Plan{}
		c.Scopes[1].MaxReadBytes++
		if _, err := OpenRecovery(c); !errors.Is(err, ErrPolicyChanged) {
			t.Fatalf("changed recovery policy err=%v", err)
		}
	})
}

func TestOpenRecoveryRejectsCorruptLedgerWithoutRepair(t *testing.T) {
	f := newFixture(t)
	seedCrashBoundary(t, f, crashStarted, true)
	if err := f.sup.Close(); err != nil {
		t.Fatal(err)
	}
	f.sup = nil
	raw, err := os.ReadFile(f.config.LedgerPath)
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, []byte("CK")...)
	if err := os.WriteFile(f.config.LedgerPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	c := f.config
	c.Plan = Plan{}
	if _, err := OpenRecovery(c); !errors.Is(err, controlkernel.ErrCorruptJournal) {
		t.Fatalf("corrupt recovery ledger err=%v", err)
	}
	after, _ := os.ReadFile(f.config.LedgerPath)
	if string(after) != string(raw) {
		t.Fatal("recovery modified corrupt ledger")
	}
}
