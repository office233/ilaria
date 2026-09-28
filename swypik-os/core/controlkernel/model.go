// Package controlkernel implements the durable userspace control plane for
// SwypikOS. It is intentionally independent from the desktop runtime so the
// new durability and fencing semantics can be integrated behind compatibility
// facades instead of rewiring the product in one step.
package controlkernel

import (
	"encoding/json"
	"time"
)

// Budget is the resource envelope assigned to a task or node. Enforcement is
// performed by the eventual executor/sandbox; the control kernel persists the
// contract and makes it available to admission/scheduling code.
type Budget struct {
	WallTime        time.Duration `json:"wall_time,omitempty"`
	CPUTime         time.Duration `json:"cpu_time,omitempty"`
	MaxMemoryBytes  int64         `json:"max_memory_bytes,omitempty"`
	MaxReadBytes    int64         `json:"max_read_bytes,omitempty"`
	MaxWriteBytes   int64         `json:"max_write_bytes,omitempty"`
	MaxNetworkBytes int64         `json:"max_network_bytes,omitempty"`
	MaxAttempts     int           `json:"max_attempts,omitempty"`
}

// Task is a durable user goal. Nodes and edges are persisted separately so a
// scheduler can project only the portions of a large DAG that it needs.
type Task struct {
	ID             string            `json:"id"`
	Goal           string            `json:"goal"`
	CreatedAt      time.Time         `json:"created_at"`
	Budget         Budget            `json:"budget"`
	Metadata       map[string]string `json:"metadata,omitempty"`
	TopologyFrozen bool              `json:"topology_frozen,omitempty"`
}

// Node is one independently schedulable unit of work.
type Node struct {
	ID       string    `json:"id"`
	TaskID   string    `json:"task_id"`
	Kind     string    `json:"kind"`
	State    NodeState `json:"state"`
	Priority int       `json:"priority,omitempty"`
	Deadline time.Time `json:"deadline,omitempty"`
	Budget   Budget    `json:"budget"`
}

// Edge is a directed dependency: From must succeed before To is runnable.
type Edge struct {
	ID     string `json:"id"`
	TaskID string `json:"task_id"`
	From   string `json:"from"`
	To     string `json:"to"`
}

type AttemptStatus string

const (
	AttemptPreparing  AttemptStatus = "PREPARING"
	AttemptExecuting  AttemptStatus = "EXECUTING"
	AttemptVerifying  AttemptStatus = "VERIFYING"
	AttemptCommitting AttemptStatus = "COMMITTING"
	AttemptSucceeded  AttemptStatus = "SUCCEEDED"
	AttemptFailed     AttemptStatus = "FAILED"
	AttemptUncertain  AttemptStatus = "UNCERTAIN"
)

// Attempt records one worker execution attempt and the lease fence that
// authorized it. Results from older fences are never accepted for commit.
type Attempt struct {
	ID         string        `json:"id"`
	TaskID     string        `json:"task_id"`
	NodeID     string        `json:"node_id"`
	Number     int           `json:"number"`
	Status     AttemptStatus `json:"status"`
	LeaseID    string        `json:"lease_id"`
	Fence      uint64        `json:"fence"`
	StartedAt  time.Time     `json:"started_at"`
	FinishedAt time.Time     `json:"finished_at,omitempty"`
	Error      string        `json:"error,omitempty"`
}

// Lease grants temporary ownership of one node. Fence is monotonically
// increasing per node and is the authority checked on every worker mutation.
type Lease struct {
	ID         string    `json:"id"`
	TaskID     string    `json:"task_id"`
	NodeID     string    `json:"node_id"`
	AttemptID  string    `json:"attempt_id"`
	Owner      string    `json:"owner"`
	ExecutorID string    `json:"executor_id"`
	Fence      uint64    `json:"fence"`
	GrantedAt  time.Time `json:"granted_at"`
	ExpiresAt  time.Time `json:"expires_at"`
	Released   bool      `json:"released,omitempty"`
}

// LeaseToken is the small authority proof passed by a worker with mutations.
type LeaseToken struct {
	LeaseID string `json:"lease_id"`
	Fence   uint64 `json:"fence"`
}

type IntentState string

const (
	IntentPrepared    IntentState = "PREPARED"
	IntentStarted     IntentState = "STARTED"
	IntentResult      IntentState = "RESULT"
	IntentUncertain   IntentState = "UNCERTAIN"
	IntentReconciling IntentState = "RECONCILING"
	IntentCommitted   IntentState = "COMMITTED"
	IntentAbandoned   IntentState = "ABANDONED"
)

// Intent is the durable side-effect ledger entry. IdempotencyKey is globally
// unique inside a control-kernel journal. RequestHash binds a key to one exact
// logical operation, preventing accidental key reuse for a different effect.
type Intent struct {
	ID             string      `json:"id"`
	TaskID         string      `json:"task_id"`
	NodeID         string      `json:"node_id"`
	AttemptID      string      `json:"attempt_id,omitempty"`
	Kind           string      `json:"kind"`
	IdempotencyKey string      `json:"idempotency_key"`
	RequestHash    string      `json:"request_hash"`
	State          IntentState `json:"state"`
	LeaseID        string      `json:"lease_id"`
	Fence          uint64      `json:"fence"`
	ExternalRef    string      `json:"external_ref,omitempty"`
	ResultHash     string      `json:"result_hash,omitempty"`
	CreatedAt      time.Time   `json:"created_at"`
	UpdatedAt      time.Time   `json:"updated_at"`
}

type VerificationDecision string

const (
	VerificationPassed VerificationDecision = "PASSED"
	VerificationFailed VerificationDecision = "FAILED"
)

// Verification is an independent evidence verdict. VerifierID identifies the
// verifier principal; it intentionally carries no executor authority.
type Verification struct {
	ID           string               `json:"id"`
	TaskID       string               `json:"task_id"`
	NodeID       string               `json:"node_id"`
	AttemptID    string               `json:"attempt_id"`
	LeaseID      string               `json:"lease_id"`
	Fence        uint64               `json:"fence"`
	VerifierID   string               `json:"verifier_id"`
	Decision     VerificationDecision `json:"decision"`
	EvidenceHash string               `json:"evidence_hash"`
	CreatedAt    time.Time            `json:"created_at"`
}

// VerificationRequest contains only the verifier's verdict and immutable
// evidence reference. Identity and execution-epoch binding are derived by the
// kernel from authenticated verifier authority and the current lease/attempt.
type VerificationRequest struct {
	NodeID       string               `json:"node_id"`
	Decision     VerificationDecision `json:"decision"`
	EvidenceHash string               `json:"evidence_hash"`
}

// Event is the immutable event-source record. Seq is per stream while
// JournalSeq and PrevHash/Hash provide one total-order tamper-evident chain.
type Event struct {
	ID         string          `json:"id"`
	Stream     string          `json:"stream"`
	Seq        uint64          `json:"seq"`
	JournalSeq uint64          `json:"journal_seq"`
	Type       string          `json:"type"`
	At         time.Time       `json:"at"`
	Data       json.RawMessage `json:"data"`
	PrevHash   string          `json:"prev_hash,omitempty"`
	Hash       string          `json:"hash"`
}
