package controlkernel

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Option configures a Kernel without making production code depend on a test
// clock or a concrete scheduler implementation.
type Option func(*Kernel)

// WithClock installs a clock used for leases and durable domain timestamps.
// It is primarily useful for deterministic fault-injection tests.
func WithClock(now func() time.Time) Option {
	return func(k *Kernel) {
		if now != nil {
			k.now = now
		}
	}
}

// WithVerifierAuthenticator installs the external authority boundary used to
// authenticate verifier credentials. The credential itself is never persisted.
func WithVerifierAuthenticator(authenticator VerifierAuthenticator) Option {
	return func(k *Kernel) {
		k.verifierAuthenticator = authenticator
	}
}

// WithExecutorAuthenticator installs the external authority boundary used to
// authenticate lease claimants. The credential itself is never persisted.
func WithExecutorAuthenticator(authenticator ExecutorAuthenticator) Option {
	return func(k *Kernel) {
		k.executorAuthenticator = authenticator
	}
}

// Kernel is the durable M1 control-plane facade. All mutations are serialized
// through one event stream; the journal fsync completes before the projection
// is advanced or any caller is told that the mutation succeeded.
type Kernel struct {
	mu                    sync.Mutex
	store                 *EventStore
	projection            *Projection
	now                   func() time.Time
	executorAuthenticator ExecutorAuthenticator
	verifierAuthenticator VerifierAuthenticator
	closed                bool
	failed                error
}

func OpenKernel(journalPath string, options ...Option) (*Kernel, error) {
	store, err := OpenEventStore(journalPath)
	if err != nil {
		return nil, err
	}
	projection, err := BuildProjection(store.Events())
	if err != nil {
		_ = store.Close()
		return nil, fmt.Errorf("rebuild control-kernel projection: %w", err)
	}
	// The durable event log lives on disk. After replay, the Projection is the
	// active in-memory state, so retaining every historical Event as well would
	// duplicate memory indefinitely on long-running devices.
	store.DisableEventRetention()
	k := &Kernel{
		store:      store,
		projection: projection,
		now:        func() time.Time { return time.Now().UTC() },
	}
	for _, option := range options {
		option(k)
	}
	return k, nil
}

func (k *Kernel) checkOpenLocked() error {
	if k.closed {
		return ErrClosed
	}
	if k.failed != nil {
		return fmt.Errorf("%w: %v", ErrStorageFailed, k.failed)
	}
	return nil
}

func (k *Kernel) authenticateVerifierLocked(credential, expectedID string) (VerifierPrincipal, error) {
	if k.verifierAuthenticator == nil {
		return VerifierPrincipal{}, fmt.Errorf("%w: no verifier authenticator configured", ErrVerifierUnauthorized)
	}
	principal, err := k.verifierAuthenticator.AuthenticateVerifier(credential)
	if err != nil || principal.ID == "" {
		return VerifierPrincipal{}, fmt.Errorf("%w: credential rejected", ErrVerifierUnauthorized)
	}
	if expectedID != "" && principal.ID != expectedID {
		return VerifierPrincipal{}, fmt.Errorf("%w: authenticated verifier does not match expected identity", ErrVerifierUnauthorized)
	}
	return principal, nil
}

// ValidateVerifierCredential authenticates a verifier without recording a
// verdict. Integration code uses this as a preflight before starting an
// external side effect whose later commit will depend on that verifier.
func (k *Kernel) ValidateVerifierCredential(credential, expectedID string) (VerifierPrincipal, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return VerifierPrincipal{}, err
	}
	return k.authenticateVerifierLocked(credential, expectedID)
}

func (k *Kernel) appendLocked(events ...Event) error {
	if err := k.checkOpenLocked(); err != nil {
		return err
	}
	persisted, err := k.store.Append(controlStream, k.projection.Sequence, events...)
	if err != nil {
		if errors.Is(err, ErrStorageFailed) {
			k.failed = err
		}
		return err
	}
	for _, event := range persisted {
		if err := k.projection.Apply(event); err != nil {
			// This means a durable event passed pre-validation but cannot be
			// projected. Stop all further work; reopening will also fail closed.
			k.failed = err
			return fmt.Errorf("%w: durable projection failure: %v", ErrStorageFailed, err)
		}
	}
	return nil
}

func (k *Kernel) makeEvent(kind string, payload any) (Event, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return Event{}, err
	}
	return Event{Type: kind, At: k.now().UTC(), Data: raw}, nil
}

func (k *Kernel) CreateTask(task Task) (Task, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Task{}, err
	}
	if task.ID == "" {
		id, err := randomID()
		if err != nil {
			return Task{}, err
		}
		task.ID = id
	}
	if task.Goal == "" {
		return Task{}, fmt.Errorf("task goal is required")
	}
	if task.TopologyFrozen {
		return Task{}, fmt.Errorf("new task topology must start mutable")
	}
	if _, exists := k.projection.Tasks[task.ID]; exists {
		return Task{}, fmt.Errorf("%w: task %q already exists", ErrConflict, task.ID)
	}
	if task.CreatedAt.IsZero() {
		task.CreatedAt = k.now().UTC()
	} else {
		task.CreatedAt = task.CreatedAt.UTC()
	}
	task = cloneTask(task)
	event, err := k.makeEvent(eventTaskCreated, task)
	if err != nil {
		return Task{}, err
	}
	if err := k.appendLocked(event); err != nil {
		return Task{}, err
	}
	return cloneTask(task), nil
}

