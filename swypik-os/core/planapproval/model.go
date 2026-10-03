// Package planapproval coordinates authority-free proposals, independent host
// verification, and explicit host approval before durable supervised execution.
package planapproval

import (
	"context"
	"errors"
	"time"

	"swypik-os/core/controlkernel"
	"swypik-os/core/effects"
	"swypik-os/core/supervisor"
	wire "swypik-os/generated/swypeffects"
)

var (
	ErrInvalid              = errors.New("planapproval: invalid input")
	ErrLimit                = errors.New("planapproval: bound exhausted")
	ErrBusy                 = errors.New("planapproval: concurrent operation limit")
	ErrNotFound             = errors.New("planapproval: unknown proposal")
	ErrRevision             = errors.New("planapproval: exact revision required")
	ErrState                = errors.New("planapproval: invalid state transition")
	ErrUnauthorized         = errors.New("planapproval: trusted host approval required")
	ErrVerification         = errors.New("planapproval: verification rejected or unavailable")
	ErrReplay               = errors.New("planapproval: execution already reserved; replay forbidden")
	ErrUncertain            = errors.New("planapproval: execution outcome uncertain; replay forbidden")
	ErrArtifactsUnavailable = errors.New("planapproval: reopened revision is status-only; correct before verification")
	ErrExecutionUnavailable = errors.New("planapproval: host execution adapter unavailable")
	ErrPolicyChanged        = errors.New("planapproval: durable coordinator policy changed")
)

type State string

const (
	Proposed  State = "PROPOSED"
	Verifying State = "VERIFYING"
	Verified  State = "VERIFIED"
	Approved  State = "APPROVED"
	Running   State = "RUNNING"
	Rejected  State = "REJECTED"
	Failed    State = "FAILED"
	Cancelled State = "CANCELLED"
	Uncertain State = "UNCERTAIN"
	Succeeded State = "SUCCEEDED"
)

// Limits must stay within the documented product ceilings. A zero Limits value
// uses DefaultLimits; partially specified limits are rejected.
type Limits struct {
	MaxProposalBytes int           `json:"max_proposal_bytes"`
	MaxProposals     int           `json:"max_proposals"`
	MaxRevisions     int           `json:"max_revisions"`
	MaxHistory       int           `json:"max_history"`
	MaxConcurrent    int           `json:"max_concurrent"`
	VerifyTimeout    time.Duration `json:"verify_timeout"`
	ExecuteTimeout   time.Duration `json:"execute_timeout"`
}

func DefaultLimits() Limits {
	return Limits{MaxProposalBytes: effects.MaxMessageBytes, MaxProposals: 64,
		MaxRevisions: 16, MaxHistory: 128, MaxConcurrent: 1,
		VerifyTimeout: 30 * time.Second, ExecuteTimeout: 30 * time.Second}
}

// Proposal is not a second plan schema. Plan is the canonical Swyp wire plan;
// source and module are opaque bytes, not paths, credentials, scopes or grants.
// Each source/module is limited to 1 MiB, and their combined canonical proposal
// size is limited by Limits.MaxProposalBytes.
type Proposal struct {
	Source []byte
	Module []byte
	Plan   wire.EffectPlan
}

type Revision struct {
	ProposalID string `json:"proposal_id"`
	Number     uint64 `json:"number"`
	PlanHash   string `json:"plan_hash"`
	SourceHash string `json:"source_hash"`
	ModuleHash string `json:"module_hash"`
}

// Verdict is returned only by the configured trusted verifier. The canonical
// kernel decision is wrapped with an exact pre-execution revision, not forged
// into a kernel Verification (which requires a real execution lease/epoch).
type Verdict struct {
	Revision     Revision                           `json:"revision"`
	Decision     controlkernel.VerificationDecision `json:"decision"`
	EvidenceHash string                             `json:"evidence_hash"`
	Code         string                             `json:"code"`
}

type PlanVerifier interface {
	VerifyPlan(context.Context, Revision, Proposal) (Verdict, error)
}

type Review struct {
	Verdict    Verdict `json:"verdict"`
	VerifierID string  `json:"verifier_id"`
}

type ApproverPrincipal struct{ ID string }

// ApproverAuthenticator authenticates the host control channel, never proposal
// text. Credentials are not retained, hashed into revisions, or journaled.
type ApproverAuthenticator interface {
	AuthenticateApprover(context.Context, string) (ApproverPrincipal, error)
}

type Approval struct {
	Revision Revision `json:"revision"`
	ActorID  string   `json:"actor_id"`
}

type Execution struct {
	Revision Revision
	Proposal Proposal
	Review   Review
	Approval Approval
}

// ExecutionResult preserves the supervisor's canonical terminal evidence.
// Started=false is a host assertion that no guest was launched. Once Started
// is true, absent/mismatched/nonterminal evidence is always uncertain.
type ExecutionResult struct {
	Status  supervisor.Snapshot `json:"status"`
	Started bool                `json:"started"`
}

// Executor is a trusted host adapter. It must enforce ctx cancellation on its
// owned guest and return only after guest stop and durable supervisor cleanup.
// An adapter that ignores cancellation is quarantined against the concurrency
// limit until it returns; timeout never authorizes another execution.
type Executor interface {
	Execute(context.Context, Execution) (ExecutionResult, error)
}

type Config struct {
	JournalPath   string
	ApproverID    string
	VerifierID    string
	Authenticator ApproverAuthenticator
	Verifier      PlanVerifier
	Executor      Executor
	Limits        Limits
}

// Record is bounded, content-free durable review/approval/outcome metadata.
type Record struct {
	Revision        Revision         `json:"revision"`
	State           State            `json:"state"`
	Review          *Review          `json:"review,omitempty"`
	Approval        *Approval        `json:"approval,omitempty"`
	Attempted       bool             `json:"attempted"`
	CancelRequested bool             `json:"cancel_requested"`
	Execution       *ExecutionResult `json:"execution,omitempty"`
	Code            string           `json:"code"`
}

type Snapshot struct {
	Record
	Plan               *wire.EffectPlan
	ArtifactsAvailable bool
	History            []Record
}
