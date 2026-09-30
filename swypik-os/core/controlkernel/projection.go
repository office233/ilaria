package controlkernel

import (
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

const controlStream = "control"

const (
	eventTaskCreated           = "task.created"
	eventTaskTopologyFrozen    = "task.topology_frozen"
	eventNodeAdded             = "node.added"
	eventEdgeAdded             = "edge.added"
	eventNodeTransitioned      = "node.transitioned"
	eventAttemptRecorded       = "attempt.recorded"
	eventLeaseGranted          = "lease.granted"
	eventLeaseRenewed          = "lease.renewed"
	eventLeaseReleased         = "lease.released"
	eventIntentPrepared        = "intent.prepared"
	eventIntentRebound         = "intent.rebound"
	eventIntentStateChanged    = "intent.state_changed"
	eventVerificationRecorded  = "verification.recorded"
	eventResourceStateRecorded = "resource.state_recorded"
)

type taskTopologyFrozenPayload struct {
	TaskID string `json:"task_id"`
}

type nodeTransitionPayload struct {
	NodeID string    `json:"node_id"`
	From   NodeState `json:"from"`
	To     NodeState `json:"to"`
}

type leaseRenewedPayload struct {
	NodeID    string `json:"node_id"`
	LeaseID   string `json:"lease_id"`
	Fence     uint64 `json:"fence"`
	ExpiresAt string `json:"expires_at"`
}

type leaseReleasedPayload struct {
	NodeID  string `json:"node_id"`
	LeaseID string `json:"lease_id"`
	Fence   uint64 `json:"fence"`
}

type intentStatePayload struct {
	IntentID    string      `json:"intent_id"`
	From        IntentState `json:"from"`
	To          IntentState `json:"to"`
	ExternalRef string      `json:"external_ref,omitempty"`
	ResultHash  string      `json:"result_hash,omitempty"`
	UpdatedAt   string      `json:"updated_at"`
}

type intentReboundPayload struct {
	IntentID  string      `json:"intent_id"`
	From      IntentState `json:"from"`
	AttemptID string      `json:"attempt_id"`
	LeaseID   string      `json:"lease_id"`
	Fence     uint64      `json:"fence"`
	UpdatedAt string      `json:"updated_at"`
}

// Projection is the rebuildable query model. It is never persisted separately
// in M1; the event journal remains the only source of truth.
type Projection struct {
	Sequence         uint64
	Tasks            map[string]Task
	Nodes            map[string]Node
	Edges            map[string]Edge
	Attempts         map[string]Attempt
	Leases           map[string]Lease
	MaxFence         map[string]uint64
	Intents          map[string]Intent
	IntentKeys       map[string]string
	Verifications    map[string]Verification
	ResourceState    ResourceState
	HasResourceState bool
}

func NewProjection() *Projection {
	return &Projection{
		Tasks:         make(map[string]Task),
		Nodes:         make(map[string]Node),
		Edges:         make(map[string]Edge),
		Attempts:      make(map[string]Attempt),
		Leases:        make(map[string]Lease),
		MaxFence:      make(map[string]uint64),
		Intents:       make(map[string]Intent),
		IntentKeys:    make(map[string]string),
		Verifications: make(map[string]Verification),
	}
}

func BuildProjection(events []Event) (*Projection, error) {
	p := NewProjection()
	for _, event := range events {
		if event.Stream != controlStream {
			continue
		}
		if err := p.Apply(event); err != nil {
			return nil, fmt.Errorf("projection event %d (%s): %w", event.Seq, event.Type, err)
		}
	}
	return p, nil
}

func decodePayload(raw json.RawMessage, dst any) error {
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("decode event payload: %w", err)
	}
	return nil
}

