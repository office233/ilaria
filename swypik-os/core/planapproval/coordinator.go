package planapproval

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"swypik-os/core/controlkernel"
	"swypik-os/core/supervisor"
	wire "swypik-os/generated/swypeffects"
)

type entry struct {
	record   Record
	history  []Record
	proposal *Proposal
	plan     *wire.EffectPlan
	cancel   context.CancelFunc
}

type Coordinator struct {
	mu         sync.Mutex
	config     Config
	store      *controlkernel.EventStore
	sequence   uint64
	entries    map[string]*entry
	active     int
	closed     bool
	storageErr error
}

func (c *Coordinator) check() error {
	if c.closed {
		return controlkernel.ErrClosed
	}
	if c.storageErr != nil {
		return errors.Join(controlkernel.ErrStorageFailed, c.storageErr)
	}
	return nil
}

func (c *Coordinator) lookup(revision Revision) (*entry, error) {
	if err := c.check(); err != nil {
		return nil, err
	}
	e, exists := c.entries[revision.ProposalID]
	if !exists {
		return nil, ErrNotFound
	}
	if revision != e.record.Revision {
		return nil, ErrRevision
	}
	return e, nil
}

func snapshot(e *entry) Snapshot {
	s := Snapshot{Record: cloneRecord(e.record), ArtifactsAvailable: e.proposal != nil, History: make([]Record, len(e.history))}
	for i, record := range e.history {
		s.History[i] = cloneRecord(record)
	}
	if e.plan != nil {
		plan := clonePlan(*e.plan)
		s.Plan = &plan
	}
	return s
}

func (c *Coordinator) Status(id string) (Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.check(); err != nil {
		return Snapshot{}, err
	}
	e, exists := c.entries[id]
	if !exists {
		return Snapshot{}, ErrNotFound
	}
	return snapshot(e), nil
}

func (c *Coordinator) Propose(ctx context.Context, id string, proposal Proposal) (Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.check(); err != nil {
		return Snapshot{}, err
	}
	if err := ctx.Err(); err != nil {
		return Snapshot{}, err
	}
	if _, exists := c.entries[id]; exists {
		return Snapshot{}, fmt.Errorf("%w: proposal IDs are never recycled", ErrState)
	}
	if len(c.entries) >= c.config.Limits.MaxProposals {
		return Snapshot{}, ErrLimit
	}
	pinned, revision, err := pin(id, 1, proposal, c.config.Limits.MaxProposalBytes)
	if err != nil {
		return Snapshot{}, err
	}
	if err := c.append(Record{Revision: revision, State: Proposed}); err != nil {
		return Snapshot{}, err
	}
	e := c.entries[id]
	e.proposal, e.plan = &pinned, &pinned.Plan
	return snapshot(e), nil
}

// Correct requires the exact current revision and always starts a new revision,
// including a byte-identical correction. No execution reservation is reversible.
func (c *Coordinator) Correct(ctx context.Context, previous Revision, proposal Proposal) (Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, err := c.lookup(previous)
	if err != nil {
		return Snapshot{}, err
	}
	if err := ctx.Err(); err != nil {
		return snapshot(e), err
	}
	if e.record.Attempted {
		return snapshot(e), ErrReplay
	}
	if !correctable(e.record) {
		return snapshot(e), ErrState
	}
	if previous.Number >= uint64(c.config.Limits.MaxRevisions) {
		return snapshot(e), ErrLimit
	}
	pinned, revision, err := pin(previous.ProposalID, previous.Number+1, proposal, c.config.Limits.MaxProposalBytes)
	if err != nil {
		return snapshot(e), err
	}
	if err := c.append(Record{Revision: revision, State: Proposed}); err != nil {
		return snapshot(e), err
	}
	if e.cancel != nil {
		e.cancel()
	}
	e.proposal, e.plan, e.cancel = &pinned, &pinned.Plan, nil
	return snapshot(e), nil
}

type verificationReply struct {
	verdict Verdict
	err     error
}

func (c *Coordinator) release() {
	c.mu.Lock()
	c.active--
	c.mu.Unlock()
}