func (k *Kernel) AddNode(node Node) (Node, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Node{}, err
	}
	if node.TaskID == "" {
		return Node{}, fmt.Errorf("node task id is required")
	}
	task, ok := k.projection.Tasks[node.TaskID]
	if !ok {
		return Node{}, fmt.Errorf("%w: task %q", ErrNotFound, node.TaskID)
	}
	if task.TopologyFrozen {
		return Node{}, fmt.Errorf("%w: task %q topology is frozen", ErrConflict, node.TaskID)
	}
	if node.ID == "" {
		id, err := randomID()
		if err != nil {
			return Node{}, err
		}
		node.ID = id
	}
	if _, exists := k.projection.Nodes[node.ID]; exists {
		return Node{}, fmt.Errorf("%w: node %q already exists", ErrConflict, node.ID)
	}
	if node.State == "" {
		node.State = NodePending
	}
	if node.State != NodePending {
		return Node{}, fmt.Errorf("new nodes must start PENDING")
	}
	event, err := k.makeEvent(eventNodeAdded, node)
	if err != nil {
		return Node{}, err
	}
	if err := k.appendLocked(event); err != nil {
		return Node{}, err
	}
	return node, nil
}

func (k *Kernel) AddEdge(edge Edge) (Edge, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Edge{}, err
	}
	from, fromOK := k.projection.Nodes[edge.From]
	to, toOK := k.projection.Nodes[edge.To]
	if !fromOK || !toOK || edge.From == edge.To || from.TaskID != to.TaskID {
		return Edge{}, fmt.Errorf("edge endpoints must be distinct nodes in one task")
	}
	if edge.TaskID == "" {
		edge.TaskID = from.TaskID
	}
	if edge.TaskID != from.TaskID {
		return Edge{}, fmt.Errorf("edge task does not match endpoints")
	}
	task := k.projection.Tasks[edge.TaskID]
	if task.TopologyFrozen {
		return Edge{}, fmt.Errorf("%w: task %q topology is frozen", ErrConflict, edge.TaskID)
	}
	if edge.ID == "" {
		id, err := randomID()
		if err != nil {
			return Edge{}, err
		}
		edge.ID = id
	}
	if _, exists := k.projection.Edges[edge.ID]; exists {
		return Edge{}, fmt.Errorf("%w: edge %q already exists", ErrConflict, edge.ID)
	}
	if k.wouldCreateCycleLocked(edge.From, edge.To) {
		return Edge{}, fmt.Errorf("%w: edge %s -> %s creates a cycle", ErrConflict, edge.From, edge.To)
	}
	event, err := k.makeEvent(eventEdgeAdded, edge)
	if err != nil {
		return Edge{}, err
	}
	if err := k.appendLocked(event); err != nil {
		return Edge{}, err
	}
	return edge, nil
}

func (k *Kernel) wouldCreateCycleLocked(from, to string) bool {
	adjacency := make(map[string][]string)
	for _, edge := range k.projection.Edges {
		adjacency[edge.From] = append(adjacency[edge.From], edge.To)
	}
	adjacency[from] = append(adjacency[from], to)
	seen := make(map[string]bool)
	var reaches func(string) bool
	reaches = func(node string) bool {
		if node == from {
			return true
		}
		if seen[node] {
			return false
		}
		seen[node] = true
		for _, next := range adjacency[node] {
			if reaches(next) {
				return true
			}
		}
		return false
	}
	return reaches(to)
}

func (k *Kernel) dependenciesSatisfiedLocked(nodeID string) bool {
	for _, edge := range k.projection.Edges {
		if edge.To == nodeID && k.projection.Nodes[edge.From].State != NodeSucceeded {
			return false
		}
	}
	return true
}

func transitionRequiresLease(from, to NodeState) bool {
	switch from {
	case NodeLeased, NodePreparing, NodeExecuting, NodeVerifying, NodeCommitting, NodeUncertain, NodeReconciling:
		return true
	}
	switch to {
	case NodeUncertain, NodeReconciling:
		return true
	}
	return false
}

// TransitionNode persists one validated state transition. READY->LEASED is
// reserved for ClaimLease so ownership and state become durable atomically.
func (k *Kernel) TransitionNode(nodeID string, to NodeState, token LeaseToken) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return err
	}
	node, ok := k.projection.Nodes[nodeID]
	if !ok {
		return fmt.Errorf("%w: node %q", ErrNotFound, nodeID)
	}
	if to == NodeLeased {
		return fmt.Errorf("%w: READY -> LEASED must use ClaimLease", ErrInvalidTransition)
	}
	if err := validateTransition(node.State, to); err != nil {
		return err
	}
	if (to == NodeReady) && !k.dependenciesSatisfiedLocked(nodeID) {
		return fmt.Errorf("%w: node %q dependencies are not satisfied", ErrConflict, nodeID)
	}
	if transitionRequiresLease(node.State, to) {
		if token.LeaseID != "" {
			if _, err := k.validateLeaseLocked(nodeID, token); err != nil {
				return err
			}
		} else {
			if to == NodeOperatorRequired {
				// Escalation to the operator is the explicit safety valve: it
				// halts automation and is allowed even while a lease is live
				// (see TestQAA3UnresolvedExternalRealityCannotTerminalize).
			} else if k.hasLiveLeaseLocked(nodeID) {
				return fmt.Errorf("%w: authorizing lease is still live", ErrConflict)
			} else if node.State != NodeUncertain && node.State != NodeReconciling {
				return ErrStaleLease
			}
		}
	}
	if node.State == NodeVerifying && to == NodeCommitting && !k.hasPassedVerificationForCurrentAttemptLocked(nodeID) {
		return fmt.Errorf("%w: node %q has no passing verification for current attempt/fence", ErrConflict, nodeID)
	}
	if node.State == NodeExecuting && to == NodeVerifying && k.hasIntentBlockingVerificationLocked(nodeID) {
		return fmt.Errorf("%w: node %q has unresolved side-effect intent", ErrConflict, nodeID)
	}
	if node.State == NodeExecuting && to == NodeRetryWait && k.hasIntentBlockingRetryLocked(nodeID) {
		return fmt.Errorf("%w: node %q has externally-observed side-effect intent", ErrConflict, nodeID)
	}
	if to == NodeRetryWait && k.hasUnresolvedExternalIntentLocked(nodeID) {
		return fmt.Errorf("%w: node %q cannot retry before external reality is reconciled", ErrConflict, nodeID)
	}
	if (to == NodeFailed || to == NodeCancelled || to == NodeBlocked) && k.hasUnresolvedExternalIntentLocked(nodeID) {
		return fmt.Errorf("%w: node %q has unresolved external side effect; reconcile or escalate to OPERATOR_REQUIRED", ErrConflict, nodeID)
	}
	if node.State == NodeReconciling && to == NodeSucceeded {
		hasPassed := k.hasPassedVerificationLocked(nodeID)
		intentCount, allCommitted := k.nodeIntentStatsLocked(nodeID)
		if !hasPassed && (intentCount == 0 || !allCommitted) {
			return fmt.Errorf("%w: node %q reconciling to succeeded requires passed verification or committed intents", ErrConflict, nodeID)
		}
	}
	if (node.State == NodeCommitting || node.State == NodeReconciling) && to == NodeSucceeded && !k.allIntentsCommittedLocked(nodeID) {
		return fmt.Errorf("%w: node %q has uncommitted side-effect intent", ErrConflict, nodeID)
	}
	events := make([]Event, 0, 2)
	if to == NodeReady {
		task := k.projection.Tasks[node.TaskID]
		if !task.TopologyFrozen {
			freeze, err := k.makeEvent(eventTaskTopologyFrozen, taskTopologyFrozenPayload{TaskID: task.ID})
			if err != nil {
				return err
			}
			events = append(events, freeze)
		}
	}
	event, err := k.makeEvent(eventNodeTransitioned, nodeTransitionPayload{NodeID: nodeID, From: node.State, To: to})
	if err != nil {
		return err
	}
	events = append(events, event)
	return k.appendLocked(events...)
}