func (p *Projection) Apply(event Event) error {
	if event.Stream != controlStream {
		return fmt.Errorf("unexpected stream %q", event.Stream)
	}
	if event.Seq != p.Sequence+1 {
		return fmt.Errorf("projection sequence expected %d, got %d", p.Sequence+1, event.Seq)
	}
	switch event.Type {
	case eventTaskCreated:
		var task Task
		if err := decodePayload(event.Data, &task); err != nil {
			return err
		}
		if task.ID == "" {
			return fmt.Errorf("task id is empty")
		}
		if _, exists := p.Tasks[task.ID]; exists {
			return fmt.Errorf("duplicate task %q", task.ID)
		}
		if task.TopologyFrozen {
			return fmt.Errorf("new task cannot start with frozen topology")
		}
		p.Tasks[task.ID] = cloneTask(task)

	case eventTaskTopologyFrozen:
		var freeze taskTopologyFrozenPayload
		if err := decodePayload(event.Data, &freeze); err != nil {
			return err
		}
		task, ok := p.Tasks[freeze.TaskID]
		if !ok || task.TopologyFrozen {
			return fmt.Errorf("invalid topology freeze for task %q", freeze.TaskID)
		}
		task.TopologyFrozen = true
		p.Tasks[task.ID] = task

	case eventNodeAdded:
		var node Node
		if err := decodePayload(event.Data, &node); err != nil {
			return err
		}
		if node.ID == "" || node.TaskID == "" || node.State != NodePending {
			return fmt.Errorf("invalid initial node")
		}
		task, ok := p.Tasks[node.TaskID]
		if !ok {
			return fmt.Errorf("node task %q does not exist", node.TaskID)
		}
		if task.TopologyFrozen {
			return fmt.Errorf("cannot add node to frozen task %q", node.TaskID)
		}
		if _, exists := p.Nodes[node.ID]; exists {
			return fmt.Errorf("duplicate node %q", node.ID)
		}
		p.Nodes[node.ID] = node

	case eventEdgeAdded:
		var edge Edge
		if err := decodePayload(event.Data, &edge); err != nil {
			return err
		}
		task, taskOK := p.Tasks[edge.TaskID]
		from, fromOK := p.Nodes[edge.From]
		to, toOK := p.Nodes[edge.To]
		if edge.ID == "" || !taskOK || task.TopologyFrozen || !fromOK || !toOK || edge.From == edge.To || from.TaskID != edge.TaskID || to.TaskID != edge.TaskID {
			return fmt.Errorf("invalid edge")
		}
		if _, exists := p.Edges[edge.ID]; exists {
			return fmt.Errorf("duplicate edge %q", edge.ID)
		}
		p.Edges[edge.ID] = edge

	case eventNodeTransitioned:
		var change nodeTransitionPayload
		if err := decodePayload(event.Data, &change); err != nil {
			return err
		}
		node, ok := p.Nodes[change.NodeID]
		if !ok || node.State != change.From {
			return fmt.Errorf("node %q projection state mismatch", change.NodeID)
		}
		if err := validateTransition(change.From, change.To); err != nil {
			return err
		}
		if change.To == NodeReady && !p.Tasks[node.TaskID].TopologyFrozen {
			return fmt.Errorf("node %q became READY before task topology freeze", node.ID)
		}
		node.State = change.To
		p.Nodes[node.ID] = node

	case eventAttemptRecorded:
		var attempt Attempt
		if err := decodePayload(event.Data, &attempt); err != nil {
			return err
		}
		node, nodeOK := p.Nodes[attempt.NodeID]
		if attempt.ID == "" || !nodeOK || attempt.TaskID != node.TaskID || attempt.Number <= 0 || !validAttemptStatus(attempt.Status) || attempt.LeaseID == "" || attempt.Fence == 0 {
			return fmt.Errorf("invalid attempt")
		}
		if _, exists := p.Attempts[attempt.ID]; exists {
			return fmt.Errorf("duplicate attempt %q", attempt.ID)
		}
		for _, existing := range p.Attempts {
			if existing.NodeID != attempt.NodeID {
				continue
			}
			if existing.Number == attempt.Number {
				return fmt.Errorf("duplicate attempt number %d for node %q", attempt.Number, attempt.NodeID)
			}
			if existing.Fence == attempt.Fence || existing.LeaseID == attempt.LeaseID {
				return fmt.Errorf("duplicate attempt execution epoch for node %q", attempt.NodeID)
			}
		}
		p.Attempts[attempt.ID] = attempt

	case eventLeaseGranted:
		var lease Lease
		if err := decodePayload(event.Data, &lease); err != nil {
			return err
		}
		node, nodeOK := p.Nodes[lease.NodeID]
		attempt, attemptOK := p.Attempts[lease.AttemptID]
		if lease.ID == "" || !nodeOK || lease.TaskID != node.TaskID || lease.AttemptID == "" || lease.ExecutorID == "" || !attemptOK || attempt.NodeID != lease.NodeID || attempt.LeaseID != lease.ID || attempt.Fence != lease.Fence || lease.Fence == 0 || lease.Fence <= p.MaxFence[lease.NodeID] {
			return fmt.Errorf("non-monotonic or invalid lease")
		}
		p.Leases[lease.NodeID] = lease
		p.MaxFence[lease.NodeID] = lease.Fence

	case eventLeaseRenewed:
		var wire leaseRenewedPayload
		if err := decodePayload(event.Data, &wire); err != nil {
			return err
		}
		lease, ok := p.Leases[wire.NodeID]
		if !ok || lease.ID != wire.LeaseID || lease.Fence != wire.Fence || lease.Released {
			return fmt.Errorf("lease renewal does not match current lease")
		}
		expires, err := parseWireTime(wire.ExpiresAt)
		if err != nil {
			return err
		}
		lease.ExpiresAt = expires
		p.Leases[wire.NodeID] = lease

	case eventLeaseReleased:
		var release leaseReleasedPayload
		if err := decodePayload(event.Data, &release); err != nil {
			return err
		}
		lease, ok := p.Leases[release.NodeID]
		if !ok || lease.ID != release.LeaseID || lease.Fence != release.Fence {
			return fmt.Errorf("lease release does not match current lease")
		}
		lease.Released = true
		p.Leases[release.NodeID] = lease

	case eventIntentPrepared:
		var intent Intent
		if err := decodePayload(event.Data, &intent); err != nil {
			return err
		}
		node, nodeOK := p.Nodes[intent.NodeID]
		attempt, attemptOK := p.Attempts[intent.AttemptID]
		if intent.ID == "" || !nodeOK || intent.TaskID != node.TaskID || intent.AttemptID == "" || !attemptOK || attempt.NodeID != intent.NodeID || attempt.LeaseID != intent.LeaseID || attempt.Fence != intent.Fence || intent.IdempotencyKey == "" || intent.State != IntentPrepared || intent.LeaseID == "" || intent.Fence == 0 {
			return fmt.Errorf("invalid prepared intent")
		}
		if _, exists := p.Intents[intent.ID]; exists {
			return fmt.Errorf("duplicate intent %q", intent.ID)
		}
		if _, exists := p.IntentKeys[intent.IdempotencyKey]; exists {
			return fmt.Errorf("duplicate idempotency key %q", intent.IdempotencyKey)
		}
		p.Intents[intent.ID] = intent
		p.IntentKeys[intent.IdempotencyKey] = intent.ID

	case eventIntentRebound:
		var rebound intentReboundPayload
		if err := decodePayload(event.Data, &rebound); err != nil {
			return err
		}
		intent, ok := p.Intents[rebound.IntentID]
		attempt, attemptOK := p.Attempts[rebound.AttemptID]
		if !ok || intent.State != rebound.From || (rebound.From != IntentPrepared && rebound.From != IntentAbandoned) || !attemptOK || attempt.NodeID != intent.NodeID || attempt.LeaseID != rebound.LeaseID || attempt.Fence != rebound.Fence {
			return fmt.Errorf("invalid prepared intent rebind")
		}
		updatedAt, err := parseWireTime(rebound.UpdatedAt)
		if err != nil {
			return err
		}
		intent.AttemptID = rebound.AttemptID
		intent.LeaseID = rebound.LeaseID
		intent.Fence = rebound.Fence
		intent.State = IntentPrepared
		intent.UpdatedAt = updatedAt
		p.Intents[intent.ID] = intent

	case eventIntentStateChanged:
		var change intentStatePayload
		if err := decodePayload(event.Data, &change); err != nil {
			return err
		}
		intent, ok := p.Intents[change.IntentID]
		if !ok || intent.State != change.From || !canTransitionIntent(change.From, change.To) {
			return fmt.Errorf("invalid intent transition %s -> %s", change.From, change.To)
		}
		updatedAt, err := parseWireTime(change.UpdatedAt)
		if err != nil {
			return err
		}
		intent.State = change.To
		intent.UpdatedAt = updatedAt
		if change.ExternalRef != "" {
			intent.ExternalRef = change.ExternalRef
		}
		if change.ResultHash != "" {
			intent.ResultHash = change.ResultHash
		}
		p.Intents[intent.ID] = intent

	case eventVerificationRecorded:
		var verification Verification
		if err := decodePayload(event.Data, &verification); err != nil {
			return err
		}
		node, nodeOK := p.Nodes[verification.NodeID]
		attempt, attemptOK := p.Attempts[verification.AttemptID]
		lease, leaseOK := p.Leases[verification.NodeID]
		if verification.ID == "" || !nodeOK || verification.TaskID != node.TaskID || verification.AttemptID == "" || !attemptOK || attempt.NodeID != verification.NodeID || verification.LeaseID == "" || verification.Fence == 0 || attempt.LeaseID != verification.LeaseID || attempt.Fence != verification.Fence || !leaseOK || lease.ID != verification.LeaseID || lease.Fence != verification.Fence || lease.AttemptID != verification.AttemptID || verification.VerifierID == "" || verification.EvidenceHash == "" {
			return fmt.Errorf("invalid verification")
		}
		if verification.Decision != VerificationPassed && verification.Decision != VerificationFailed {
			return fmt.Errorf("invalid verification decision")
		}
		if _, exists := p.Verifications[verification.ID]; exists {
			return fmt.Errorf("duplicate verification %q", verification.ID)
		}
		p.Verifications[verification.ID] = verification

	case eventResourceStateRecorded:
		var state ResourceState
		if err := decodePayload(event.Data, &state); err != nil {
			return err
		}
		if err := validateResourceState(state); err != nil {
			return err
		}
		expectedRevision := uint64(1)
		if p.HasResourceState {
			expectedRevision = p.ResourceState.Revision + 1
		}
		if state.Revision != expectedRevision {
			return fmt.Errorf("resource state revision expected %d, got %d", expectedRevision, state.Revision)
		}
		p.ResourceState = cloneResourceState(state)
		p.HasResourceState = true

	default:
		return fmt.Errorf("unknown event type %q", event.Type)
	}
	p.Sequence = event.Seq
	return nil
}