func (c *Coordinator) Verify(ctx context.Context, revision Revision) (Snapshot, error) {
	c.mu.Lock()
	e, err := c.lookup(revision)
	if err != nil {
		c.mu.Unlock()
		return Snapshot{}, err
	}
	if e.record.State != Proposed {
		s := snapshot(e)
		c.mu.Unlock()
		return s, ErrState
	}
	if e.proposal == nil {
		c.mu.Unlock()
		return Snapshot{}, ErrArtifactsUnavailable
	}
	if err := ctx.Err(); err != nil {
		c.mu.Unlock()
		return Snapshot{}, err
	}
	if c.active >= c.config.Limits.MaxConcurrent {
		c.mu.Unlock()
		return Snapshot{}, ErrBusy
	}
	runCtx, cancel := context.WithTimeout(ctx, c.config.Limits.VerifyTimeout)
	proposal := cloneProposal(*e.proposal)
	record := cloneRecord(e.record)
	record.State = Verifying
	if err := c.append(record); err != nil {
		cancel()
		c.mu.Unlock()
		return Snapshot{}, err
	}
	e.cancel = cancel
	c.active++
	c.mu.Unlock()
	defer cancel()
	reply := make(chan verificationReply, 1)
	go func() {
		verdict, err := c.config.Verifier.VerifyPlan(runCtx, revision, proposal)
		c.release()
		reply <- verificationReply{verdict: verdict, err: err}
	}()
	var result verificationReply
	select {
	case result = <-reply:
	case <-runCtx.Done():
		result.err = runCtx.Err()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, err = c.lookup(revision)
	if err != nil {
		return Snapshot{}, err
	}
	if e.record.State != Verifying {
		return snapshot(e), errors.Join(ErrState, runCtx.Err())
	}
	e.cancel = nil
	record = cloneRecord(e.record)
	if result.err == nil {
		result.err = runCtx.Err()
	}
	if result.err == nil {
		result.err = validateVerdict(result.verdict, revision)
	}
	if result.err != nil {
		record.State, record.Code = Failed, "verification_failed"
		if errors.Is(result.err, context.DeadlineExceeded) {
			record.Code = "verification_timeout"
		}
	} else {
		record.Review = &Review{Verdict: result.verdict, VerifierID: c.config.VerifierID}
		record.State = Verified
		if result.verdict.Decision == controlkernel.VerificationFailed {
			record.State, record.Code = Rejected, result.verdict.Code
			result.err = ErrVerification
		}
	}
	if err := c.append(record); err != nil {
		return snapshot(e), errors.Join(result.err, err)
	}
	return snapshot(e), errors.Join(result.err, verificationError(record))
}

func verificationError(record Record) error {
	if record.State == Failed {
		return ErrVerification
	}
	return nil
}

func (c *Coordinator) authenticate(ctx context.Context, expectedActor, credential string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if expectedActor != c.config.ApproverID || len(credential) == 0 || len(credential) > 4096 {
		return ErrUnauthorized
	}
	principal, err := c.config.Authenticator.AuthenticateApprover(ctx, credential)
	if err != nil {
		return errors.Join(ErrUnauthorized, err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if principal.ID != expectedActor {
		return ErrUnauthorized
	}
	return nil
}

// Accept records a trusted host decision; it does not launch a guest or grant a
// capability. expectedActor cannot select the authenticated principal.
func (c *Coordinator) Accept(ctx context.Context, revision Revision, expectedActor, credential string) (Snapshot, error) {
	if err := c.authenticate(ctx, expectedActor, credential); err != nil {
		return Snapshot{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, err := c.lookup(revision)
	if err != nil {
		return Snapshot{}, err
	}
	if e.record.State != Verified || e.record.Review == nil {
		return snapshot(e), ErrState
	}
	if err := ctx.Err(); err != nil {
		return snapshot(e), err
	}
	if e.proposal == nil {
		return snapshot(e), ErrArtifactsUnavailable
	}
	record := cloneRecord(e.record)
	record.State = Approved
	record.Approval = &Approval{Revision: revision, ActorID: expectedActor}
	if err := c.append(record); err != nil {
		return snapshot(e), err
	}
	return snapshot(e), nil
}

type executionReply struct {
	result ExecutionResult
	err    error
}

func (c *Coordinator) Execute(ctx context.Context, revision Revision) (Snapshot, error) {
	c.mu.Lock()
	e, err := c.lookup(revision)
	if err != nil {
		c.mu.Unlock()
		return Snapshot{}, err
	}
	if e.record.Attempted {
		s := snapshot(e)
		c.mu.Unlock()
		if s.State == Uncertain {
			return s, ErrUncertain
		}
		return s, ErrReplay
	}
	if e.record.State != Approved || e.record.Approval == nil || e.record.Review == nil {
		c.mu.Unlock()
		return Snapshot{}, ErrState
	}
	if e.record.Approval.Revision != revision || e.record.Approval.ActorID != c.config.ApproverID ||
		e.record.Review.VerifierID != c.config.VerifierID ||
		e.record.Review.Verdict.Decision != controlkernel.VerificationPassed {
		c.mu.Unlock()
		return Snapshot{}, ErrUnauthorized
	}
	if err := validateVerdict(e.record.Review.Verdict, revision); err != nil {
		c.mu.Unlock()
		return Snapshot{}, err
	}
	if c.config.Executor == nil {
		c.mu.Unlock()
		return Snapshot{}, ErrExecutionUnavailable
	}
	if e.proposal == nil {
		c.mu.Unlock()
		return Snapshot{}, ErrArtifactsUnavailable
	}
	if err := ctx.Err(); err != nil {
		c.mu.Unlock()
		return Snapshot{}, err
	}
	if c.active >= c.config.Limits.MaxConcurrent {
		c.mu.Unlock()
		return Snapshot{}, ErrBusy
	}
	pinned, identity, err := pin(revision.ProposalID, revision.Number, *e.proposal, c.config.Limits.MaxProposalBytes)
	if err != nil || identity != revision {
		c.mu.Unlock()
		return Snapshot{}, errors.Join(ErrRevision, err)
	}
	execution := Execution{Revision: revision, Proposal: pinned, Review: *e.record.Review, Approval: *e.record.Approval}
	runCtx, cancel := context.WithTimeout(ctx, c.config.Limits.ExecuteTimeout)
	record := cloneRecord(e.record)
	record.State, record.Attempted = Running, true
	if err := c.append(record); err != nil {
		cancel()
		c.mu.Unlock()
		return Snapshot{}, err
	}
	e.cancel = cancel
	c.active++
	c.mu.Unlock()
	defer cancel()
	reply := make(chan executionReply, 1)
	go func() {
		result, err := c.config.Executor.Execute(runCtx, execution)
		c.release()
		reply <- executionReply{result: result, err: err}
	}()
	var result executionReply
	hasResult := false
	// A cancellation signal is not a stop acknowledgment. Allow the owned
	// adapter to finish cleanup within the original bounded execution window.
	deadline, _ := runCtx.Deadline()
	wait := time.NewTimer(time.Until(deadline))
	defer wait.Stop()
	select {
	case result = <-reply:
		hasResult = true
	case <-wait.C:
		select {
		case result = <-reply:
			hasResult = true
		default:
			result.err = errors.Join(ErrUncertain, context.DeadlineExceeded, runCtx.Err())
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, err = c.lookup(revision)
	if err != nil {
		return Snapshot{}, err
	}
	if e.record.State != Running {
		return snapshot(e), errors.Join(ErrState, result.err)
	}
	e.cancel = nil
	record = cloneRecord(e.record)
	record.State, record.Code = Uncertain, "execution_timeout_or_cancel"
	if hasResult {
		record.State, record.Code, err = executionOutcome(result.result, revision, record.CancelRequested, result.err)
		result.err = errors.Join(result.err, err)
		if validateExecution(result.result, revision) == nil {
			value := result.result
			record.Execution = &value
		}
	}
	if err := c.append(record); err != nil {
		return snapshot(e), errors.Join(result.err, err)
	}
	e.proposal = nil
	return snapshot(e), result.err
}

// Cancel is an idempotent host action. A cancellation request is not evidence
// that an already-started execution stopped: that stays RUNNING until proven
// terminal, or becomes UNCERTAIN on timeout/host loss.
func (c *Coordinator) Cancel(ctx context.Context, revision Revision, expectedActor, credential string) (Snapshot, error) {
	if err := c.authenticate(ctx, expectedActor, credential); err != nil {
		return Snapshot{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, err := c.lookup(revision)
	if err != nil {
		return Snapshot{}, err
	}
	switch e.record.State {
	case Succeeded, Uncertain, Cancelled:
		return snapshot(e), nil
	case Failed:
		if e.record.Attempted {
			return snapshot(e), nil
		}
	}
	if e.record.CancelRequested {
		return snapshot(e), nil
	}
	record := cloneRecord(e.record)
	record.CancelRequested = true
	if record.State != Running {
		record.State, record.Code = Cancelled, "host_cancelled"
	}
	// Even a storage failure must cancel the owned work, but never forge a
	// durable cancelled outcome. append fails closed and cancels all owners.
	if err := c.append(record); err != nil {
		return snapshot(e), err
	}
	if e.cancel != nil {
		e.cancel()
	}
	if record.State == Cancelled {
		e.proposal = nil
	}
	return snapshot(e), nil
}

func (c *Coordinator) cancelAll() {
	for _, e := range c.entries {
		if e.cancel != nil {
			e.cancel()
		}
	}
}

func (c *Coordinator) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.cancelAll()
	var result error
	for _, e := range c.entries {
		record := cloneRecord(e.record)
		switch record.State {
		case Running:
			record.State, record.Code = Uncertain, "host_closed"
		case Verifying:
			record.State, record.Code = Failed, "verification_interrupted"
		default:
			continue
		}
		result = errors.Join(result, c.append(record))
	}
	c.closed = true
	for _, e := range c.entries {
		e.proposal, e.plan = nil, nil
	}
	return errors.Join(result, c.store.Close())
}

func validateExecution(result ExecutionResult, revision Revision) error {
	s := result.Status
	if !result.Started && s == (supervisor.Snapshot{}) {
		return nil
	}
	if s.ModuleHash != revision.ModuleHash || !validHash(s.PlanHash) || !idPattern.MatchString(s.TaskID) ||
		!idPattern.MatchString(s.RunID) || s.Issued > supervisor.MaxPlanEffects || s.Committed > s.Issued ||
		s.ReservedReadBytes < 0 || s.ReservedReadBytes > 64<<20 ||
		s.FailureCode != "" && !codePattern.MatchString(s.FailureCode) ||
		s.FinalValueHash != "" && !validHash(s.FinalValueHash) {
		return fmt.Errorf("%w: supervisor outcome identity or bounds", ErrRevision)
	}
	switch s.State {
	case supervisor.StateReady:
		if result.Started {
			return ErrState
		}
	case supervisor.StateRunning, supervisor.StateUncertain:
		if !result.Started {
			return ErrState
		}
	case supervisor.StateFailed:
		if s.Issued != s.Committed {
			return ErrUncertain
		}
	case supervisor.StateSucceeded:
		if !result.Started || !validHash(s.FinalValueHash) || s.Issued != s.Committed || s.FailureCode != "" {
			return ErrState
		}
	default:
		return ErrState
	}
	return nil
}

func executionOutcome(result ExecutionResult, revision Revision, cancelled bool, cause error) (State, string, error) {
	if err := validateExecution(result, revision); err != nil {
		return Uncertain, "execution_evidence_invalid", errors.Join(ErrUncertain, err)
	}
	if !result.Started {
		if cause == nil {
			return Uncertain, "execution_evidence_missing", ErrUncertain
		}
		if cancelled {
			return Cancelled, "host_cancelled", nil
		}
		return Failed, "execution_not_started", nil
	}
	switch result.Status.State {
	case supervisor.StateSucceeded:
		if cancelled {
			return Uncertain, "cancel_raced_completion", ErrUncertain
		}
		if cause == nil {
			return Succeeded, "", nil
		}
	case supervisor.StateFailed:
		if cancelled {
			return Cancelled, "host_cancelled", nil
		}
		return Failed, "execution_failed", fmt.Errorf("%w: supervisor execution failed", ErrState)
	}
	return Uncertain, "execution_uncertain", ErrUncertain
}
