package supervisor

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"

	"swypik-os/core/controlkernel"
	"swypik-os/core/effects"
	wire "swypik-os/generated/swypeffects"
)

type Supervisor struct {
	mu               sync.Mutex
	config           Config
	planHash         string
	store            *controlkernel.EventStore
	ledger           ledgerState
	ownedReader      *effects.Reader
	bindings         map[string]string
	scopes           map[string]Scope
	startedHere      bool
	resumeAuthorized bool
	reopened         bool
	closed           bool
	failed           error
}

func Open(config Config) (*Supervisor, error) {
	return open(config, false)
}

// OpenRecovery reconstructs the immutable program identity from the supervisor
// ledger before policy validation. It never compiles source, opens read roots,
// executes a provider, or invokes the evidence verifier.
func OpenRecovery(config Config) (*Supervisor, error) {
	if config.Kernel == nil || !filepath.IsAbs(config.LedgerPath) {
		return nil, fmt.Errorf("supervisor recovery requires kernel and absolute ledger")
	}
	store, err := controlkernel.OpenExistingEventStore(config.LedgerPath)
	if err != nil {
		return nil, err
	}
	state := newLedgerState()
	for _, event := range store.Events() {
		if err := state.apply(event); err != nil {
			_ = store.Close()
			return nil, fmt.Errorf("supervisor ledger replay: %w", err)
		}
	}
	closeErr := store.Close()
	if closeErr != nil {
		return nil, closeErr
	}
	if state.sequence == 0 || state.created.Plan.RunID == "" {
		return nil, fmt.Errorf("%w: ledger has no serialized v2 program identity", ErrRecoveryRequired)
	}
	config.Plan = state.created.Plan
	return open(config, true)
}