func (k *Kernel) ClaimLease(nodeID, executorCredential, owner string, ttl time.Duration) (Lease, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Lease{}, err
	}
	if owner == "" || executorCredential == "" || ttl <= 0 {
		return Lease{}, fmt.Errorf("executor credential, lease owner and positive ttl are required")
	}
	if k.executorAuthenticator == nil {
		return Lease{}, fmt.Errorf("%w: no executor authenticator configured", ErrExecutorUnauthorized)
	}
	principal, err := k.executorAuthenticator.AuthenticateExecutor(executorCredential)
	if err != nil || principal.ID == "" {
		return Lease{}, fmt.Errorf("%w: credential rejected", ErrExecutorUnauthorized)
	}
	node, ok := k.projection.Nodes[nodeID]
	if !ok {
		return Lease{}, fmt.Errorf("%w: node %q", ErrNotFound, nodeID)
	}
	if node.State != NodeReady || !k.dependenciesSatisfiedLocked(nodeID) {
		return Lease{}, fmt.Errorf("%w: node %q is not schedulable", ErrConflict, nodeID)
	}
	if task := k.projection.Tasks[node.TaskID]; !task.TopologyFrozen {
		return Lease{}, fmt.Errorf("%w: task %q topology is not frozen", ErrConflict, node.TaskID)
	}
	if current, exists := k.projection.Leases[nodeID]; exists && !current.Released && k.now().UTC().Before(current.ExpiresAt) {
		return Lease{}, fmt.Errorf("%w: node %q already leased", ErrConflict, nodeID)
	}
	id, err := randomID()
	if err != nil {
		return Lease{}, err
	}
	attemptID, err := randomID()
	if err != nil {
		return Lease{}, err
	}
	now := k.now().UTC()
	fence := k.projection.MaxFence[nodeID] + 1
	attemptNumber := 1
	for _, existing := range k.projection.Attempts {
		if existing.NodeID == nodeID && existing.Number >= attemptNumber {
			attemptNumber = existing.Number + 1
		}
	}
	lease := Lease{
		ID:         id,
		TaskID:     node.TaskID,
		NodeID:     node.ID,
		AttemptID:  attemptID,
		Owner:      owner,
		ExecutorID: principal.ID,
		Fence:      fence,
		GrantedAt:  now,
		ExpiresAt:  now.Add(ttl),
	}
	attempt := Attempt{
		ID:        attemptID,
		TaskID:    node.TaskID,
		NodeID:    node.ID,
		Number:    attemptNumber,
		Status:    AttemptPreparing,
		LeaseID:   id,
		Fence:     fence,
		StartedAt: now,
	}
	attemptEvent, err := k.makeEvent(eventAttemptRecorded, attempt)
	if err != nil {
		return Lease{}, err
	}
	grant, err := k.makeEvent(eventLeaseGranted, lease)
	if err != nil {
		return Lease{}, err
	}
	transition, err := k.makeEvent(eventNodeTransitioned, nodeTransitionPayload{NodeID: nodeID, From: NodeReady, To: NodeLeased})
	if err != nil {
		return Lease{}, err
	}
	if err := k.appendLocked(attemptEvent, grant, transition); err != nil {
		return Lease{}, err
	}
	return lease, nil
}

func (k *Kernel) validateLeaseLocked(nodeID string, token LeaseToken) (Lease, error) {
	lease, ok := k.projection.Leases[nodeID]
	if !ok || lease.Released || token.LeaseID == "" || lease.ID != token.LeaseID || lease.Fence != token.Fence {
		return Lease{}, ErrStaleLease
	}
	if !k.now().UTC().Before(lease.ExpiresAt) {
		return Lease{}, ErrLeaseExpired
	}
	return lease, nil
}

func (k *Kernel) ValidateLease(nodeID string, token LeaseToken) (Lease, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Lease{}, err
	}
	return k.validateLeaseLocked(nodeID, token)
}

