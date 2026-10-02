package supervisor

import (
	"context"
	"errors"
	"fmt"

	"swypik-os/core/controlkernel"
)

func (s *Supervisor) recoveryReportLocked(outcome string, sequence uint64, node controlkernel.Node, intent controlkernel.Intent, verified bool) RecoveryReport {
	return RecoveryReport{Status: s.ledger.status, Outcome: outcome, Sequence: sequence, NodeState: node.State,
		IntentState: intent.State, LeaseFence: intent.Fence, EvidenceVerified: verified, ContinuationResumed: false}
}

func (s *Supervisor) matchingVerificationLocked(nodeID string, intent controlkernel.Intent) (controlkernel.Verification, bool) {
	for _, verification := range s.config.Kernel.Verifications(nodeID) {
		if verification.AttemptID == intent.AttemptID && verification.LeaseID == intent.LeaseID && verification.Fence == intent.Fence &&
			verification.VerifierID == s.config.VerifierID && verification.Decision == controlkernel.VerificationPassed && validHash(verification.EvidenceHash) {
			return verification, true
		}
	}
	return controlkernel.Verification{}, false
}

func (s *Supervisor) stopRecoveryLocked(code, outcome string, sequence uint64, node controlkernel.Node, intent controlkernel.Intent, verified bool) (RecoveryReport, error) {
	err := s.stopLocked(StateUncertain, code)
	return s.recoveryReportLocked(outcome, sequence, node, intent, verified), err
}