func open(config Config, recovery bool) (*Supervisor, error) {
	config, planHash, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	principal, err := config.Kernel.ValidateVerifierCredential(config.VerifierCredential, config.VerifierID)
	if err != nil || principal.ID == config.ExecutorID {
		return nil, fmt.Errorf("%w: independent verifier credential rejected", ErrVerification)
	}
	task, taskExists := config.Kernel.Task(config.Plan.TaskID)
	if _, err := os.Lstat(config.LedgerPath); taskExists && os.IsNotExist(err) {
		return nil, fmt.Errorf("%w: existing task has no supervisor ledger", ErrRecoveryRequired)
	}
	if !taskExists && !config.Now().Before(config.Plan.Deadline) {
		return nil, fmt.Errorf("%w: expired plan cannot acquire new ownership", ErrDenied)
	}
	store, err := controlkernel.OpenEventStore(config.LedgerPath)
	if err != nil {
		return nil, err
	}
	s := &Supervisor{config: config, planHash: planHash, store: store, ledger: newLedgerState(),
		bindings: make(map[string]string), scopes: make(map[string]Scope)}
	ready := false
	defer func() {
		if !ready {
			_ = s.Close()
		}
	}()
	for _, event := range store.Events() {
		if err := s.ledger.apply(event); err != nil {
			return nil, fmt.Errorf("supervisor ledger replay: %w", err)
		}
	}
	store.DisableEventRetention()
	if s.ledger.sequence == 0 {
		if taskExists {
			return nil, fmt.Errorf("%w: existing task has an empty supervisor ledger", ErrRecoveryRequired)
		}
		identity, err := ledgerIdentity()
		if err != nil {
			return nil, err
		}
		if recovery {
			return nil, fmt.Errorf("%w: recovery cannot create a new supervisor ledger", ErrRecoveryRequired)
		}
		if err := s.appendLocked(eventCreated, createdPayload{LedgerID: identity, PlanHash: planHash, TaskID: config.Plan.TaskID,
			RunID: config.Plan.RunID, MaxEffects: config.Plan.MaxEffects, MaxReadBytes: config.Plan.MaxReadBytes, Plan: config.Plan}); err != nil {
			return nil, err
		}
	}
	if s.ledger.created.PlanHash != planHash || s.ledger.created.TaskID != config.Plan.TaskID || s.ledger.created.RunID != config.Plan.RunID ||
		s.ledger.created.MaxEffects != config.Plan.MaxEffects || s.ledger.created.MaxReadBytes != config.Plan.MaxReadBytes {
		return nil, ErrPolicyChanged
	}
	if taskExists {
		if task.Metadata["supervisor_plan_hash"] != planHash || task.Metadata["supervisor_ledger_id"] != s.ledger.created.LedgerID ||
			task.Metadata["supervisor_run_id"] != config.Plan.RunID || task.Budget.MaxReadBytes != config.Plan.MaxReadBytes {
			return nil, ErrPolicyChanged
		}
	} else {
		if s.ledger.status.State != StateReady {
			return nil, fmt.Errorf("%w: observed supervisor ledger has no control-kernel task", ErrRecoveryRequired)
		}
		if _, err := config.Kernel.CreateTask(controlkernel.Task{ID: config.Plan.TaskID, Goal: "Execute immutable scoped Swyp plan",
			Budget: controlkernel.Budget{MaxReadBytes: config.Plan.MaxReadBytes}, Metadata: map[string]string{
				"supervisor_plan_hash": planHash, "supervisor_ledger_id": s.ledger.created.LedgerID, "supervisor_run_id": config.Plan.RunID,
				"supervisor_module_hash": config.Plan.ModuleHash}}); err != nil {
			return nil, err
		}
	}
	s.reopened = s.ledger.status.State != StateReady
	var nodeReadLimit int64
	for _, scope := range config.Scopes {
		s.scopes[scopeKey(scope.Function, scope.Effect, scope.Capability, scope.Path)] = scope
		if scope.MaxReadBytes > nodeReadLimit {
			nodeReadLimit = scope.MaxReadBytes
		}
	}
	for _, binding := range config.Plan.Bindings {
		s.bindings[bindingKey(binding.Function, binding.Effect)] = binding.Capability
	}
	for sequence := uint64(1); sequence <= config.Plan.MaxEffects; sequence++ {
		id := nodeID(planHash, sequence)
		node, exists := config.Kernel.Node(id)
		if exists {
			if node.TaskID != config.Plan.TaskID || node.Kind != "supervised-effect" || node.Budget.MaxReadBytes != nodeReadLimit || !node.Deadline.Equal(config.Plan.Deadline) {
				return nil, ErrPolicyChanged
			}
		} else {
			if s.reopened {
				return nil, fmt.Errorf("%w: observed plan has missing control-kernel nodes", ErrRecoveryRequired)
			}
			if _, err := config.Kernel.AddNode(controlkernel.Node{ID: id, TaskID: config.Plan.TaskID, Kind: "supervised-effect",
				Budget: controlkernel.Budget{MaxReadBytes: nodeReadLimit, MaxAttempts: 1}, Deadline: config.Plan.Deadline}); err != nil {
				return nil, err
			}
		}
	}
	if !recovery && config.Reader == nil {
		reader, err := effects.OpenReader(config.RootPaths)
		if err != nil {
			return nil, err
		}
		s.ownedReader, s.config.Reader = reader, reader
	}
	ready = true
	return s, nil
}

func (s *Supervisor) checkLocked() error {
	if s.closed {
		return controlkernel.ErrClosed
	}
	if s.failed != nil {
		return fmt.Errorf("%w: supervisor ledger failed", controlkernel.ErrStorageFailed)
	}
	return nil
}

func (s *Supervisor) Status() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ledger.status
}