func (k *Kernel) RenewLease(nodeID string, token LeaseToken, ttl time.Duration) (Lease, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Lease{}, err
	}
	if ttl <= 0 {
		return Lease{}, fmt.Errorf("positive lease ttl is required")
	}
	lease, err := k.validateLeaseLocked(nodeID, token)
	if err != nil {
		return Lease{}, err
	}
	lease.ExpiresAt = k.now().UTC().Add(ttl)
	payload := leaseRenewedPayload{
		NodeID:    nodeID,
		LeaseID:   lease.ID,
		Fence:     lease.Fence,
		ExpiresAt: lease.ExpiresAt.Format(time.RFC3339Nano),
	}
	event, err := k.makeEvent(eventLeaseRenewed, payload)
	if err != nil {
		return Lease{}, err
	}
	if err := k.appendLocked(event); err != nil {
		return Lease{}, err
	}
	return lease, nil
}

func (k *Kernel) epochIntentsLocked(lease Lease) []Intent {
	intents := make([]Intent, 0)
	for _, intent := range k.projection.Intents {
		if intent.NodeID == lease.NodeID && intent.AttemptID == lease.AttemptID && intent.LeaseID == lease.ID && intent.Fence == lease.Fence {
			intents = append(intents, intent)
		}
	}
	sort.Slice(intents, func(i, j int) bool { return intents[i].ID < intents[j].ID })
	return intents
}

func epochHasExternalReality(intents []Intent) bool {
	for _, intent := range intents {
		switch intent.State {
		case IntentStarted, IntentResult, IntentUncertain, IntentReconciling, IntentCommitted:
			return true
		}
	}
	return false
}

func epochAllCommitted(intents []Intent) bool {
	for _, intent := range intents {
		if intent.State != IntentCommitted {
			return false
		}
	}
	return true
}

func (k *Kernel) makeIntentStateEventLocked(intent Intent, to IntentState, externalRef, resultHash string) (Event, error) {
	if !canTransitionIntent(intent.State, to) {
		return Event{}, fmt.Errorf("%w: %s -> %s", ErrInvalidIntentState, intent.State, to)
	}
	payload := intentStatePayload{
		IntentID:    intent.ID,
		From:        intent.State,
		To:          to,
		ExternalRef: externalRef,
		ResultHash:  resultHash,
		UpdatedAt:   k.now().UTC().Format(time.RFC3339Nano),
	}
	return k.makeEvent(eventIntentStateChanged, payload)
}

func (k *Kernel) recoveryIntentEventsLocked(intents []Intent, reconcile bool) ([]Event, error) {
	events := make([]Event, 0)
	for _, intent := range intents {
		switch intent.State {
		case IntentPrepared:
			if reconcile {
				event, err := k.makeIntentStateEventLocked(intent, IntentAbandoned, "", "")
				if err != nil {
					return nil, err
				}
				events = append(events, event)
			}
		case IntentStarted:
			uncertain, err := k.makeIntentStateEventLocked(intent, IntentUncertain, "", "")
			if err != nil {
				return nil, err
			}
			events = append(events, uncertain)
			if reconcile {
				asUncertain := intent
				asUncertain.State = IntentUncertain
				reconciling, err := k.makeIntentStateEventLocked(asUncertain, IntentReconciling, "", "")
				if err != nil {
					return nil, err
				}
				events = append(events, reconciling)
			}
		case IntentResult:
			if reconcile {
				event, err := k.makeIntentStateEventLocked(intent, IntentReconciling, "", "")
				if err != nil {
					return nil, err
				}
				events = append(events, event)
			}
		case IntentUncertain:
			if reconcile {
				event, err := k.makeIntentStateEventLocked(intent, IntentReconciling, "", "")
				if err != nil {
					return nil, err
				}
				events = append(events, event)
			}
		case IntentReconciling, IntentCommitted, IntentAbandoned:
			// Already on a control-plane-only path or resolved.
		}
	}
	return events, nil
}

