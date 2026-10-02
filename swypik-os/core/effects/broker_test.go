package effects

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"swypik-os/core/controlkernel"
	wire "swypik-os/generated/swypeffects"
)

type testAuthenticator struct{}

func (testAuthenticator) AuthenticateExecutor(credential string) (controlkernel.ExecutorPrincipal, error) {
	if credential == "worker-secret" {
		return controlkernel.ExecutorPrincipal{ID: "worker"}, nil
	}
	if credential == "another-secret" {
		return controlkernel.ExecutorPrincipal{ID: "another-worker"}, nil
	}
	return controlkernel.ExecutorPrincipal{}, errors.New("denied")
}

type readFunc func(context.Context, string, string, int64) ([]byte, error)

func (f readFunc) Read(ctx context.Context, root, path string, maxBytes int64) ([]byte, error) {
	return f(ctx, root, path, maxBytes)
}

type brokerFixture struct {
	t       *testing.T
	journal string
	now     time.Time
	kernel  *controlkernel.Kernel
	grant   Grant
	request wire.EffectRequest
	key     ed25519.PrivateKey
	calls   int
	reader  FileReader
}

func newFixture(t *testing.T) *brokerFixture {
	return newFixtureWithBudgets(t, 0, 0)
}

func newFixtureWithBudgets(t *testing.T, nodeReadBytes, taskReadBytes int64) *brokerFixture {
	t.Helper()
	f := &brokerFixture{t: t, journal: filepath.Join(t.TempDir(), "effect.journal"), now: time.Now().UTC()}
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f.key = key
	f.open()
	if _, err := f.kernel.CreateTask(controlkernel.Task{ID: "task", Goal: "effect fixture", Budget: controlkernel.Budget{MaxReadBytes: taskReadBytes}}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.kernel.AddNode(controlkernel.Node{ID: "node", TaskID: "task", Kind: "fs.read", Budget: controlkernel.Budget{MaxReadBytes: nodeReadBytes}}); err != nil {
		t.Fatal(err)
	}
	if err := f.kernel.TransitionNode("node", controlkernel.NodeReady, controlkernel.LeaseToken{}); err != nil {
		t.Fatal(err)
	}
	lease, err := f.kernel.ClaimLease("node", "worker-secret", "display-label", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	f.request = wire.EffectRequest{ProtocolVersion: ProtocolVersion, RequestID: "run:1", ModuleHash: strings.Repeat("0", 64),
		Function: "main", Effect: "fs.read", Capability: "workspace_read", Path: "input.txt"}
	hash, err := RequestHash(f.request)
	if err != nil {
		t.Fatal(err)
	}
	f.grant = Grant{Binding: Binding{TaskID: "task", NodeID: "node", AttemptID: lease.AttemptID,
		ExecutorID: "worker", GrantID: "grant", LeaseID: lease.ID, Fence: lease.Fence},
		RequestID: f.request.RequestID, RequestHash: hash, Effect: f.request.Effect, Capability: f.request.Capability,
		RootID: "fixture", MaxBytes: 100, ExpiresAt: f.now.Add(time.Hour)}
	f.reader = readFunc(func(context.Context, string, string, int64) ([]byte, error) {
		f.calls++
		return []byte("hello"), nil
	})
	t.Cleanup(func() { _ = f.kernel.Close() })
	return f
}

func TestBrokerReadGrantCannotWidenKernelBudgets(t *testing.T) {
	for _, limits := range []struct{ node, task int64 }{{3, 0}, {0, 3}, {4, 3}} {
		f := newFixtureWithBudgets(t, limits.node, limits.task)
		var suppliedLimit int64
		f.reader = readFunc(func(_ context.Context, _, _ string, maxBytes int64) ([]byte, error) {
			f.calls++
			suppliedLimit = maxBytes
			return []byte("hello"), nil
		})
		result, receipt, err := f.broker().Execute(context.Background(), "worker-secret", f.request)
		if err != nil || result.Status != "failed" || len(result.Value) != 0 || suppliedLimit != 3 || f.calls != 1 {
			t.Fatalf("node=%d task=%d result=%+v providerlimit=%d calls=%d err=%v", limits.node, limits.task, result, suppliedLimit, f.calls, err)
		}
		f.verify(result, receipt)
	}
}

func (f *brokerFixture) open() {
	f.t.Helper()
	var err error
	f.kernel, err = controlkernel.OpenKernel(f.journal, controlkernel.WithClock(func() time.Time { return f.now }),
		controlkernel.WithExecutorAuthenticator(testAuthenticator{}))
	if err != nil {
		f.t.Fatal(err)
	}
}

func (f *brokerFixture) broker() *Broker {
	f.t.Helper()
	b, err := NewBroker(Config{Kernel: f.kernel, Reader: f.reader, SignerKeyID: "host-key", PrivateKey: f.key,
		Grants: []Grant{f.grant}, Now: func() time.Time { return f.now }})
	if err != nil {
		f.t.Fatal(err)
	}
	return b
}

func (f *brokerFixture) verify(result wire.EffectResult, receipt wire.EffectReceipt) {
	f.t.Helper()
	requestHash, _ := RequestHash(f.request)
	resultHash, _ := ResultHash(result)
	if receipt.RequestHash != requestHash || receipt.ResultHash != resultHash || receipt.Status != result.Status || receipt.ErrorCode != result.ErrorCode {
		f.t.Fatalf("receipt/result hash binding mismatch: %+v", receipt)
	}
	signed, err := ReceiptSigningBytes(receipt)
	if err != nil || !ed25519.Verify(f.key.Public().(ed25519.PublicKey), signed, receipt.Signature) {
		f.t.Fatalf("invalid signed evidence: err=%v", err)
	}
	if receipt.LeaseID != f.grant.LeaseID || receipt.Fence != f.grant.Fence || receipt.GrantID != f.grant.GrantID || receipt.ExecutorID != f.grant.ExecutorID {
		f.t.Fatalf("receipt does not bind host epoch: %+v", receipt)
	}
}

func TestBrokerDurableResultAndRestartNeverReplays(t *testing.T) {
	f := newFixture(t)
	result, receipt, err := f.broker().Execute(context.Background(), "worker-secret", f.request)
	if err != nil || result.Status != "succeeded" || string(result.Value) != "hello" || f.calls != 1 {
		t.Fatalf("result=%+v receipt=%+v calls=%d err=%v", result, receipt, f.calls, err)
	}
	f.verify(result, receipt)
	intent, ok := f.kernel.IntentByKey("effect:v1:" + f.request.RequestID)
	if !ok || intent.State != controlkernel.IntentResult || intent.ResultHash != receipt.ResultHash || intent.ID != receipt.IntentID {
		t.Fatalf("result was not durable: %+v", intent)
	}
	if err := f.kernel.Close(); err != nil {
		t.Fatal(err)
	}
	f.open()
	result, receipt, err = f.broker().Execute(context.Background(), "worker-secret", f.request)
	if err != nil || result.Status != "blocked" || result.ErrorCode != "reconciliation_required" || f.calls != 1 {
		t.Fatalf("restart result=%+v calls=%d err=%v", result, f.calls, err)
	}
	f.verify(result, receipt)
}

func TestBrokerDeniedBindingsNeverInvokeProvider(t *testing.T) {
	for _, name := range []string{"executor", "stale", "expired", "deadline", "epoch", "mismatch", "effect_policy", "capability_policy", "cancelled"} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			request, credential, ctx := f.request, "worker-secret", context.Background()
			switch name {
			case "executor":
				credential = "another-secret"
			case "stale":
				f.grant.Fence++
			case "expired":
				f.grant.ExpiresAt = f.now.Add(2 * time.Hour)
				f.now = f.now.Add(time.Hour)
			case "deadline":
				f.grant.ExpiresAt = f.now
			case "epoch":
				f.grant.AttemptID = "other-attempt"
			case "mismatch":
				request.Path = "different.txt"
			case "effect_policy":
				f.grant.Effect = "clock.read"
			case "capability_policy":
				f.grant.Capability = "another_capability"
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			result, _, err := f.broker().Execute(ctx, credential, request)
			if err != nil || result.Status != "denied" || result.ErrorCode == "" || f.calls != 0 {
				t.Fatalf("result=%+v calls=%d err=%v", result, f.calls, err)
			}
			if _, exists := f.kernel.IntentByKey("effect:v1:" + f.request.RequestID); exists {
				t.Fatal("denied request created intent")
			}
		})
	}
}

