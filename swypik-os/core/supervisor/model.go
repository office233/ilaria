// Package supervisor owns the durable admission and verification lifecycle of
// one explicitly configured Swyp plan. It delegates effect authority, fencing
// and commit to the existing Control Kernel and effect broker.
package supervisor

import (
	"context"
	"crypto/ed25519"
	"errors"
	"time"

	"swypik-os/core/controlkernel"
	"swypik-os/core/effects"
	wire "swypik-os/generated/swypeffects"
)

const (
	MaxPlanEffects               = 64
	MaxContinuationStateBytes    = 6 << 20
	MaxContinuationEnvelopeBytes = 9 << 20
	MaxContinuationFuel          = 1_000_000
	MaxContinuationEffectBytes   = 1 << 20
)

var (
	ErrDenied                  = errors.New("supervisor request denied")
	ErrRecoveryRequired        = errors.New("supervisor plan requires recovery; guest replay forbidden")
	ErrPolicyChanged           = errors.New("supervisor durable plan policy does not match configuration")
	ErrVerification            = errors.New("supervisor independent evidence verification failed")
	ErrContinuationUnavailable = errors.New("supervisor authenticated continuation unavailable")
	ErrContinuationRejected    = errors.New("supervisor authenticated continuation rejected")
)

const ContinuationModeAES256GCM = "aes-256-gcm"

// ContinuationPolicy is trusted host authority. Key material is supplied by the
// host at runtime only; it is never serialized into the supervisor ledger.
// Persistence is disabled by the zero value.
type ContinuationPolicy struct {
	Enabled          bool
	Mode             string
	Directory        string
	KeyID            string
	Key              [32]byte
	MaxEnvelopeBytes int
}

// ContinuationEnvelope mirrors the public, authority-free Swyp continuation
// wrapper. State remains opaque to SwypikOS; Swyp validates its internal PC,
// frames, locals and budgets again before a resumed guest can execute.
type ContinuationEnvelope struct {
	ProtocolVersion   uint64 `json:"protocol_version"`
	Type              string `json:"type"`
	StateVersion      uint64 `json:"state_version"`
	RunID             string `json:"run_id"`
	ModuleHash        string `json:"module_hash"`
	Entry             string `json:"entry"`
	FuelLimit         uint64 `json:"fuel_limit"`
	StepsUsed         uint64 `json:"steps_used"`
	MaxEffectBytes    uint64 `json:"max_effect_bytes"`
	EffectBytes       uint64 `json:"effect_bytes"`
	EffectCursor      uint64 `json:"effect_cursor"`
	EffectRequestHash string `json:"effect_request_hash"`
	EffectResultHash  string `json:"effect_result_hash"`
	StateHash         string `json:"state_hash"`
	State             []byte `json:"state"`
}

type ContinuationBinding struct {
	Version             uint64 `json:"version"`
	TaskID              string `json:"task_id"`
	RunID               string `json:"run_id"`
	ModuleHash          string `json:"module_hash"`
	Entry               string `json:"entry"`
	PlanHash            string `json:"plan_hash"`
	ExecutionPolicyHash string `json:"execution_policy_hash"`
	MaxEffects          uint64 `json:"max_effects"`
	MaxReadBytes        int64  `json:"max_read_bytes"`
	FuelLimit           uint64 `json:"fuel_limit"`
	MaxEffectBytes      uint64 `json:"max_effect_bytes"`
	DeadlineUnixMS      int64  `json:"deadline_unix_ms"`
	EffectCursor        uint64 `json:"effect_cursor"`
	NodeID              string `json:"node_id"`
	AttemptID           string `json:"attempt_id"`
	LeaseID             string `json:"lease_id"`
	Fence               uint64 `json:"fence"`
	RequestHash         string `json:"request_hash"`
	ResultHash          string `json:"result_hash"`
	ReceiptHash         string `json:"receipt_hash"`
	IntentID            string `json:"intent_id"`
	CheckpointHash      string `json:"checkpoint_hash"`
	EnvelopeHash        string `json:"envelope_hash"`
	StateHash           string `json:"state_hash"`
}

// ResumeState is intentionally not JSON-serializable: Envelope contains the
// decrypted continuation and may contain sensitive guest locals/payload data.
type ResumeState struct {
	Binding    ContinuationBinding
	Checkpoint ContinuationEnvelope `json:"-"`
	Envelope   []byte               `json:"-"`
}

type Binding struct {
	Function   string `json:"function"`
	Effect     string `json:"effect"`
	Capability string `json:"capability"`
}

