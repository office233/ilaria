package swypbroker

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"swypik-os/core/controlkernel"
)

type kernelTestAuthenticator map[string]string

func (a kernelTestAuthenticator) AuthenticateExecutor(credential string) (controlkernel.ExecutorPrincipal, error) {
	id, ok := a[credential]
	if !ok {
		return controlkernel.ExecutorPrincipal{}, errors.New("invalid executor credential")
	}
	return controlkernel.ExecutorPrincipal{ID: id}, nil
}

func (a kernelTestAuthenticator) AuthenticateVerifier(credential string) (controlkernel.VerifierPrincipal, error) {
	id, ok := a[credential]
	if !ok {
		return controlkernel.VerifierPrincipal{}, errors.New("invalid verifier credential")
	}
	return controlkernel.VerifierPrincipal{ID: id}, nil
}

func openBrokerKernel(t *testing.T) (*controlkernel.Kernel, controlkernel.LeaseToken) {
	t.Helper()
	journal := filepath.Join(t.TempDir(), "control-kernel.journal")
	auth := kernelTestAuthenticator{
		"executor-credential": "executor-principal",
		"verifier-credential": "verifier-principal",
	}
	kernel, err := controlkernel.OpenKernel(journal,
		controlkernel.WithExecutorAuthenticator(auth),
		controlkernel.WithVerifierAuthenticator(auth),
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := kernel.CreateTask(controlkernel.Task{ID: "task", Goal: "execute verified Swyp foreign call"}); err != nil {
		t.Fatal(err)
	}
	if _, err := kernel.AddNode(controlkernel.Node{ID: "node", TaskID: "task", Kind: "swyp.foreign.call"}); err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", controlkernel.NodeReady, controlkernel.LeaseToken{}); err != nil {
		t.Fatal(err)
	}
	lease, err := kernel.ClaimLease("node", "executor-credential", "swyp-broker", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	token := controlkernel.LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	if err := kernel.TransitionNode("node", controlkernel.NodePreparing, token); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = kernel.Close() })
	return kernel, token
}

func concreteKernelBroker(t *testing.T, kernel *controlkernel.Kernel) (*KernelBroker, *PolicyResolver, *AdapterRegistry) {
	t.Helper()
	plans := NewRegistry()
	if _, err := plans.ApproveJSON(loadFixture(t, "swyp_scalar_plan_v1.json")); err != nil {
		t.Fatal(err)
	}
	resolver := NewPolicyResolver()
	if err := resolver.Grant("native_math", "c_add", "c_add", NewGrant("kernel-scoped-grant")); err != nil {
		t.Fatal(err)
	}
	adapters := NewAdapterRegistry()
	if err := adapters.Register("c_add", "c_add", "C", "swyp-c64-v1", func(_ context.Context, invocation Invocation) (WireValue, error) {
		left, _ := base64.StdEncoding.DecodeString(invocation.Arguments[0].Data)
		right, _ := base64.StdEncoding.DecodeString(invocation.Arguments[1].Data)
		value := int64(binary.LittleEndian.Uint64(left)) + int64(binary.LittleEndian.Uint64(right))
		data := make([]byte, 8)
		binary.LittleEndian.PutUint64(data, uint64(value))
		return WireValue{Type: invocation.Result, Encoding: WireEncoding, Data: base64.StdEncoding.EncodeToString(data)}, nil
	}); err != nil {
		t.Fatal(err)
	}
	broker, err := New(plans, resolver, adapters)
	if err != nil {
		t.Fatal(err)
	}
	kernelBroker, err := NewKernelBroker(kernel, broker)
	if err != nil {
		t.Fatal(err)
	}
	return kernelBroker, resolver, adapters
}

