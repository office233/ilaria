package swypbroker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"swypik-os/core/controlkernel"
)

const controlKernelIntentKind = "swyp.foreign.call"

var (
	ErrPlanNotApproved   = errors.New("broker plan is not approved")
	ErrPlanMismatch      = errors.New("broker request does not match approved plan")
	ErrExecutionComplete = errors.New("broker execution is already committed")
)

// PreparedExecution is an opaque host-side binding between one broker request
// and one durable Control Kernel intent. Its fields are deliberately private so
// callers cannot swap request/intent identity between Prepare and Execute.
type PreparedExecution struct {
	executionID    string
	nodeID         string
	intentID       string
	idempotencyKey string
	request        Request
}

func (p PreparedExecution) ExecutionID() string { return p.executionID }
func (p PreparedExecution) NodeID() string      { return p.nodeID }
func (p PreparedExecution) IntentID() string    { return p.intentID }
func (p PreparedExecution) RequestID() string   { return p.request.RequestID }
func (p PreparedExecution) PlanID() string      { return p.request.PlanID }

type KernelBroker struct {
	kernel *controlkernel.Kernel
	broker *Broker
}

func NewKernelBroker(kernel *controlkernel.Kernel, broker *Broker) (*KernelBroker, error) {
	if kernel == nil || broker == nil {
		return nil, errors.New("kernel broker requires control kernel and broker")
	}
	return &KernelBroker{kernel: kernel, broker: broker}, nil
}

// Prepare durably records the foreign side-effect intent while the node is in
// PREPARING. It performs protocol/plan validation before writing the intent, but
// it does not resolve capability authority and does not execute foreign code.
func (k *KernelBroker) Prepare(executionID, nodeID string, token controlkernel.LeaseToken, raw []byte) (PreparedExecution, error) {
	if !validExecutionID(executionID) || nodeID == "" {
		return PreparedExecution{}, errors.New("invalid kernel broker execution identity")
	}
	request, err := ParseRequest(raw)
	if err != nil {
		return PreparedExecution{}, err
	}
	plan, ok := k.broker.registry.Lookup(request.PlanID)
	if !ok {
		return PreparedExecution{}, ErrPlanNotApproved
	}
	if err := ValidateRequestAgainstPlan(request, plan); err != nil {
		return PreparedExecution{}, fmt.Errorf("%w: %v", ErrPlanMismatch, err)
	}
	if _, err := k.kernel.ValidateLease(nodeID, token); err != nil {
		return PreparedExecution{}, err
	}
	node, ok := k.kernel.Node(nodeID)
	if !ok {
		return PreparedExecution{}, fmt.Errorf("control-kernel node %q not found", nodeID)
	}
	if node.State != controlkernel.NodePreparing {
		return PreparedExecution{}, fmt.Errorf("kernel broker prepare requires PREPARING node, got %s", node.State)
	}

	idempotencyKey := "swyp-broker:" + executionID
	intent, _, err := k.kernel.PrepareIntent(controlkernel.Intent{
		NodeID:         nodeID,
		Kind:           controlKernelIntentKind,
		IdempotencyKey: idempotencyKey,
		RequestHash:    request.RequestID,
	}, token)
	if err != nil {
		return PreparedExecution{}, err
	}
	if intent.State == controlkernel.IntentCommitted {
		return PreparedExecution{}, ErrExecutionComplete
	}
	if intent.State != controlkernel.IntentPrepared {
		return PreparedExecution{}, fmt.Errorf("prepared broker intent is in unexpected state %s", intent.State)
	}
	return PreparedExecution{
		executionID:    executionID,
		nodeID:         nodeID,
		intentID:       intent.ID,
		idempotencyKey: idempotencyKey,
		request:        request,
	}, nil
}

