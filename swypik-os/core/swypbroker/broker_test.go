package swypbroker

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"testing"
)

type resolverStub struct {
	denied bool
	err    error
	calls  int
	last   Authorization
}

func (r *resolverStub) Resolve(_ context.Context, auth Authorization) (Grant, error) {
	r.calls++
	r.last = auth
	if r.err != nil {
		return Grant{}, r.err
	}
	if r.denied {
		return Grant{}, ErrCapabilityDenied
	}
	return NewGrant("host-only-grant"), nil
}

type executorStub struct {
	calls int
	last  Invocation
	err   error
}

func (e *executorStub) Execute(_ context.Context, invocation Invocation) (WireValue, error) {
	e.calls++
	e.last = invocation
	if e.err != nil {
		return WireValue{}, e.err
	}
	data := make([]byte, 8)
	binary.LittleEndian.PutUint64(data, 42)
	return WireValue{Type: invocation.Result, Encoding: WireEncoding, Data: base64.StdEncoding.EncodeToString(data)}, nil
}

func approvedBroker(t *testing.T, resolver CapabilityResolver, executor Executor) (*Broker, Request) {
	t.Helper()
	registry := NewRegistry()
	if _, err := registry.ApproveJSON(loadFixture(t, "swyp_scalar_plan_v1.json")); err != nil {
		t.Fatal(err)
	}
	broker, err := New(registry, resolver, executor)
	if err != nil {
		t.Fatal(err)
	}
	request, err := ParseRequest(loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	return broker, request
}

func TestBrokerDispatchResolvesHostGrantThenExecutes(t *testing.T) {
	resolver := &resolverStub{}
	executor := &executorStub{}
	broker, request := approvedBroker(t, resolver, executor)
	response, err := broker.Dispatch(context.Background(), "exec-001", loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != "ok" || response.RequestID != request.RequestID || response.Result == nil {
		t.Fatalf("response=%+v", response)
	}
	if resolver.calls != 1 || executor.calls != 1 {
		t.Fatalf("resolver=%d executor=%d", resolver.calls, executor.calls)
	}
	if resolver.last.Capability.Name != "native_math" || executor.last.Capability.Name != "native_math" {
		t.Fatalf("logical capability lost: auth=%+v invocation=%+v", resolver.last, executor.last)
	}
	if executor.last.Grant.Value() != "host-only-grant" {
		t.Fatal("executor did not receive host-only grant")
	}
}

func TestBrokerDenialNeverReachesExecutor(t *testing.T) {
	resolver := &resolverStub{denied: true}
	executor := &executorStub{}
	broker, _ := approvedBroker(t, resolver, executor)
	response, err := broker.Dispatch(context.Background(), "exec-denied", loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != "denied" || response.Error == nil || response.Error.Code != "capability_denied" {
		t.Fatalf("response=%+v", response)
	}
	if executor.calls != 0 {
		t.Fatal("denied request reached executor")
	}
}

func TestBrokerRequiresApprovedPlan(t *testing.T) {
	resolver := &resolverStub{}
	executor := &executorStub{}
	broker, err := New(NewRegistry(), resolver, executor)
	if err != nil {
		t.Fatal(err)
	}
	response, err := broker.Dispatch(context.Background(), "exec-unapproved", loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != "denied" || response.Error == nil || response.Error.Code != "plan_not_approved" {
		t.Fatalf("response=%+v", response)
	}
	if resolver.calls != 0 || executor.calls != 0 {
		t.Fatal("unapproved plan reached authority/executor")
	}
}

func TestBrokerRejectsReplayExecutionID(t *testing.T) {
	resolver := &resolverStub{}
	executor := &executorStub{}
	broker, _ := approvedBroker(t, resolver, executor)
	raw := loadFixture(t, "swyp_scalar_request_v1.json")
	first, err := broker.Dispatch(context.Background(), "exec-replay", raw)
	if err != nil || first.Status != "ok" {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	second, err := broker.Dispatch(context.Background(), "exec-replay", raw)
	if err != nil {
		t.Fatal(err)
	}
	if second.Status != "error" || second.Error == nil || second.Error.Code != "execution_replay" {
		t.Fatalf("second=%+v", second)
	}
	if executor.calls != 1 {
		t.Fatalf("replay executed %d times", executor.calls)
	}
}

func TestBrokerPlanMismatchDoesNotResolveCapability(t *testing.T) {
	resolver := &resolverStub{}
	executor := &executorStub{}
	broker, request := approvedBroker(t, resolver, executor)
	request.Symbol = "attacker_symbol"
	id, err := requestContentID(request)
	if err != nil {
		t.Fatal(err)
	}
	request.RequestID = id
	raw, err := jsonMarshal(request)
	if err != nil {
		t.Fatal(err)
	}
	response, err := broker.Dispatch(context.Background(), "exec-mismatch", raw)
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != "denied" || response.Error == nil || response.Error.Code != "plan_mismatch" {
		t.Fatalf("response=%+v", response)
	}
	if resolver.calls != 0 || executor.calls != 0 {
		t.Fatal("plan mismatch crossed authority boundary")
	}
}

func TestBrokerSanitizesResolverAndExecutorErrors(t *testing.T) {
	resolver := &resolverStub{err: errors.New("secret resolver internals")}
	executor := &executorStub{}
	broker, _ := approvedBroker(t, resolver, executor)
	response, err := broker.Dispatch(context.Background(), "exec-auth-error", loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != "error" || response.Error == nil || response.Error.Message == "secret resolver internals" {
		t.Fatalf("resolver error leaked: %+v", response)
	}

	resolver = &resolverStub{}
	executor = &executorStub{err: errors.New("secret native loader path")}
	broker, _ = approvedBroker(t, resolver, executor)
	response, err = broker.Dispatch(context.Background(), "exec-adapter-error", loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != "error" || response.Error == nil || response.Error.Message == "secret native loader path" {
		t.Fatalf("executor error leaked: %+v", response)
	}
}

func jsonMarshal(value any) ([]byte, error) {
	return json.Marshal(value)
}