// RequeueExpiredLease is scheduler/recovery authority, not a worker heartbeat.
// It is a total recovery table for durable execution phases. PREPARED-only work
// may be retried under a new attempt; any phase that could reflect external
// reality enters reconciliation and is never blindly replayed.
func (k *Kernel) RequeueExpiredLease(nodeID string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return err
	}
	node, ok := k.projection.Nodes[nodeID]
	if !ok {
		return fmt.Errorf("%w: node %q", ErrNotFound, nodeID)
	}
	lease, ok := k.projection.Leases[nodeID]
	if !ok || lease.Released {
		return ErrStaleLease
	}
	if k.now().UTC().Before(lease.ExpiresAt) {
		return fmt.Errorf("%w: lease is still live", ErrConflict)
	}
	release, err := k.makeEvent(eventLeaseReleased, leaseReleasedPayload{NodeID: nodeID, LeaseID: lease.ID, Fence: lease.Fence})
	if err != nil {
		return err
	}
	events := []Event{release}
	intents := k.epochIntentsLocked(lease)
	externalReality := epochHasExternalReality(intents)
	appendRetryReady := func(from NodeState) error {
		if err := validateTransition(from, NodeRetryWait); err != nil {
			return err
		}
		retry, err := k.makeEvent(eventNodeTransitioned, nodeTransitionPayload{NodeID: nodeID, From: from, To: NodeRetryWait})
		if err != nil {
			return err
		}
		ready, err := k.makeEvent(eventNodeTransitioned, nodeTransitionPayload{NodeID: nodeID, From: NodeRetryWait, To: NodeReady})
		if err != nil {
			return err
		}
		events = append(events, retry, ready)
		return nil
	}
	appendReconciliation := func(from NodeState) error {
		intentEvents, err := k.recoveryIntentEventsLocked(intents, true)
		if err != nil {
			return err
		}
		events = append(events, intentEvents...)
		if from != NodeUncertain {
			if err := validateTransition(from, NodeUncertain); err != nil {
				return err
			}
			uncertain, eventErr := k.makeEvent(eventNodeTransitioned, nodeTransitionPayload{NodeID: nodeID, From: from, To: NodeUncertain})
			if eventErr != nil {
				return eventErr
			}
			events = append(events, uncertain)
		}
		if err := validateTransition(NodeUncertain, NodeReconciling); err != nil {
			return err
		}
		reconciling, err := k.makeEvent(eventNodeTransitioned, nodeTransitionPayload{NodeID: nodeID, From: NodeUncertain, To: NodeReconciling})
		if err != nil {
			return err
		}
		events = append(events, reconciling)
		return nil
	}
	switch node.State {
	case NodeLeased, NodePreparing:
		if err := appendRetryReady(node.State); err != nil {
			return err
		}
	case NodeExecuting:
		if externalReality {
			if err := appendReconciliation(NodeExecuting); err != nil {
				return err
			}
		} else if err := appendRetryReady(NodeExecuting); err != nil {
			return err
		}
	case NodeVerifying:
		if externalReality {
			if err := appendReconciliation(NodeVerifying); err != nil {
				return err
			}
		} else if err := appendRetryReady(NodeVerifying); err != nil {
			return err
		}
	case NodeCommitting:
		if epochAllCommitted(intents) && k.hasPassedVerificationForAttemptLocked(nodeID, lease.AttemptID, lease.ID, lease.Fence) {
			succeeded, eventErr := k.makeEvent(eventNodeTransitioned, nodeTransitionPayload{NodeID: nodeID, From: NodeCommitting, To: NodeSucceeded})
			if eventErr != nil {
				return eventErr
			}
			events = append(events, succeeded)
		} else if err := appendReconciliation(NodeCommitting); err != nil {
			return err
		}
	case NodeUncertain:
		if err := appendReconciliation(NodeUncertain); err != nil {
			return err
		}
	case NodeReconciling:
		intentEvents, eventErr := k.recoveryIntentEventsLocked(intents, true)
		if eventErr != nil {
			return eventErr
		}
		events = append(events, intentEvents...)
	case NodePending, NodeReady, NodeRetryWait, NodeSucceeded, NodeFailed, NodeCancelled, NodeBlocked, NodeOperatorRequired:
		// Lease cleanup only. These states already have a durable scheduler or
		// terminal continuation path and must not be rewritten on recovery.
	default:
		return fmt.Errorf("%w: cannot recover expired lease from node state %s", ErrConflict, node.State)
	}
	return k.appendLocked(events...)
}

func sameIntentOperation(a, b Intent) bool {
	return a.TaskID == b.TaskID && a.NodeID == b.NodeID && a.Kind == b.Kind && a.RequestHash == b.RequestHash
}

// PrepareIntent durably records a side effect before execution. A repeated
// idempotency key for the same logical operation returns the original record;
// the same key for different data fails closed.
func (k *Kernel) PrepareIntent(intent Intent, token LeaseToken) (Intent, bool, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Intent{}, false, err
	}
	if intent.IdempotencyKey == "" || intent.Kind == "" || intent.RequestHash == "" {
		return Intent{}, false, fmt.Errorf("intent kind, idempotency key and request hash are required")
	}
	node, ok := k.projection.Nodes[intent.NodeID]
	if !ok {
		return Intent{}, false, fmt.Errorf("%w: node %q", ErrNotFound, intent.NodeID)
	}
	if node.State != NodePreparing {
		return Intent{}, false, fmt.Errorf("%w: intent must be prepared while node is PREPARING", ErrInvalidIntentState)
	}
	lease, err := k.validateLeaseLocked(node.ID, token)
	if err != nil {
		return Intent{}, false, err
	}
	if intent.TaskID == "" {
		intent.TaskID = node.TaskID
	}
	if intent.TaskID != node.TaskID {
		return Intent{}, false, fmt.Errorf("intent task does not match node")
	}
	attempt, ok := k.projection.Attempts[lease.AttemptID]
	if !ok || attempt.NodeID != node.ID || attempt.LeaseID != lease.ID || attempt.Fence != lease.Fence {
		return Intent{}, false, fmt.Errorf("%w: current lease has no valid attempt epoch", ErrConflict)
	}
	if existingID, ok := k.projection.IntentKeys[intent.IdempotencyKey]; ok {
		existing := k.projection.Intents[existingID]
		if !sameIntentOperation(existing, intent) {
			return Intent{}, false, ErrIdempotencyConflict
		}
		if existing.AttemptID == attempt.ID && existing.LeaseID == lease.ID && existing.Fence == lease.Fence {
			return existing, false, nil
		}
		if existing.State == IntentCommitted {
			return existing, false, nil
		}
		if existing.State == IntentPrepared || existing.State == IntentAbandoned {
			payload := intentReboundPayload{
				IntentID:  existing.ID,
				From:      existing.State,
				AttemptID: attempt.ID,
				LeaseID:   lease.ID,
				Fence:     lease.Fence,
				UpdatedAt: k.now().UTC().Format(time.RFC3339Nano),
			}
			event, eventErr := k.makeEvent(eventIntentRebound, payload)
			if eventErr != nil {
				return Intent{}, false, eventErr
			}
			if eventErr = k.appendLocked(event); eventErr != nil {
				return Intent{}, false, eventErr
			}
			return k.projection.Intents[existing.ID], false, nil
		}
		return Intent{}, false, fmt.Errorf("%w: existing intent %q in %s requires reconciliation, not replay", ErrConflict, existing.ID, existing.State)
	}
	if intent.ID == "" {
		intent.ID, err = randomID()
		if err != nil {
			return Intent{}, false, err
		}
	}
	now := k.now().UTC()
	intent.State = IntentPrepared
	intent.AttemptID = attempt.ID
	intent.LeaseID = lease.ID
	intent.Fence = lease.Fence
	intent.CreatedAt = now
	intent.UpdatedAt = now
	event, err := k.makeEvent(eventIntentPrepared, intent)
	if err != nil {
		return Intent{}, false, err
	}
	if err := k.appendLocked(event); err != nil {
		return Intent{}, false, err
	}
	return intent, true, nil
}

