package effects

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"swypik-os/core/controlkernel"
	wire "swypik-os/generated/swypeffects"
)

// Binding is trusted OS execution context. Consumers must obtain it from the
// host control plane independently of guest requests and signed receipts.
type Binding struct {
	TaskID     string `json:"task_id"`
	NodeID     string `json:"node_id"`
	AttemptID  string `json:"attempt_id"`
	ExecutorID string `json:"executor_id"`
	GrantID    string `json:"grant_id"`
	LeaseID    string `json:"lease_id"`
	Fence      uint64 `json:"fence"`
}

// Grant is immutable host policy, bound to one exact canonical request and
// one Control Kernel execution epoch. Requests cannot supply or widen it.
type Grant struct {
	Binding
	RequestID   string
	RequestHash string
	Effect      string
	Capability  string
	RootID      string
	MaxBytes    int64
	ExpiresAt   time.Time
}

type FileReader interface {
	Read(context.Context, string, string, int64) ([]byte, error)
}

type Config struct {
	Kernel      *controlkernel.Kernel
	Reader      FileReader
	SignerKeyID string
	PrivateKey  ed25519.PrivateKey
	Grants      []Grant
	Now         func() time.Time
}

type Broker struct {
	mu          sync.Mutex
	kernel      *controlkernel.Kernel
	reader      FileReader
	signerKeyID string
	privateKey  ed25519.PrivateKey
	grants      map[string]Grant
	now         func() time.Time
}

func ValidateBinding(binding Binding) error {
	if binding.Fence == 0 {
		return fmt.Errorf("invalid effect grant fence")
	}
	for _, id := range []string{binding.TaskID, binding.NodeID, binding.AttemptID, binding.ExecutorID, binding.GrantID, binding.LeaseID} {
		if !idPattern.MatchString(id) {
			return fmt.Errorf("invalid effect grant execution binding")
		}
	}
	return nil
}

func ValidateSigningIdentity(keyID string, key ed25519.PrivateKey) error {
	if !idPattern.MatchString(keyID) || len(key) != ed25519.PrivateKeySize || !bytes.Equal(ed25519.NewKeyFromSeed(key.Seed()), key) {
		return fmt.Errorf("invalid explicit Ed25519 signing identity")
	}
	return nil
}