type Scope struct {
	Function     string `json:"function"`
	Effect       string `json:"effect"`
	Capability   string `json:"capability"`
	Path         string `json:"path"`
	RootID       string `json:"root_id"`
	MaxReadBytes int64  `json:"max_read_bytes"`
}

type Plan struct {
	TaskID         string    `json:"task_id"`
	RunID          string    `json:"run_id"`
	ModuleHash     string    `json:"module_hash"`
	Entry          string    `json:"entry"`
	Bindings       []Binding `json:"bindings"`
	Effects        []string  `json:"effects"`
	MaxEffects     uint64    `json:"max_effects"`
	MaxReadBytes   int64     `json:"max_read_bytes"`
	FuelLimit      uint64    `json:"fuel_limit,omitempty"`
	MaxEffectBytes uint64    `json:"max_effect_bytes,omitempty"`
	Deadline       time.Time `json:"deadline"`
}

// Verification must identify the exact signed evidence and expected OS epoch.
// The verifier can accept/reject evidence, but cannot supply grants or scopes.
type Verification struct {
	Verified    bool            `json:"verified"`
	RequestHash string          `json:"request_hash"`
	ResultHash  string          `json:"result_hash"`
	ReceiptHash string          `json:"receipt_hash"`
	Expected    effects.Binding `json:"expected"`
}

type EvidenceVerifier interface {
	Verify(context.Context, wire.EffectRequest, wire.EffectResult, wire.EffectReceipt, effects.Binding) (Verification, error)
}

type Config struct {
	Kernel              *controlkernel.Kernel
	LedgerPath          string
	ExecutionPolicyHash string
	Plan                Plan
	Scopes              []Scope
	RootPaths           map[string]string
	Reader              effects.FileReader
	SignerKeyID         string
	PrivateKey          ed25519.PrivateKey
	ExecutorID          string
	ExecutorCredential  string
	VerifierID          string
	VerifierCredential  string
	Verifier            EvidenceVerifier
	Continuation        ContinuationPolicy
	Now                 func() time.Time
}

type Evidence struct {
	Request      wire.EffectRequest      `json:"request"`
	Result       wire.EffectResult       `json:"result"`
	Receipt      wire.EffectReceipt      `json:"receipt"`
	Expected     effects.Binding         `json:"expected"`
	Verification Verification            `json:"verification"`
	NodeState    controlkernel.NodeState `json:"node_state"`
}

type Snapshot struct {
	PlanHash          string `json:"plan_hash"`
	TaskID            string `json:"task_id"`
	RunID             string `json:"run_id"`
	ModuleHash        string `json:"module_hash,omitempty"`
	DeadlineUnixMS    int64  `json:"deadline_unix_ms,omitempty"`
	State             string `json:"state"`
	Issued            uint64 `json:"issued"`
	Committed         uint64 `json:"committed"`
	ReservedReadBytes int64  `json:"reserved_read_bytes"`
	FinalValueHash    string `json:"final_value_hash"`
	FailureCode       string `json:"failure_code"`
}

type RecoveryReport struct {
	Status                Snapshot                  `json:"status"`
	Outcome               string                    `json:"outcome"`
	Sequence              uint64                    `json:"sequence,omitempty"`
	NodeState             controlkernel.NodeState   `json:"node_state,omitempty"`
	IntentState           controlkernel.IntentState `json:"intent_state,omitempty"`
	LeaseFence            uint64                    `json:"lease_fence,omitempty"`
	EvidenceVerified      bool                      `json:"evidence_verified"`
	ContinuationAvailable bool                      `json:"continuation_available"`
	ContinuationResumed   bool                      `json:"continuation_resumed"`
}

const (
	RecoveryTerminal                 = "terminal"
	RecoveryReady                    = "ready"
	RecoveryWaitingLease             = "waiting_for_lease_expiry"
	RecoveryReconciledNoContinuation = "reconciled_no_serialized_continuation"
	RecoveryNoContinuation           = "no_serialized_continuation"
	RecoveryEvidenceUnverified       = "independent_evidence_unavailable"
	RecoveryResumeAvailable          = "authenticated_continuation_available"
	RecoveryContinuationRejected     = "authenticated_continuation_rejected"
)

const (
	StateReady     = "READY"
	StateRunning   = "RUNNING"
	StateSucceeded = "SUCCEEDED"
	StateFailed    = "FAILED"
	StateUncertain = "UNCERTAIN"
)