func TestBrokerStartedIntentAfterCrashCannotReplay(t *testing.T) {
	f := newFixture(t)
	token := leaseToken(f.grant)
	if err := f.kernel.TransitionNode(f.grant.NodeID, controlkernel.NodePreparing, token); err != nil {
		t.Fatal(err)
	}
	intent, _, err := f.kernel.PrepareIntent(controlkernel.Intent{TaskID: f.grant.TaskID, NodeID: f.grant.NodeID,
		Kind: f.request.Effect, IdempotencyKey: "effect:v1:" + f.request.RequestID, RequestHash: f.grant.RequestHash}, token)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.kernel.TransitionNode(f.grant.NodeID, controlkernel.NodeExecuting, token); err != nil {
		t.Fatal(err)
	}
	if _, err := f.kernel.StartIntent(intent.ID, token); err != nil {
		t.Fatal(err)
	}
	if err := f.kernel.Close(); err != nil {
		t.Fatal(err)
	}
	f.open()
	result, receipt, err := f.broker().Execute(context.Background(), "worker-secret", f.request)
	if err != nil || result.Status != "blocked" || result.ErrorCode != "reconciliation_required" || f.calls != 0 {
		t.Fatalf("crash replay: result=%+v calls=%d err=%v", result, f.calls, err)
	}
	f.verify(result, receipt)
}