func (k *Kernel) changeIntentLocked(intent Intent, to IntentState, externalRef, resultHash string) (Intent, error) {
	event, err := k.makeIntentStateEventLocked(intent, to, externalRef, resultHash)
	if err != nil {
		return Intent{}, err
	}
	if err := k.appendLocked(event); err != nil {
		return Intent{}, err
	}
	updated := k.projection.Intents[intent.ID]
	return updated, nil
}

func (k *Kernel) StartIntent(intentID string, token LeaseToken) (Intent, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Intent{}, err
	}
	intent, ok := k.projection.Intents[intentID]
	if !ok {
		return Intent{}, fmt.Errorf("%w: intent %q", ErrNotFound, intentID)
	}
	node := k.projection.Nodes[intent.NodeID]
	if node.State != NodeExecuting {
		return Intent{}, fmt.Errorf("%w: intent can start only while node is EXECUTING", ErrInvalidIntentState)
	}
	lease, err := k.validateLeaseLocked(intent.NodeID, token)
	if err != nil {
		return Intent{}, err
	}
	if intent.AttemptID != lease.AttemptID || intent.LeaseID != token.LeaseID || intent.Fence != token.Fence {
		return Intent{}, ErrStaleLease
	}
	return k.changeIntentLocked(intent, IntentStarted, "", "")
}

func (k *Kernel) RecordIntentResult(intentID string, token LeaseToken, externalRef, resultHash string) (Intent, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Intent{}, err
	}
	intent, ok := k.projection.Intents[intentID]
	if !ok {
		return Intent{}, fmt.Errorf("%w: intent %q", ErrNotFound, intentID)
	}
	if resultHash == "" {
		return Intent{}, fmt.Errorf("result hash is required")
	}
	lease, err := k.validateLeaseLocked(intent.NodeID, token)
	if err != nil {
		return Intent{}, err
	}
	if intent.AttemptID != lease.AttemptID || intent.LeaseID != token.LeaseID || intent.Fence != token.Fence {
		return Intent{}, ErrStaleLease
	}
	return k.changeIntentLocked(intent, IntentResult, externalRef, resultHash)
}

// MarkIntentUncertain is the live-worker path for a lost/ambiguous external
// acknowledgement. The current lease must still match; after lease loss or a
// crash RecoverStartedIntent is the control-plane path instead.
func (k *Kernel) MarkIntentUncertain(intentID string, token LeaseToken) (Intent, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Intent{}, err
	}
	intent, ok := k.projection.Intents[intentID]
	if !ok {
		return Intent{}, fmt.Errorf("%w: intent %q", ErrNotFound, intentID)
	}
	lease, err := k.validateLeaseLocked(intent.NodeID, token)
	if err != nil {
		return Intent{}, err
	}
	if intent.AttemptID != lease.AttemptID || intent.LeaseID != token.LeaseID || intent.Fence != token.Fence {
		return Intent{}, ErrStaleLease
	}
	return k.changeIntentLocked(intent, IntentUncertain, "", "")
}

func (k *Kernel) CommitIntent(intentID string, token LeaseToken) (Intent, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Intent{}, err
	}
	intent, ok := k.projection.Intents[intentID]
	if !ok {
		return Intent{}, fmt.Errorf("%w: intent %q", ErrNotFound, intentID)
	}
	if intent.State != IntentResult {
		return Intent{}, fmt.Errorf("%w: direct commit requires RESULT", ErrInvalidIntentState)
	}
	lease, err := k.validateLeaseLocked(intent.NodeID, token)
	if err != nil {
		return Intent{}, err
	}
	if intent.AttemptID != lease.AttemptID || intent.LeaseID != token.LeaseID || intent.Fence != token.Fence {
		return Intent{}, ErrStaleLease
	}
	if node := k.projection.Nodes[intent.NodeID]; node.State != NodeCommitting {
		return Intent{}, fmt.Errorf("%w: direct intent commit requires COMMITTING node", ErrInvalidIntentState)
	}
	return k.changeIntentLocked(intent, IntentCommitted, "", "")
}

// RecoverStartedIntent converts an ambiguous STARTED effect into UNCERTAIN only
// after its authorizing lease is no longer live. It never executes or replays
// the effect.
func (k *Kernel) RecoverStartedIntent(intentID string) (Intent, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Intent{}, err
	}
	intent, ok := k.projection.Intents[intentID]
	if !ok {
		return Intent{}, fmt.Errorf("%w: intent %q", ErrNotFound, intentID)
	}
	if intent.State != IntentStarted {
		return Intent{}, fmt.Errorf("%w: recovery requires STARTED", ErrInvalidIntentState)
	}
	if lease, ok := k.projection.Leases[intent.NodeID]; ok && !lease.Released && lease.ID == intent.LeaseID && lease.Fence == intent.Fence && k.now().UTC().Before(lease.ExpiresAt) {
		return Intent{}, fmt.Errorf("%w: authorizing lease is still live", ErrConflict)
	}
	node := k.projection.Nodes[intent.NodeID]
	events := make([]Event, 0, 2)
	uncertainIntent, err := k.makeIntentStateEventLocked(intent, IntentUncertain, "", "")
	if err != nil {
		return Intent{}, err
	}
	events = append(events, uncertainIntent)
	if node.State == NodeExecuting {
		uncertainNode, eventErr := k.makeEvent(eventNodeTransitioned, nodeTransitionPayload{NodeID: node.ID, From: NodeExecuting, To: NodeUncertain})
		if eventErr != nil {
			return Intent{}, eventErr
		}
		events = append(events, uncertainNode)
	} else if node.State != NodeUncertain && node.State != NodeReconciling {
		return Intent{}, fmt.Errorf("%w: STARTED recovery incompatible with node state %s", ErrConflict, node.State)
	}
	if err := k.appendLocked(events...); err != nil {
		return Intent{}, err
	}
	return k.projection.Intents[intent.ID], nil
}