// ExecutePrepared revalidates the plan and lease while the node is EXECUTING,
// resolves host-only authority, durably moves the intent to STARTED, and only
// then invokes the trusted adapter. Any adapter/contract failure after STARTED is
// marked UNCERTAIN because an external effect may already have occurred.
func (k *KernelBroker) ExecutePrepared(ctx context.Context, prepared PreparedExecution, token controlkernel.LeaseToken) (Response, error) {
	if prepared.executionID == "" || prepared.nodeID == "" || prepared.intentID == "" || prepared.request.RequestID == "" {
		return Response{}, errors.New("invalid prepared broker execution")
	}
	if _, err := k.kernel.ValidateLease(prepared.nodeID, token); err != nil {
		return Response{}, err
	}
	node, ok := k.kernel.Node(prepared.nodeID)
	if !ok {
		return Response{}, fmt.Errorf("control-kernel node %q not found", prepared.nodeID)
	}
	if node.State != controlkernel.NodeExecuting {
		return Response{}, fmt.Errorf("kernel broker execute requires EXECUTING node, got %s", node.State)
	}
	plan, ok := k.broker.registry.Lookup(prepared.request.PlanID)
	if !ok {
		return denied(prepared.request, "plan_not_approved", "broker plan is not approved"), nil
	}
	if err := ValidateRequestAgainstPlan(prepared.request, plan); err != nil {
		return denied(prepared.request, "plan_mismatch", "request does not match the approved broker plan"), nil
	}

	authorization := Authorization{
		ExecutionID: prepared.executionID,
		PlanID:      prepared.request.PlanID,
		RequestID:   prepared.request.RequestID,
		CallID:      prepared.request.CallID,
		Caller:      prepared.request.Caller,
		Target:      prepared.request.Target,
		Symbol:      prepared.request.Symbol,
		Capability:  prepared.request.Capability,
	}
	grant, err := k.broker.resolver.Resolve(ctx, authorization)
	if err != nil {
		if errors.Is(err, ErrCapabilityDenied) {
			return denied(prepared.request, "capability_denied", "logical capability was not granted"), nil
		}
		return failed(prepared.request, "authorization_error", "host capability resolution failed"), nil
	}
	if !grant.Valid() {
		return failed(prepared.request, "authorization_error", "host capability resolver returned no grant"), nil
	}

	if _, err := k.kernel.StartIntent(prepared.intentID, token); err != nil {
		return Response{}, err
	}
	invocation := Invocation{
		ExecutionID: prepared.executionID,
		PlanID:      prepared.request.PlanID,
		RequestID:   prepared.request.RequestID,
		CallID:      prepared.request.CallID,
		Caller:      prepared.request.Caller,
		Target:      prepared.request.Target,
		ABI:         prepared.request.ABI,
		ABIVersion:  prepared.request.ABIVersion,
		Symbol:      prepared.request.Symbol,
		Capability:  prepared.request.Capability,
		Arguments:   append([]WireValue(nil), prepared.request.Arguments...),
		Result:      prepared.request.Result,
		Grant:       grant,
	}
	result, execErr := k.broker.executor.Execute(ctx, invocation)
	if execErr != nil {
		return k.markUncertain(prepared, token, "executor_error", "trusted foreign adapter failed")
	}

	response := Response{Version: ProtocolVersion, RequestID: prepared.request.RequestID, Status: "ok"}
	if prepared.request.Result.Kind == "void" {
		if result.Type.Kind != "" || result.Encoding != "" || result.Data != "" {
			return k.markUncertain(prepared, token, "executor_contract", "void foreign adapter returned a value")
		}
	} else {
		if !abiTypeEqual(result.Type, prepared.request.Result) || validateWireValue(result) != nil {
			return k.markUncertain(prepared, token, "executor_contract", "foreign adapter returned invalid result")
		}
		response.Result = &result
	}

	resultHash, err := responseContentHash(response)
	if err != nil {
		return Response{}, err
	}
	if _, err := k.kernel.RecordIntentResult(prepared.intentID, token, "swyp-broker:"+prepared.executionID, resultHash); err != nil {
		// The intent remains STARTED. Recovery must reconcile it; do not claim the
		// external effect is safe to replay merely because durable result recording
		// failed after adapter execution.
		return Response{}, err
	}
	return response, nil
}

// CommitResult delegates final durable commit to the Control Kernel. The kernel
// itself enforces that the node is COMMITTING and has an independent passing
// verification for the current lease/fence.
func (k *KernelBroker) CommitResult(prepared PreparedExecution, token controlkernel.LeaseToken) (controlkernel.Intent, error) {
	if prepared.intentID == "" || prepared.nodeID == "" {
		return controlkernel.Intent{}, errors.New("invalid prepared broker execution")
	}
	if _, err := k.kernel.ValidateLease(prepared.nodeID, token); err != nil {
		return controlkernel.Intent{}, err
	}
	intent, ok := k.kernel.IntentByKey(prepared.idempotencyKey)
	if !ok || intent.ID != prepared.intentID || intent.RequestHash != prepared.request.RequestID || intent.Kind != controlKernelIntentKind {
		return controlkernel.Intent{}, errors.New("durable broker intent identity mismatch")
	}
	return k.kernel.CommitIntent(prepared.intentID, token)
}

func (k *KernelBroker) markUncertain(prepared PreparedExecution, token controlkernel.LeaseToken, code, message string) (Response, error) {
	if _, err := k.kernel.MarkIntentUncertain(prepared.intentID, token); err != nil {
		return Response{}, err
	}
	return failed(prepared.request, code, message), nil
}

func responseContentHash(response Response) (string, error) {
	data, err := json.Marshal(response)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}