// Recover reconciles one interrupted durable plan without launching or
// replaying the Swyp program. The only success accounting it reconstructs is
// an effect that already has a matching Control Kernel intent plus an
// independently authenticated PASSED verification for the same lease/fence.
// No serialized program continuation exists in v2, so recovery never claims
// an exact program resume after a durable guest launch.
func (s *Supervisor) Recover(ctx context.Context) (RecoveryReport, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkLocked(); err != nil {
		return RecoveryReport{Status: s.ledger.status}, err
	}
	if err := ctx.Err(); err != nil {
		return RecoveryReport{Status: s.ledger.status}, err
	}
	switch s.ledger.status.State {
	case StateSucceeded, StateFailed, StateUncertain:
		return RecoveryReport{Status: s.ledger.status, Outcome: RecoveryTerminal}, nil
	case StateReady:
		return RecoveryReport{Status: s.ledger.status, Outcome: RecoveryReady}, nil
	case StateRunning:
	default:
		return RecoveryReport{Status: s.ledger.status}, fmt.Errorf("%w: unknown supervisor recovery state", ErrRecoveryRequired)
	}

	// A durable launch with no pending effect can resume only from the latest
	// authenticated continuation bound to the exact committed effect cursor. A
	// missing checkpoint preserves the conservative v2 UNCERTAIN behavior.
	if s.ledger.status.Issued == s.ledger.status.Committed {
		if sequence := s.ledger.status.Committed; sequence > 0 {
			if payload, ok := s.ledger.continuations[sequence]; ok {
				resume, resumeErr := s.openSealedContinuationLocked(payload)
				if resumeErr == nil {
					return RecoveryReport{Status: s.ledger.status, Outcome: RecoveryResumeAvailable, Sequence: sequence,
						NodeState: controlkernel.NodeSucceeded, IntentState: controlkernel.IntentCommitted, LeaseFence: resume.Binding.Fence,
						EvidenceVerified: true, ContinuationAvailable: true, ContinuationResumed: false}, nil
				}
				stopErr := s.stopLocked(StateUncertain, "continuation_rejected")
				report := RecoveryReport{Status: s.ledger.status, Outcome: RecoveryContinuationRejected, Sequence: sequence,
					ContinuationAvailable: false, ContinuationResumed: false}
				return report, errors.Join(ErrContinuationRejected, resumeErr, stopErr)
			}
		}
		return s.stopRecoveryLocked("continuation_unavailable", RecoveryNoContinuation, 0, controlkernel.Node{}, controlkernel.Intent{}, false)
	}
	if s.ledger.status.Issued != s.ledger.status.Committed+1 {
		return RecoveryReport{Status: s.ledger.status}, fmt.Errorf("%w: more than one durable request is unresolved", ErrRecoveryRequired)
	}
	sequence := s.ledger.status.Committed + 1
	issued, ok := s.ledger.issued[sequence]
	if !ok || issued.Sequence != sequence {
		return RecoveryReport{Status: s.ledger.status}, fmt.Errorf("%w: unresolved request has no durable supervisor issue record", ErrRecoveryRequired)
	}
	node, ok := s.config.Kernel.Node(issued.NodeID)
	if !ok || node.TaskID != s.config.Plan.TaskID || issued.NodeID != nodeID(s.planHash, sequence) {
		return RecoveryReport{Status: s.ledger.status}, fmt.Errorf("%w: unresolved request node identity mismatch", ErrRecoveryRequired)
	}
	intent, hasIntent := s.config.Kernel.IntentByKey("effect:v1:" + issued.RequestID)
	if !hasIntent {
		if lease, exists := s.config.Kernel.Lease(node.ID); exists && !lease.Released && s.config.Now().Before(lease.ExpiresAt) {
			return RecoveryReport{Status: s.ledger.status, Outcome: RecoveryWaitingLease, Sequence: sequence, NodeState: node.State,
				LeaseFence: lease.Fence, ContinuationResumed: false}, nil
		}
		if lease, exists := s.config.Kernel.Lease(node.ID); exists && !lease.Released {
			if err := s.config.Kernel.RequeueExpiredLease(node.ID); err != nil && !errors.Is(err, controlkernel.ErrStaleLease) {
				return RecoveryReport{Status: s.ledger.status}, err
			}
			node, _ = s.config.Kernel.Node(node.ID)
		}
		return s.stopRecoveryLocked("continuation_unavailable", RecoveryNoContinuation, sequence, node, controlkernel.Intent{}, false)
	}
	if intent.TaskID != s.config.Plan.TaskID || intent.NodeID != issued.NodeID || intent.RequestHash != issued.RequestHash || intent.IdempotencyKey != "effect:v1:"+issued.RequestID {
		return RecoveryReport{Status: s.ledger.status}, fmt.Errorf("%w: Control Kernel intent does not match durable request", ErrRecoveryRequired)
	}
	lease, hasLease := s.config.Kernel.Lease(node.ID)
	if hasLease && (lease.ID != intent.LeaseID || lease.Fence != intent.Fence || lease.AttemptID != intent.AttemptID) {
		return RecoveryReport{Status: s.ledger.status}, fmt.Errorf("%w: durable intent execution epoch does not match node lease", ErrRecoveryRequired)
	}
	if hasLease && !lease.Released && s.config.Now().Before(lease.ExpiresAt) && (intent.State != controlkernel.IntentCommitted || node.State != controlkernel.NodeSucceeded) {
		return s.recoveryReportLocked(RecoveryWaitingLease, sequence, node, intent, false), nil
	}
	if hasLease && !lease.Released && !s.config.Now().Before(lease.ExpiresAt) {
		if err := s.config.Kernel.RequeueExpiredLease(node.ID); err != nil && !errors.Is(err, controlkernel.ErrStaleLease) {
			return RecoveryReport{Status: s.ledger.status}, err
		}
		node, _ = s.config.Kernel.Node(node.ID)
		intent, _ = s.config.Kernel.IntentByKey("effect:v1:" + issued.RequestID)
	}
	if intent.State == controlkernel.IntentStarted {
		if _, err := s.config.Kernel.RecoverStartedIntent(intent.ID); err != nil && !errors.Is(err, controlkernel.ErrInvalidIntentState) {
			return RecoveryReport{Status: s.ledger.status}, err
		}
		node, _ = s.config.Kernel.Node(node.ID)
		intent, _ = s.config.Kernel.IntentByKey("effect:v1:" + issued.RequestID)
	}
	if intent.State == controlkernel.IntentPrepared || intent.State == controlkernel.IntentAbandoned {
		return s.stopRecoveryLocked("continuation_unavailable", RecoveryNoContinuation, sequence, node, intent, false)
	}
	verification, verified := s.matchingVerificationLocked(node.ID, intent)
	if !verified {
		if (intent.State == controlkernel.IntentResult || intent.State == controlkernel.IntentUncertain) &&
			(node.State == controlkernel.NodeUncertain || node.State == controlkernel.NodeReconciling) {
			_, _ = s.config.Kernel.BeginReconciliation(intent.ID)
			node, _ = s.config.Kernel.Node(node.ID)
			intent, _ = s.config.Kernel.IntentByKey("effect:v1:" + issued.RequestID)
		}
		return s.stopRecoveryLocked("evidence_unverified", RecoveryEvidenceUnverified, sequence, node, intent, false)
	}
	if !validHash(intent.ResultHash) || verification.EvidenceHash == "" {
		return RecoveryReport{Status: s.ledger.status}, fmt.Errorf("%w: verified recovery evidence hashes are invalid", ErrRecoveryRequired)
	}

	switch intent.State {
	case controlkernel.IntentResult, controlkernel.IntentUncertain:
		if node.State != controlkernel.NodeUncertain && node.State != controlkernel.NodeReconciling {
			return RecoveryReport{Status: s.ledger.status}, fmt.Errorf("%w: verified intent cannot enter reconciliation from %s", ErrRecoveryRequired, node.State)
		}
		if _, err := s.config.Kernel.BeginReconciliation(intent.ID); err != nil {
			return RecoveryReport{Status: s.ledger.status}, err
		}
		intent, _ = s.config.Kernel.IntentByKey("effect:v1:" + issued.RequestID)
		fallthrough
	case controlkernel.IntentReconciling:
		if _, err := s.config.Kernel.CommitReconciledIntent(intent.ID, intent.ExternalRef, intent.ResultHash); err != nil {
			return RecoveryReport{Status: s.ledger.status}, err
		}
		intent, _ = s.config.Kernel.IntentByKey("effect:v1:" + issued.RequestID)
	case controlkernel.IntentCommitted:
		// Already committed by the original execution epoch.
	default:
		return s.stopRecoveryLocked("continuation_unavailable", RecoveryNoContinuation, sequence, node, intent, verified)
	}
	node, _ = s.config.Kernel.Node(node.ID)
	if node.State == controlkernel.NodeReconciling {
		if err := s.config.Kernel.TransitionNode(node.ID, controlkernel.NodeSucceeded, controlkernel.LeaseToken{}); err != nil {
			return RecoveryReport{Status: s.ledger.status}, err
		}
		node, _ = s.config.Kernel.Node(node.ID)
	}
	if node.State != controlkernel.NodeSucceeded || intent.State != controlkernel.IntentCommitted {
		return RecoveryReport{Status: s.ledger.status}, fmt.Errorf("%w: verified recovery did not converge to committed node", ErrRecoveryRequired)
	}
	if err := s.appendLocked(eventCommitted, committedPayload{Sequence: sequence, RequestHash: issued.RequestHash,
		ResultHash: intent.ResultHash, ReceiptHash: verification.EvidenceHash, IntentID: intent.ID}); err != nil {
		return RecoveryReport{Status: s.ledger.status}, err
	}
	return s.stopRecoveryLocked("continuation_unavailable", RecoveryReconciledNoContinuation, sequence, node, intent, true)
}