func (k *Kernel) BeginReconciliation(intentID string) (Intent, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Intent{}, err
	}
	intent, ok := k.projection.Intents[intentID]
	if !ok {
		return Intent{}, fmt.Errorf("%w: intent %q", ErrNotFound, intentID)
	}
	if intent.State == IntentReconciling {
		return intent, nil
	}
	if intent.State != IntentUncertain && intent.State != IntentResult {
		return Intent{}, fmt.Errorf("%w: reconciliation requires UNCERTAIN or RESULT intent", ErrInvalidIntentState)
	}
	node := k.projection.Nodes[intent.NodeID]
	if node.State != NodeUncertain && node.State != NodeReconciling {
		return Intent{}, fmt.Errorf("%w: reconciliation requires UNCERTAIN/RECONCILING node", ErrInvalidIntentState)
	}
	event, err := k.makeIntentStateEventLocked(intent, IntentReconciling, "", "")
	if err != nil {
		return Intent{}, err
	}
	events := []Event{event}
	if node.State == NodeUncertain {
		nodeEvent, eventErr := k.makeEvent(eventNodeTransitioned, nodeTransitionPayload{NodeID: node.ID, From: NodeUncertain, To: NodeReconciling})
		if eventErr != nil {
			return Intent{}, eventErr
		}
		events = append(events, nodeEvent)
	}
	if err := k.appendLocked(events...); err != nil {
		return Intent{}, err
	}
	return k.projection.Intents[intent.ID], nil
}

// CommitReconciledIntent is control-plane reconciliation authority, not a stale
// worker commit. The reconciler must supply durable evidence of the external
// outcome as an external reference or result hash.
func (k *Kernel) CommitReconciledIntent(intentID, externalRef, resultHash string) (Intent, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Intent{}, err
	}
	intent, ok := k.projection.Intents[intentID]
	if !ok {
		return Intent{}, fmt.Errorf("%w: intent %q", ErrNotFound, intentID)
	}
	if intent.State != IntentReconciling {
		return Intent{}, fmt.Errorf("%w: reconciled commit requires RECONCILING", ErrInvalidIntentState)
	}
	if intent.ExternalRef != "" && externalRef != "" && intent.ExternalRef != externalRef {
		return Intent{}, fmt.Errorf("%w: reconciliation external reference conflicts with recorded result", ErrConflict)
	}
	if intent.ResultHash != "" && resultHash != "" && intent.ResultHash != resultHash {
		return Intent{}, fmt.Errorf("%w: reconciliation result hash conflicts with recorded result", ErrConflict)
	}
	if externalRef == "" {
		externalRef = intent.ExternalRef
	}
	if resultHash == "" {
		resultHash = intent.ResultHash
	}
	if externalRef == "" && resultHash == "" {
		return Intent{}, fmt.Errorf("%w: reconciled commit requires RECONCILING plus outcome evidence", ErrInvalidIntentState)
	}
	if node := k.projection.Nodes[intent.NodeID]; node.State != NodeReconciling {
		return Intent{}, fmt.Errorf("%w: reconciled commit requires RECONCILING node", ErrInvalidIntentState)
	}
	return k.changeIntentLocked(intent, IntentCommitted, externalRef, resultHash)
}

func (k *Kernel) RecordAttempt(attempt Attempt, token LeaseToken) (Attempt, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Attempt{}, err
	}
	node, ok := k.projection.Nodes[attempt.NodeID]
	if !ok {
		return Attempt{}, fmt.Errorf("%w: node %q", ErrNotFound, attempt.NodeID)
	}
	lease, err := k.validateLeaseLocked(node.ID, token)
	if err != nil {
		return Attempt{}, err
	}
	current, ok := k.projection.Attempts[lease.AttemptID]
	if !ok || current.NodeID != node.ID || current.LeaseID != lease.ID || current.Fence != lease.Fence {
		return Attempt{}, fmt.Errorf("%w: current lease has no attempt epoch", ErrConflict)
	}
	if attempt.Status != "" && !validAttemptStatus(attempt.Status) {
		return Attempt{}, fmt.Errorf("%w: invalid attempt status %q", ErrConflict, attempt.Status)
	}
	// Attempt epochs are minted atomically by ClaimLease. This compatibility
	// surface may validate/query that epoch but can never create a second caller-
	// supplied attempt number or ID under the same lease/fence.
	if attempt.ID != "" && attempt.ID != current.ID {
		return Attempt{}, fmt.Errorf("%w: attempt id is kernel-owned for current lease", ErrConflict)
	}
	if attempt.Number > 0 && attempt.Number != current.Number {
		return Attempt{}, fmt.Errorf("%w: attempt number is kernel-owned for current lease", ErrConflict)
	}
	if attempt.Status != "" && attempt.Status != current.Status {
		return Attempt{}, fmt.Errorf("%w: attempt status mutation requires a kernel state transition", ErrConflict)
	}
	return current, nil
}