func TestBrokerCancelledAfterStartRemainsUncertainAndCannotReplay(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	f.reader = readFunc(func(context.Context, string, string, int64) ([]byte, error) {
		f.calls++
		intent, ok := f.kernel.IntentByKey("effect:v1:" + f.request.RequestID)
		if !ok || intent.State != controlkernel.IntentStarted {
			t.Fatalf("provider called before durable STARTED: %+v", intent)
		}
		cancel()
		return []byte("must not be published"), nil
	})
	b := f.broker()
	result, receipt, err := b.Execute(ctx, "worker-secret", f.request)
	if err != nil || result.Status != "uncertain" || len(result.Value) != 0 || f.calls != 1 {
		t.Fatalf("result=%+v calls=%d err=%v", result, f.calls, err)
	}
	f.verify(result, receipt)
	intent, _ := f.kernel.IntentByKey("effect:v1:" + f.request.RequestID)
	if intent.State != controlkernel.IntentUncertain {
		t.Fatalf("uncertain intent=%+v", intent)
	}
	result, _, err = b.Execute(context.Background(), "worker-secret", f.request)
	if err != nil || result.Status != "blocked" || f.calls != 1 {
		t.Fatalf("uncertain replay: result=%+v calls=%d err=%v", result, f.calls, err)
	}
}

func TestBrokerLeaseLossDuringReadRecoversWithoutPublishingValue(t *testing.T) {
	f := newFixture(t)
	f.grant.ExpiresAt = f.now.Add(2 * time.Hour)
	f.reader = readFunc(func(context.Context, string, string, int64) ([]byte, error) {
		f.calls++
		f.now = f.now.Add(time.Hour)
		return []byte("obsolete result"), nil
	})
	result, receipt, err := f.broker().Execute(context.Background(), "worker-secret", f.request)
	if err != nil || result.Status != "uncertain" || result.ErrorCode != "lease_expired" || len(result.Value) != 0 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	f.verify(result, receipt)
	intent, _ := f.kernel.IntentByKey("effect:v1:" + f.request.RequestID)
	if intent.State != controlkernel.IntentUncertain {
		t.Fatalf("lease loss not recovered: %+v", intent)
	}
}

func TestBrokerProviderFailureIsDurableAndBounded(t *testing.T) {
	f := newFixture(t)
	f.reader = readFunc(func(context.Context, string, string, int64) ([]byte, error) {
		f.calls++
		return make([]byte, f.grant.MaxBytes+1), nil
	})
	result, receipt, err := f.broker().Execute(context.Background(), "worker-secret", f.request)
	if err != nil || result.Status != "failed" || len(result.Value) != 0 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	f.verify(result, receipt)
	intent, _ := f.kernel.IntentByKey("effect:v1:" + f.request.RequestID)
	if intent.State != controlkernel.IntentResult || intent.ResultHash != receipt.ResultHash {
		t.Fatalf("failed result not durable: %+v", intent)
	}
}

func TestBrokerClockReadHasNoFileAuthority(t *testing.T) {
	f := newFixture(t)
	f.request.Effect, f.request.Path, f.request.Capability = "clock.read", "", "clock_read"
	f.grant.Effect, f.grant.Capability = f.request.Effect, f.request.Capability
	f.grant.RequestHash, _ = RequestHash(f.request)
	f.grant.RootID, f.grant.MaxBytes = "", 0
	result, receipt, err := f.broker().Execute(context.Background(), "worker-secret", f.request)
	if err != nil || result.Status != "succeeded" || result.ValueType != "i64" || f.calls != 0 {
		t.Fatalf("clock result=%+v calls=%d err=%v", result, f.calls, err)
	}
	f.verify(result, receipt)
}

func TestBrokerDeadlineExpiringDuringStartNeverInvokesProvider(t *testing.T) {
	f := newFixture(t)
	clockCalls := 0
	b, err := NewBroker(Config{Kernel: f.kernel, Reader: f.reader, SignerKeyID: "host-key", PrivateKey: f.key, Grants: []Grant{f.grant},
		Now: func() time.Time {
			clockCalls++
			if clockCalls >= 3 {
				return f.grant.ExpiresAt
			}
			return f.now
		}})
	if err != nil {
		t.Fatal(err)
	}
	result, _, err := b.Execute(context.Background(), "worker-secret", f.request)
	if err != nil || result.Status != "uncertain" || f.calls != 0 {
		t.Fatalf("result=%+v calls=%d err=%v", result, f.calls, err)
	}
	intent, _ := f.kernel.IntentByKey("effect:v1:" + f.request.RequestID)
	if intent.State != controlkernel.IntentUncertain {
		t.Fatalf("started expiration not quarantined: %+v", intent)
	}
}