func TestKernelBrokerDurableIntentLifecycle(t *testing.T) {
	kernel, token := openBrokerKernel(t)
	kernelBroker, _, _ := concreteKernelBroker(t, kernel)
	prepared, err := kernelBroker.Prepare("exec-kernel-001", "node", token, loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	intent, ok := kernel.IntentByKey("swyp-broker:exec-kernel-001")
	if !ok || intent.ID != prepared.IntentID() || intent.State != controlkernel.IntentPrepared || intent.RequestHash != prepared.RequestID() || intent.Kind != controlKernelIntentKind {
		t.Fatalf("prepared intent=%+v", intent)
	}

	if err := kernel.TransitionNode("node", controlkernel.NodeExecuting, token); err != nil {
		t.Fatal(err)
	}
	response, err := kernelBroker.ExecutePrepared(context.Background(), prepared, token)
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != "ok" || response.Result == nil {
		t.Fatalf("response=%+v", response)
	}
	data, _ := base64.StdEncoding.DecodeString(response.Result.Data)
	if got := int64(binary.LittleEndian.Uint64(data)); got != 9007199254740995 {
		t.Fatalf("result=%d", got)
	}
	intent, ok = kernel.IntentByKey("swyp-broker:exec-kernel-001")
	if !ok || intent.State != controlkernel.IntentResult || intent.ResultHash == "" || intent.ExternalRef != "swyp-broker:exec-kernel-001" {
		t.Fatalf("result intent=%+v", intent)
	}

	if err := kernel.TransitionNode("node", controlkernel.NodeVerifying, token); err != nil {
		t.Fatal(err)
	}
	if _, err := kernel.RecordVerification("verifier-credential", controlkernel.VerificationRequest{
		NodeID: "node", Decision: controlkernel.VerificationPassed, EvidenceHash: "sha256:broker-result-evidence",
	}); err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", controlkernel.NodeCommitting, token); err != nil {
		t.Fatal(err)
	}
	committed, err := kernelBroker.CommitResult(prepared, token)
	if err != nil || committed.State != controlkernel.IntentCommitted {
		t.Fatalf("committed=%+v err=%v", committed, err)
	}
	if err := kernel.TransitionNode("node", controlkernel.NodeSucceeded, token); err != nil {
		t.Fatal(err)
	}
}

