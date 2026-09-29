package swypbroker

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

var ErrCapabilityDenied = errors.New("logical capability denied")

// Grant is host-only authority material. It has no exported fields and is never
// serialized into Swyp protocol objects. Trusted capability resolvers create it;
// trusted executors may unwrap it. Guest JSON cannot construct or transmit it.
type Grant struct {
	value any
}

func NewGrant(value any) Grant { return Grant{value: value} }
func (g Grant) Value() any     { return g.value }
func (g Grant) Valid() bool    { return g.value != nil }

type Authorization struct {
	ExecutionID string
	PlanID      string
	RequestID   string
	CallID      string
	Caller      string
	Target      string
	Symbol      string
	Capability  CapabilityRequirement
}

// CapabilityResolver resolves a logical Swyp requirement to host-only
// authority. The returned Grant is never placed in request/response JSON.
type CapabilityResolver interface {
	Resolve(context.Context, Authorization) (Grant, error)
}

type Invocation struct {
	ExecutionID string
	PlanID      string
	RequestID   string
	CallID      string
	Caller      string
	Target      string
	ABI         string
	ABIVersion  string
	Symbol      string
	Capability  CapabilityRequirement
	Arguments   []WireValue
	Result      ABIType
	Grant       Grant
}

// Executor is a trusted host adapter. It receives an already plan-bound request
// plus a host-only grant; it is not a dynamic loader and it must not infer new
// authority from guest-controlled strings.
type Executor interface {
	Execute(context.Context, Invocation) (WireValue, error)
}

type Broker struct {
	registry *Registry
	resolver CapabilityResolver
	executor Executor

	mu         sync.Mutex
	executions map[string]string
}

func New(registry *Registry, resolver CapabilityResolver, executor Executor) (*Broker, error) {
	if registry == nil || resolver == nil || executor == nil {
		return nil, errors.New("broker requires registry, capability resolver, and executor")
	}
	return &Broker{registry: registry, resolver: resolver, executor: executor, executions: map[string]string{}}, nil
}

// Dispatch validates one guest request against an approved plan, resolves its
// logical capability entirely on the host, and invokes a trusted adapter. The
// host-generated executionID is deliberately not part of guest protocol JSON;
// it prevents accidental/replayed execution attempts while allowing the same
// content-addressed request to be intentionally executed under a new host ID.
func (b *Broker) Dispatch(ctx context.Context, executionID string, raw []byte) (Response, error) {
	if !validExecutionID(executionID) {
		return Response{}, errors.New("invalid host execution id")
	}
	request, err := ParseRequest(raw)
	if err != nil {
		return Response{}, err
	}
	plan, ok := b.registry.Lookup(request.PlanID)
	if !ok {
		return denied(request, "plan_not_approved", "broker plan is not approved"), nil
	}
	if err := ValidateRequestAgainstPlan(request, plan); err != nil {
		return denied(request, "plan_mismatch", "request does not match the approved broker plan"), nil
	}
	if !b.reserveExecution(executionID, request.RequestID) {
		return failed(request, "execution_replay", "host execution id was already used"), nil
	}

	authorization := Authorization{
		ExecutionID: executionID,
		PlanID:      request.PlanID,
		RequestID:   request.RequestID,
		CallID:      request.CallID,
		Caller:      request.Caller,
		Target:      request.Target,
		Symbol:      request.Symbol,
		Capability:  request.Capability,
	}
	grant, err := b.resolver.Resolve(ctx, authorization)
	if err != nil {
		if errors.Is(err, ErrCapabilityDenied) {
			return denied(request, "capability_denied", "logical capability was not granted"), nil
		}
		return failed(request, "authorization_error", "host capability resolution failed"), nil
	}
	if !grant.Valid() {
		return failed(request, "authorization_error", "host capability resolver returned no grant"), nil
	}

	invocation := Invocation{
		ExecutionID: executionID,
		PlanID:      request.PlanID,
		RequestID:   request.RequestID,
		CallID:      request.CallID,
		Caller:      request.Caller,
		Target:      request.Target,
		ABI:         request.ABI,
		ABIVersion:  request.ABIVersion,
		Symbol:      request.Symbol,
		Capability:  request.Capability,
		Arguments:   append([]WireValue(nil), request.Arguments...),
		Result:      request.Result,
		Grant:       grant,
	}
	result, err := b.executor.Execute(ctx, invocation)
	if err != nil {
		return failed(request, "executor_error", "trusted foreign adapter failed"), nil
	}
	if request.Result.Kind == "void" {
		if result.Type.Kind != "" || result.Encoding != "" || result.Data != "" {
			return failed(request, "executor_contract", "void foreign adapter returned a value"), nil
		}
		return Response{Version: ProtocolVersion, RequestID: request.RequestID, Status: "ok"}, nil
	}
	if !abiTypeEqual(result.Type, request.Result) {
		return failed(request, "executor_contract", "foreign adapter result ABI mismatch"), nil
	}
	if err := validateWireValue(result); err != nil {
		return failed(request, "executor_contract", "foreign adapter returned invalid wire data"), nil
	}
	return Response{Version: ProtocolVersion, RequestID: request.RequestID, Status: "ok", Result: &result}, nil
}

func (b *Broker) reserveExecution(executionID, requestID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, exists := b.executions[executionID]; exists {
		return false
	}
	b.executions[executionID] = requestID
	return true
}

func validExecutionID(value string) bool {
	if len(value) < 1 || len(value) > 128 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '-' && c != '_' && c != '.' && c != ':' {
			return false
		}
	}
	return true
}

func denied(request Request, code, message string) Response {
	return Response{Version: ProtocolVersion, RequestID: request.RequestID, Status: "denied", Error: &ResponseError{Code: code, Message: message}}
}

func failed(request Request, code, message string) Response {
	return Response{Version: ProtocolVersion, RequestID: request.RequestID, Status: "error", Error: &ResponseError{Code: code, Message: message}}
}

func (b *Broker) String() string {
	return fmt.Sprintf("swypbroker(plans=%d)", b.registry.Count())
}