// Start durably reserves the only guest launch for this plan. A reopened
// started plan is status/recovery only, even if it issued no effects.
func (s *Supervisor) Start(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkLocked(); err != nil {
		return err
	}
	if s.reopened {
		return ErrRecoveryRequired
	}
	if s.startedHere || s.ledger.status.State != StateReady {
		return fmt.Errorf("%w: plan already started or stopped", ErrDenied)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if !s.config.Now().Before(s.config.Plan.Deadline) {
		return fmt.Errorf("%w: plan deadline expired", ErrDenied)
	}
	// All effect nodes already exist. Making the first node READY freezes
	// the entire task topology before any guest code or grant is launched.
	first := nodeID(s.planHash, 1)
	node, _ := s.config.Kernel.Node(first)
	if node.State == controlkernel.NodePending {
		if err := s.config.Kernel.TransitionNode(first, controlkernel.NodeReady, controlkernel.LeaseToken{}); err != nil {
			return err
		}
	} else if node.State != controlkernel.NodeReady {
		return ErrRecoveryRequired
	}
	if err := s.appendLocked(eventStarted, struct{}{}); err != nil {
		return err
	}
	s.startedHere = true
	return nil
}

func (s *Supervisor) cancelUnusedLocked() error {
	var result error
	for sequence := s.ledger.status.Issued + 1; sequence <= s.config.Plan.MaxEffects; sequence++ {
		id := nodeID(s.planHash, sequence)
		node, exists := s.config.Kernel.Node(id)
		if !exists {
			result = errors.Join(result, fmt.Errorf("missing unused effect node"))
			continue
		}
		if node.State == controlkernel.NodeCancelled {
			continue
		}
		if node.State != controlkernel.NodePending && node.State != controlkernel.NodeReady {
			result = errors.Join(result, fmt.Errorf("unused effect node has unexpected state %s", node.State))
			continue
		}
		result = errors.Join(result, s.config.Kernel.TransitionNode(id, controlkernel.NodeCancelled, controlkernel.LeaseToken{}))
	}
	return result
}

func (s *Supervisor) stopLocked(state, code string) error {
	var result error
	if s.ledger.status.State == StateReady || s.ledger.status.State == StateRunning {
		result = s.appendLocked(eventStopped, stoppedPayload{State: state, Code: code})
	}
	return errors.Join(result, s.cancelUnusedLocked())
}

func (s *Supervisor) recoverNodeLocked(id, intentID string, token controlkernel.LeaseToken) {
	node, exists := s.config.Kernel.Node(id)
	if !exists || controlkernel.IsTerminal(node.State) {
		return
	}
	if intentID == "" {
		_ = s.config.Kernel.TransitionNode(id, controlkernel.NodeFailed, token)
		return
	}
	if _, err := s.config.Kernel.ValidateLease(id, token); err != nil {
		_ = s.config.Kernel.RequeueExpiredLease(id)
		return
	}
	_, _ = s.config.Kernel.MarkIntentUncertain(intentID, token)
	if node.State != controlkernel.NodeUncertain && node.State != controlkernel.NodeReconciling {
		_ = s.config.Kernel.TransitionNode(id, controlkernel.NodeUncertain, token)
	}
	_, _ = s.config.Kernel.BeginReconciliation(intentID)
}

func (s *Supervisor) Handle(ctx context.Context, request wire.EffectRequest) (Evidence, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var evidence Evidence
	if err := s.checkLocked(); err != nil {
		return evidence, err
	}
	if !s.startedHere || (s.reopened && !s.resumeAuthorized) || s.ledger.status.State != StateRunning || s.ledger.status.Issued != s.ledger.status.Committed {
		return evidence, ErrRecoveryRequired
	}
	if s.config.Continuation.Enabled && s.ledger.status.Committed > 0 {
		if _, ok := s.ledger.continuations[s.ledger.status.Committed]; !ok {
			return evidence, fmt.Errorf("%w: latest committed effect has no authenticated continuation", ErrRecoveryRequired)
		}
	}
	deny := func(code string, cause error) (Evidence, error) {
		return evidence, errors.Join(fmt.Errorf("%w: %s: %v", ErrDenied, code, cause), s.stopLocked(StateFailed, code))
	}
	if err := ctx.Err(); err != nil {
		return deny("request_cancelled", err)
	}
	if !s.config.Now().Before(s.config.Plan.Deadline) {
		return deny("deadline_expired", nil)
	}
	sequence := s.ledger.status.Issued + 1
	if sequence > s.config.Plan.MaxEffects {
		return deny("effect_budget_exhausted", nil)
	}
	if err := effects.ValidateRequest(request); err != nil {
		return deny("invalid_request", err)
	}
	if request.RequestID != s.config.Plan.RunID+":"+strconv.FormatUint(sequence, 10) || request.ModuleHash != s.config.Plan.ModuleHash ||
		s.bindings[bindingKey(request.Function, request.Effect)] != request.Capability {
		return deny("request_binding_mismatch", nil)
	}
	scope, allowed := s.scopes[scopeKey(request.Function, request.Effect, request.Capability, request.Path)]
	if !allowed {
		return deny("scope_denied", nil)
	}
	if scope.MaxReadBytes > s.config.Plan.MaxReadBytes-s.ledger.status.ReservedReadBytes {
		return deny("read_budget_exhausted", nil)
	}
	if _, exists := s.config.Kernel.IntentByKey("effect:v1:" + request.RequestID); exists {
		return deny("request_identity_reused", ErrRecoveryRequired)
	}
	requestHash, err := effects.RequestHash(request)
	if err != nil {
		return deny("invalid_request", err)
	}
	id, grantIdentity := nodeID(s.planHash, sequence), grantID(s.planHash, sequence)
	if err := s.appendLocked(eventIssued, issuedPayload{Sequence: sequence, RequestID: request.RequestID, RequestHash: requestHash,
		NodeID: id, GrantID: grantIdentity, ReservedReadBytes: scope.MaxReadBytes}); err != nil {
		return evidence, err
	}
	fail := func(code string, cause error, token controlkernel.LeaseToken) (Evidence, error) {
		s.recoverNodeLocked(id, evidence.Receipt.IntentID, token)
		if node, ok := s.config.Kernel.Node(id); ok {
			evidence.NodeState = node.State
		}
		return evidence, errors.Join(cause, s.stopLocked(StateUncertain, code))
	}
	node, _ := s.config.Kernel.Node(id)
	if node.State == controlkernel.NodePending {
		if err := s.config.Kernel.TransitionNode(id, controlkernel.NodeReady, controlkernel.LeaseToken{}); err != nil {
			return fail("node_admission_failed", err, controlkernel.LeaseToken{})
		}
	}
	lease, err := s.config.Kernel.ClaimLease(id, s.config.ExecutorCredential, s.config.ExecutorID, s.config.Plan.Deadline.Sub(s.config.Now()))
	if err != nil {
		return fail("lease_failed", err, controlkernel.LeaseToken{})
	}
	token := controlkernel.LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	if lease.ExecutorID != s.config.ExecutorID {
		return fail("executor_identity_mismatch", ErrDenied, token)
	}
	grant := effects.Grant{Binding: effects.Binding{TaskID: s.config.Plan.TaskID, NodeID: id, AttemptID: lease.AttemptID,
		ExecutorID: lease.ExecutorID, GrantID: grantIdentity, LeaseID: lease.ID, Fence: lease.Fence},
		RequestID: request.RequestID, RequestHash: requestHash, Effect: request.Effect, Capability: request.Capability,
		RootID: scope.RootID, MaxBytes: scope.MaxReadBytes, ExpiresAt: s.config.Plan.Deadline}
	broker, err := effects.NewBroker(effects.Config{Kernel: s.config.Kernel, Reader: s.config.Reader, SignerKeyID: s.config.SignerKeyID,
		PrivateKey: s.config.PrivateKey, Grants: []effects.Grant{grant}, Now: s.config.Now})
	if err != nil {
		return fail("broker_configuration_failed", err, token)
	}
	runCtx, cancel := context.WithTimeout(ctx, s.config.Plan.Deadline.Sub(s.config.Now()))
	defer cancel()
	evidence.Request, evidence.Expected = request, grant.Binding
	evidence.Result, evidence.Receipt, err = broker.Execute(runCtx, s.config.ExecutorCredential, request)
	if err != nil || evidence.Result.Status != "succeeded" {
		if err == nil {
			err = fmt.Errorf("%w: effect returned %s", ErrDenied, evidence.Result.Status)
		}
		return fail("effect_not_successful", err, token)
	}
	if err := s.config.Kernel.TransitionNode(id, controlkernel.NodeVerifying, token); err != nil {
		return fail("verification_admission_failed", err, token)
	}
	verifierResult := evidence.Result
	verifierResult.Value = append([]byte{}, verifierResult.Value...)
	verifierReceipt := evidence.Receipt
	verifierReceipt.Signature = append([]byte{}, verifierReceipt.Signature...)
	evidence.Verification, err = s.config.Verifier.Verify(runCtx, request, verifierResult, verifierReceipt, evidence.Expected)
	if err != nil {
		return fail("verifier_unavailable", errors.Join(ErrVerification, err), token)
	}
	resultHash, _ := effects.ResultHash(evidence.Result)
	signingBytes, err := effects.ReceiptSigningBytes(evidence.Receipt)
	if err != nil {
		return fail("receipt_invalid", ErrVerification, token)
	}
	receiptDigest := sha256.Sum256(signingBytes)
	receiptHash := hex.EncodeToString(receiptDigest[:])
	if evidence.Verification.RequestHash != requestHash || evidence.Verification.ResultHash != resultHash ||
		evidence.Verification.ReceiptHash != receiptHash || evidence.Verification.Expected != evidence.Expected ||
		evidence.Receipt.RequestHash != requestHash || evidence.Receipt.ResultHash != resultHash ||
		!ed25519.Verify(s.config.PrivateKey.Public().(ed25519.PublicKey), signingBytes, evidence.Receipt.Signature) {
		return fail("verifier_rejected", ErrVerification, token)
	}
	if err := runCtx.Err(); err != nil {
		return fail("verification_cancelled", err, token)
	}
	if !s.config.Now().Before(s.config.Plan.Deadline) {
		return fail("deadline_expired", ErrDenied, token)
	}
	decision := controlkernel.VerificationPassed
	if !evidence.Verification.Verified {
		decision = controlkernel.VerificationFailed
	}
	if _, err := s.config.Kernel.RecordVerification(s.config.VerifierCredential, controlkernel.VerificationRequest{NodeID: id,
		ExpectedVerifierID: s.config.VerifierID, Decision: decision, EvidenceHash: receiptHash}); err != nil {
		return fail("verification_not_durable", err, token)
	}
	if !evidence.Verification.Verified {
		return fail("verifier_rejected", ErrVerification, token)
	}
	if err := s.config.Kernel.TransitionNode(id, controlkernel.NodeCommitting, token); err != nil {
		return fail("commit_admission_failed", err, token)
	}
	if _, err := s.config.Kernel.CommitIntent(evidence.Receipt.IntentID, token); err != nil {
		return fail("intent_commit_failed", err, token)
	}
	if err := s.config.Kernel.TransitionNode(id, controlkernel.NodeSucceeded, token); err != nil {
		return fail("node_commit_failed", err, token)
	}
	evidence.NodeState = controlkernel.NodeSucceeded
	if err := s.appendLocked(eventCommitted, committedPayload{Sequence: sequence, RequestHash: requestHash, ResultHash: resultHash,
		ReceiptHash: receiptHash, IntentID: evidence.Receipt.IntentID}); err != nil {
		return evidence, err
	}
	return evidence, nil
}

// Finish records a terminal-frame hash only after every issued effect has
// independently verified and committed. The caller validates the guest's full
// terminal frame and process exit before invoking this method.
func (s *Supervisor) Finish(ctx context.Context, valueHash string) (Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkLocked(); err != nil {
		return s.ledger.status, err
	}
	if !s.startedHere || (s.reopened && !s.resumeAuthorized) || s.ledger.status.State != StateRunning || s.ledger.status.Issued != s.ledger.status.Committed {
		return s.ledger.status, ErrRecoveryRequired
	}
	if s.config.Continuation.Enabled && s.ledger.status.Committed > 0 {
		if _, ok := s.ledger.continuations[s.ledger.status.Committed]; !ok {
			return s.ledger.status, fmt.Errorf("%w: terminal completion has no authenticated continuation for the latest effect", ErrRecoveryRequired)
		}
	}
	if err := ctx.Err(); err != nil {
		return s.ledger.status, err
	}
	if !validHash(valueHash) || !s.config.Now().Before(s.config.Plan.Deadline) {
		return s.ledger.status, fmt.Errorf("%w: invalid terminal hash or expired deadline", ErrDenied)
	}
	if err := s.cancelUnusedLocked(); err != nil {
		return s.ledger.status, err
	}
	if err := s.appendLocked(eventFinished, finishedPayload{ValueHash: valueHash}); err != nil {
		return s.ledger.status, err
	}
	return s.ledger.status, nil
}

func (s *Supervisor) Abort(ctx context.Context, code string) (Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkLocked(); err != nil {
		return s.ledger.status, err
	}
	if !codePattern.MatchString(code) {
		return s.ledger.status, fmt.Errorf("invalid supervisor failure code")
	}
	state := StateFailed
	_, hasContinuation := s.ledger.continuations[s.ledger.status.Committed]
	if s.ledger.status.Issued != s.ledger.status.Committed ||
		(s.config.Continuation.Enabled && s.ledger.status.Committed > 0 && !hasContinuation) {
		state = StateUncertain
	}
	// Cancellation does not suppress the durable stop/cleanup operation.
	err := s.stopLocked(state, code)
	return s.ledger.status, err
}

func (s *Supervisor) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	var result error
	if s.store != nil {
		result = s.store.Close()
	}
	if s.ownedReader != nil {
		result = errors.Join(result, s.ownedReader.Close())
	}
	for i := range s.config.Continuation.Key {
		s.config.Continuation.Key[i] = 0
	}
	return result
}