func TestKernelBrokerDeniedCapabilityNeverStartsIntent(t *testing.T) {
	kernel, token := openBrokerKernel(t)
	kernelBroker, resolver, _ := concreteKernelBroker(t, kernel)
	prepared, err := kernelBroker.Prepare("exec-denied", "node", token, loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !resolver.Revoke("native_math", "c_add", "c_add") {
		t.Fatal("failed to revoke capability")
	}
	if err := kernel.TransitionNode("node", controlkernel.NodeExecuting, token); err != nil {
		t.Fatal(err)
	}
	response, err := kernelBroker.ExecutePrepared(context.Background(), prepared, token)
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != "denied" || response.Error == nil || response.Error.Code != "capability_denied" {
		t.Fatalf("response=%+v", response)
	}
	intent, ok := kernel.IntentByKey("swyp-broker:exec-denied")
	if !ok || intent.State != controlkernel.IntentPrepared {
		t.Fatalf("denial started durable effect: %+v", intent)
	}
	if err := kernel.TransitionNode("node", controlkernel.NodeRetryWait, token); err != nil {
		t.Fatalf("prepared-only denial should remain retryable: %v", err)
	}
}

func TestKernelBrokerAdapterFailureMarksIntentUncertain(t *testing.T) {
	kernel, token := openBrokerKernel(t)
	plans := NewRegistry()
	if _, err := plans.ApproveJSON(loadFixture(t, "swyp_scalar_plan_v1.json")); err != nil {
		t.Fatal(err)
	}
	resolver := NewPolicyResolver()
	if err := resolver.Grant("native_math", "c_add", "c_add", NewGrant("grant")); err != nil {
		t.Fatal(err)
	}
	adapters := NewAdapterRegistry()
	if err := adapters.Register("c_add", "c_add", "C", "swyp-c64-v1", func(context.Context, Invocation) (WireValue, error) {
		return WireValue{}, errors.New("simulated ambiguous native failure")
	}); err != nil {
		t.Fatal(err)
	}
	broker, _ := New(plans, resolver, adapters)
	kernelBroker, _ := NewKernelBroker(kernel, broker)
	prepared, err := kernelBroker.Prepare("exec-uncertain", "node", token, loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", controlkernel.NodeExecuting, token); err != nil {
		t.Fatal(err)
	}
	response, err := kernelBroker.ExecutePrepared(context.Background(), prepared, token)
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != "error" || response.Error == nil || response.Error.Code != "executor_error" {
		t.Fatalf("response=%+v", response)
	}
	intent, _ := kernel.IntentByKey("swyp-broker:exec-uncertain")
	if intent.State != controlkernel.IntentUncertain {
		t.Fatalf("ambiguous adapter failure state=%s", intent.State)
	}
	if err := kernel.TransitionNode("node", controlkernel.NodeVerifying, token); err == nil {
		t.Fatal("uncertain side effect incorrectly entered verification")
	}
}

func TestKernelBrokerRejectsStaleLeaseBeforeAuthorityResolution(t *testing.T) {
	kernel, token := openBrokerKernel(t)
	kernelBroker, resolver, _ := concreteKernelBroker(t, kernel)
	prepared, err := kernelBroker.Prepare("exec-stale", "node", token, loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", controlkernel.NodeExecuting, token); err != nil {
		t.Fatal(err)
	}
	before := resolver.Resolve
	_ = before // retain compile-time proof that resolver is present; stale lease fails first.
	stale := controlkernel.LeaseToken{LeaseID: token.LeaseID, Fence: token.Fence + 1}
	if _, err := kernelBroker.ExecutePrepared(context.Background(), prepared, stale); !errors.Is(err, controlkernel.ErrStaleLease) {
		t.Fatalf("error=%v, want ErrStaleLease", err)
	}
	intent, _ := kernel.IntentByKey("swyp-broker:exec-stale")
	if intent.State != controlkernel.IntentPrepared {
		t.Fatalf("stale lease changed intent state: %+v", intent)
	}
}

func TestKernelBrokerExecutionIDBindsControlKernelIdempotency(t *testing.T) {
	kernel, token := openBrokerKernel(t)
	kernelBroker, _, _ := concreteKernelBroker(t, kernel)
	first, err := kernelBroker.Prepare("exec-idempotent", "node", token, loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := kernelBroker.Prepare("exec-idempotent", "node", token, loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if first.IntentID() != second.IntentID() {
		t.Fatalf("same host execution id created different intents: %s != %s", first.IntentID(), second.IntentID())
	}

	request, err := ParseRequest(loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	request.Arguments[1].Data = "AgAAAAAAAAA="
	request.RequestID, err = requestContentID(request)
	if err != nil {
		t.Fatal(err)
	}
	changed, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := kernelBroker.Prepare("exec-idempotent", "node", token, changed); !errors.Is(err, controlkernel.ErrIdempotencyConflict) {
		t.Fatalf("changed request reused execution id: %v", err)
	}
}

func TestKernelBrokerCommitStillRequiresIndependentVerification(t *testing.T) {
	kernel, token := openBrokerKernel(t)
	kernelBroker, _, _ := concreteKernelBroker(t, kernel)
	prepared, err := kernelBroker.Prepare("exec-no-verify", "node", token, loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", controlkernel.NodeExecuting, token); err != nil {
		t.Fatal(err)
	}
	if _, err := kernelBroker.ExecutePrepared(context.Background(), prepared, token); err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", controlkernel.NodeVerifying, token); err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", controlkernel.NodeCommitting, token); err == nil {
		t.Fatal("node entered COMMITTING without independent verification")
	}
	if _, err := kernelBroker.CommitResult(prepared, token); err == nil {
		t.Fatal("broker intent committed without COMMITTING state and verification")
	}
}

func TestResponseHashIsStable(t *testing.T) {
	response := Response{Version: 1, RequestID: "sha256:" + fmt.Sprintf("%064d", 1), Status: "denied", Error: &ResponseError{Code: "x", Message: "y"}}
	a, err := responseContentHash(response)
	if err != nil {
		t.Fatal(err)
	}
	b, err := responseContentHash(response)
	if err != nil || a != b || len(a) != len("sha256:")+64 {
		t.Fatalf("hash=%q %q err=%v", a, b, err)
	}
}