func (k *Kernel) RecordVerification(credential string, request VerificationRequest) (Verification, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.checkOpenLocked(); err != nil {
		return Verification{}, err
	}
	principal, err := k.authenticateVerifierLocked(credential, request.ExpectedVerifierID)
	if err != nil {
		return Verification{}, err
	}
	node, ok := k.projection.Nodes[request.NodeID]
	if !ok {
		return Verification{}, fmt.Errorf("%w: node %q", ErrNotFound, request.NodeID)
	}
	if node.State != NodeVerifying {
		return Verification{}, fmt.Errorf("%w: verification requires VERIFYING node", ErrConflict)
	}
	if request.Decision != VerificationPassed && request.Decision != VerificationFailed {
		return Verification{}, fmt.Errorf("valid verification decision is required")
	}
	if request.EvidenceHash == "" {
		return Verification{}, fmt.Errorf("immutable evidence hash is required")
	}
	lease, exists := k.projection.Leases[node.ID]
	if !exists || lease.Released || !k.now().UTC().Before(lease.ExpiresAt) {
		return Verification{}, fmt.Errorf("%w: verification requires current live execution epoch", ErrStaleLease)
	}
	if lease.ExecutorID == principal.ID {
		return Verification{}, fmt.Errorf("%w: verifier must be independent from executor lease owner", ErrConflict)
	}
	attempt, ok := k.projection.Attempts[lease.AttemptID]
	if !ok || attempt.NodeID != node.ID || attempt.LeaseID != lease.ID || attempt.Fence != lease.Fence {
		return Verification{}, fmt.Errorf("%w: current execution epoch has no valid attempt", ErrConflict)
	}
	id, err := randomID()
	if err != nil {
		return Verification{}, err
	}
	verification := Verification{
		ID:           id,
		TaskID:       node.TaskID,
		NodeID:       node.ID,
		AttemptID:    attempt.ID,
		LeaseID:      lease.ID,
		Fence:        lease.Fence,
		VerifierID:   principal.ID,
		Decision:     request.Decision,
		EvidenceHash: request.EvidenceHash,
		CreatedAt:    k.now().UTC(),
	}
	event, err := k.makeEvent(eventVerificationRecorded, verification)
	if err != nil {
		return Verification{}, err
	}
	if err := k.appendLocked(event); err != nil {
		return Verification{}, err
	}
	return verification, nil
}

func (k *Kernel) hasPassedVerificationForCurrentAttemptLocked(nodeID string) bool {
	lease, ok := k.projection.Leases[nodeID]
	if !ok || lease.Released || lease.AttemptID == "" {
		return false
	}
	return k.hasPassedVerificationForAttemptLocked(nodeID, lease.AttemptID, lease.ID, lease.Fence)
}

func (k *Kernel) hasPassedVerificationForAttemptLocked(nodeID, attemptID, leaseID string, fence uint64) bool {
	for _, verification := range k.projection.Verifications {
		if verification.NodeID == nodeID &&
			verification.AttemptID == attemptID &&
			verification.LeaseID == leaseID &&
			verification.Fence == fence &&
			verification.Decision == VerificationPassed &&
			verification.EvidenceHash != "" {
			return true
		}
	}
	return false
}

func (k *Kernel) hasIntentBlockingVerificationLocked(nodeID string) bool {
	for _, intent := range k.projection.Intents {
		if intent.NodeID != nodeID {
			continue
		}
		switch intent.State {
		case IntentPrepared, IntentStarted, IntentUncertain, IntentReconciling:
			return true
		}
	}
	return false
}

func (k *Kernel) hasIntentBlockingRetryLocked(nodeID string) bool {
	for _, intent := range k.projection.Intents {
		if intent.NodeID != nodeID {
			continue
		}
		switch intent.State {
		case IntentStarted, IntentResult, IntentUncertain, IntentReconciling:
			return true
		}
	}
	return false
}

func (k *Kernel) hasUnresolvedExternalIntentLocked(nodeID string) bool {
	return k.hasIntentBlockingRetryLocked(nodeID)
}

func (k *Kernel) allIntentsCommittedLocked(nodeID string) bool {
	for _, intent := range k.projection.Intents {
		if intent.NodeID == nodeID && intent.State != IntentCommitted {
			return false
		}
	}
	return true
}

func (k *Kernel) hasLiveLeaseLocked(nodeID string) bool {
	lease, ok := k.projection.Leases[nodeID]
	if !ok || lease.Released {
		return false
	}
	return k.now().UTC().Before(lease.ExpiresAt)
}

// hasPassedVerificationLocked reports whether the node's most recent attempt
// (the last lease recorded for it, live, expired or released) has a PASSED
// verification. A pass from an older attempt never authorizes reconciliation.
func (k *Kernel) hasPassedVerificationLocked(nodeID string) bool {
	lease, ok := k.projection.Leases[nodeID]
	if !ok || lease.AttemptID == "" {
		return false
	}
	return k.hasPassedVerificationForAttemptLocked(nodeID, lease.AttemptID, lease.ID, lease.Fence)
}

func (k *Kernel) nodeIntentStatsLocked(nodeID string) (int, bool) {
	count := 0
	allCommitted := true
	for _, intent := range k.projection.Intents {
		if intent.NodeID == nodeID {
			count++
			if intent.State != IntentCommitted {
				allCommitted = false
			}
		}
	}
	return count, allCommitted
}

func (k *Kernel) Task(id string) (Task, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	task, ok := k.projection.Tasks[id]
	return cloneTask(task), ok
}

func (k *Kernel) Node(id string) (Node, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	node, ok := k.projection.Nodes[id]
	return node, ok
}

func (k *Kernel) Lease(nodeID string) (Lease, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	lease, ok := k.projection.Leases[nodeID]
	return lease, ok
}

func (k *Kernel) IntentByKey(key string) (Intent, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	id, ok := k.projection.IntentKeys[key]
	if !ok {
		return Intent{}, false
	}
	intent, ok := k.projection.Intents[id]
	return intent, ok
}

func (k *Kernel) ReadyNodes(taskID string) []Node {
	k.mu.Lock()
	defer k.mu.Unlock()
	return append([]Node(nil), k.projection.ReadyNodes(taskID)...)
}

func (k *Kernel) Verifications(nodeID string) []Verification {
	k.mu.Lock()
	defer k.mu.Unlock()
	items := make([]Verification, 0)
	for _, verification := range k.projection.Verifications {
		if verification.NodeID == nodeID {
			items = append(items, verification)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.Before(items[j].CreatedAt) })
	return items
}

func (k *Kernel) Close() error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.closed {
		return nil
	}
	k.closed = true
	return k.store.Close()
}