func cloneTask(task Task) Task {
	copy := task
	if task.Metadata != nil {
		copy.Metadata = make(map[string]string, len(task.Metadata))
		for key, value := range task.Metadata {
			copy.Metadata[key] = value
		}
	}
	return copy
}

func parseWireTime(raw string) (time.Time, error) {
	if raw == "" {
		return time.Time{}, fmt.Errorf("event timestamp is empty")
	}
	parsed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse event timestamp: %w", err)
	}
	return parsed.UTC(), nil
}

// ReadyNodes returns READY nodes whose predecessor nodes are all SUCCEEDED.
// Results are deterministic: higher priority first, then node ID.
func (p *Projection) ReadyNodes(taskID string) []Node {
	blockedBy := make(map[string][]string)
	for _, edge := range p.Edges {
		if edge.TaskID == taskID {
			blockedBy[edge.To] = append(blockedBy[edge.To], edge.From)
		}
	}
	ready := make([]Node, 0)
	for _, node := range p.Nodes {
		if node.TaskID != taskID || node.State != NodeReady {
			continue
		}
		dependenciesDone := true
		for _, predecessor := range blockedBy[node.ID] {
			if p.Nodes[predecessor].State != NodeSucceeded {
				dependenciesDone = false
				break
			}
		}
		if dependenciesDone {
			ready = append(ready, node)
		}
	}
	sort.Slice(ready, func(i, j int) bool {
		if ready[i].Priority != ready[j].Priority {
			return ready[i].Priority > ready[j].Priority
		}
		return ready[i].ID < ready[j].ID
	})
	return ready
}