func NewBroker(config Config) (*Broker, error) {
	if config.Kernel == nil {
		return nil, fmt.Errorf("broker requires Control Kernel and explicit signing identity")
	}
	if err := ValidateSigningIdentity(config.SignerKeyID, config.PrivateKey); err != nil {
		return nil, err
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	b := &Broker{kernel: config.Kernel, reader: config.Reader, signerKeyID: config.SignerKeyID,
		privateKey: append(ed25519.PrivateKey(nil), config.PrivateKey...), grants: make(map[string]Grant), now: config.Now}
	grantIDs := make(map[string]bool)
	for _, grant := range config.Grants {
		if !idPattern.MatchString(grant.RequestID) || !hashPattern.MatchString(grant.RequestHash) || grant.Fence == 0 || grant.ExpiresAt.IsZero() || grant.MaxBytes < 0 || grant.MaxBytes > MaxValueBytes {
			return nil, fmt.Errorf("invalid exact effect grant")
		}
		if (grant.Effect != "clock.read" && grant.Effect != "fs.read") || !capabilityPattern.MatchString(grant.Capability) ||
			(grant.Effect == "fs.read" && (grant.RootID == "" || grant.MaxBytes <= 0)) {
			return nil, fmt.Errorf("invalid exact effect grant policy")
		}
		if err := ValidateBinding(grant.Binding); err != nil {
			return nil, err
		}
		if _, exists := b.grants[grant.RequestID]; exists || grantIDs[grant.GrantID] {
			return nil, fmt.Errorf("duplicate effect request grant")
		}
		grantIDs[grant.GrantID] = true
		b.grants[grant.RequestID] = grant
	}
	return b, nil
}

func (b *Broker) ExpectedBinding(requestID string) (Binding, bool) {
	grant, ok := b.grants[requestID]
	return grant.Binding, ok
}

func leaseToken(grant Grant) controlkernel.LeaseToken {
	return controlkernel.LeaseToken{LeaseID: grant.LeaseID, Fence: grant.Fence}
}

func (b *Broker) authorize(credential string, grant Grant) (controlkernel.Lease, string) {
	if !b.now().Before(grant.ExpiresAt) {
		return controlkernel.Lease{}, "grant_expired"
	}
	lease, err := b.kernel.ValidateExecutorLease(credential, grant.ExecutorID, grant.NodeID, leaseToken(grant))
	if err != nil {
		switch {
		case errors.Is(err, controlkernel.ErrLeaseExpired):
			return controlkernel.Lease{}, "lease_expired"
		case errors.Is(err, controlkernel.ErrStaleLease):
			return controlkernel.Lease{}, "stale_lease"
		default:
			return controlkernel.Lease{}, "executor_denied"
		}
	}
	if lease.TaskID != grant.TaskID || lease.AttemptID != grant.AttemptID {
		return controlkernel.Lease{}, "epoch_mismatch"
	}
	return lease, ""
}

func (b *Broker) outcome(req wire.EffectRequest, grant Grant, intentID, status, code, valueType string, value []byte) (wire.EffectResult, wire.EffectReceipt, error) {
	if value == nil {
		value = []byte{}
	}
	result := wire.EffectResult{ProtocolVersion: ProtocolVersion, RequestID: req.RequestID,
		Status: status, ValueType: valueType, Value: value, ErrorCode: code}
	requestHash, err := RequestHash(req)
	if err != nil {
		return wire.EffectResult{}, wire.EffectReceipt{}, err
	}
	resultHash, err := ResultHash(result)
	if err != nil {
		return wire.EffectResult{}, wire.EffectReceipt{}, err
	}
	receipt := wire.EffectReceipt{ProtocolVersion: ProtocolVersion, RequestID: req.RequestID,
		RequestHash: requestHash, ResultHash: resultHash, Effect: req.Effect, Capability: req.Capability,
		TaskID: grant.TaskID, NodeID: grant.NodeID, AttemptID: grant.AttemptID, ExecutorID: grant.ExecutorID,
		GrantID: grant.GrantID, LeaseID: grant.LeaseID, Fence: grant.Fence, IntentID: intentID,
		Status: status, ErrorCode: code, OccurredAtUnixMS: b.now().UTC().UnixMilli(), PrivacyClass: "local_private", SignerKeyID: b.signerKeyID}
	if receipt.OccurredAtUnixMS < 0 {
		return wire.EffectResult{}, wire.EffectReceipt{}, fmt.Errorf("broker clock precedes Unix epoch")
	}
	if err := SignReceipt(&receipt, b.privateKey); err != nil {
		return wire.EffectResult{}, wire.EffectReceipt{}, err
	}
	return result, receipt, nil
}

func (b *Broker) uncertain(grant Grant, intent controlkernel.Intent) {
	if _, err := b.kernel.MarkIntentUncertain(intent.ID, leaseToken(grant)); err == nil {
		_ = b.kernel.TransitionNode(grant.NodeID, controlkernel.NodeUncertain, leaseToken(grant))
	} else {
		// Recovery is permitted only after lease loss. It does not invoke the
		// provider or infer an outcome from a transport/storage error.
		_, _ = b.kernel.RecoverStartedIntent(intent.ID)
	}
}

// Execute executes at most one read-only effect per configured node. The
// Control Kernel fsyncs PREPARED and STARTED before the provider is called.
// Any already-observed execution (including a recorded RESULT) is blocked;
// an independent reconciler must consume evidence rather than replaying it.
func (b *Broker) Execute(ctx context.Context, credential string, req wire.EffectRequest) (wire.EffectResult, wire.EffectReceipt, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := ValidateRequest(req); err != nil {
		return wire.EffectResult{}, wire.EffectReceipt{}, err
	}
	grant, exists := b.grants[req.RequestID]
	valueType := "bytes"
	if req.Effect == "clock.read" {
		valueType = "i64"
	}
	finish := func(intentID, status, code string, value []byte) (wire.EffectResult, wire.EffectReceipt, error) {
		return b.outcome(req, grant, intentID, status, code, valueType, value)
	}
	requestHash, err := RequestHash(req)
	if err != nil {
		return wire.EffectResult{}, wire.EffectReceipt{}, err
	}
	if !exists || requestHash != grant.RequestHash || req.Effect != grant.Effect || req.Capability != grant.Capability ||
		(req.Effect == "fs.read" && (grant.RootID == "" || grant.MaxBytes <= 0 || b.reader == nil)) {
		return finish("", "denied", "grant_denied", nil)
	}
	if err := ctx.Err(); err != nil {
		return finish("", "denied", "cancelled", nil)
	}
	lease, code := b.authorize(credential, grant)
	if code != "" {
		return finish("", "denied", code, nil)
	}
	key := "effect:v1:" + req.RequestID
	if existing, ok := b.kernel.IntentByKey(key); ok && existing.State != controlkernel.IntentPrepared {
		return finish(existing.ID, "blocked", "reconciliation_required", nil)
	}
	node, ok := b.kernel.Node(grant.NodeID)
	if !ok || (node.State != controlkernel.NodeLeased && node.State != controlkernel.NodePreparing) {
		return finish("", "blocked", "node_not_preparing", nil)
	}
	readLimit := grant.MaxBytes
	if req.Effect == "fs.read" {
		task, ok := b.kernel.Task(grant.TaskID)
		if !ok || node.Budget.MaxReadBytes < 0 || task.Budget.MaxReadBytes < 0 {
			return finish("", "denied", "invalid_read_budget", nil)
		}
		// Zero means no additional bound in the existing optional Budget
		// model. Positive kernel budgets can only tighten a host grant.
		for _, budget := range []int64{node.Budget.MaxReadBytes, task.Budget.MaxReadBytes} {
			if budget > 0 && budget < readLimit {
				readLimit = budget
			}
		}
	}
	if node.State == controlkernel.NodeLeased {
		if err := b.kernel.TransitionNode(grant.NodeID, controlkernel.NodePreparing, leaseToken(grant)); err != nil {
			return finish("", "blocked", "prepare_failed", nil)
		}
	}
	intent, _, err := b.kernel.PrepareIntent(controlkernel.Intent{TaskID: grant.TaskID, NodeID: grant.NodeID,
		Kind: req.Effect, IdempotencyKey: key, RequestHash: requestHash}, leaseToken(grant))
	if err != nil {
		return finish("", "blocked", "intent_conflict", nil)
	}
	if err := ctx.Err(); err != nil {
		return finish(intent.ID, "denied", "cancelled", nil)
	}
	if _, code = b.authorize(credential, grant); code != "" {
		return finish(intent.ID, "denied", code, nil)
	}
	if err := b.kernel.TransitionNode(grant.NodeID, controlkernel.NodeExecuting, leaseToken(grant)); err != nil {
		return finish(intent.ID, "blocked", "start_failed", nil)
	}
	if _, err := b.kernel.StartIntent(intent.ID, leaseToken(grant)); err != nil {
		return finish(intent.ID, "blocked", "start_failed", nil)
	}
	deadline := grant.ExpiresAt
	if lease.ExpiresAt.Before(deadline) {
		deadline = lease.ExpiresAt
	}
	executionCtx, cancel := context.WithTimeout(ctx, deadline.Sub(b.now()))
	defer cancel()
	// Journal fsync may consume the remainder of a grant/lease deadline.
	// STARTED is not permission to call a provider after authority expires.
	if executionCtx.Err() != nil {
		b.uncertain(grant, intent)
		return finish(intent.ID, "uncertain", "execution_cancelled", nil)
	}
	if _, code = b.authorize(credential, grant); code != "" {
		b.uncertain(grant, intent)
		return finish(intent.ID, "uncertain", code, nil)
	}
	var value []byte
	if req.Effect == "clock.read" {
		value = []byte(strconv.FormatInt(b.now().UTC().UnixMilli(), 10))
	} else {
		value, err = b.reader.Read(executionCtx, grant.RootID, req.Path, readLimit)
	}
	if executionCtx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		b.uncertain(grant, intent)
		return finish(intent.ID, "uncertain", "execution_cancelled", nil)
	}
	if _, code = b.authorize(credential, grant); code != "" {
		b.uncertain(grant, intent)
		return finish(intent.ID, "uncertain", code, nil)
	}
	status := "succeeded"
	if err != nil || len(value) > MaxValueBytes || (req.Effect == "fs.read" && int64(len(value)) > readLimit) {
		status, code, value = "failed", "provider_failed", nil
	}
	result, receipt, err := finish(intent.ID, status, code, value)
	if err != nil {
		b.uncertain(grant, intent)
		return wire.EffectResult{}, wire.EffectReceipt{}, err
	}
	if _, code = b.authorize(credential, grant); code != "" {
		b.uncertain(grant, intent)
		return finish(intent.ID, "uncertain", code, nil)
	}
	if _, err := b.kernel.RecordIntentResult(intent.ID, leaseToken(grant), "", receipt.ResultHash); err != nil {
		b.uncertain(grant, intent)
		return finish(intent.ID, "uncertain", "result_not_durable", nil)
	}
	return result, receipt, nil
}
