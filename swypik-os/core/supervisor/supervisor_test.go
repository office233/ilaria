package supervisor

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"swypik-os/core/controlkernel"
	"swypik-os/core/effects"
	wire "swypik-os/generated/swypeffects"
)

type testAuthenticator struct{}

func (testAuthenticator) AuthenticateExecutor(credential string) (controlkernel.ExecutorPrincipal, error) {
	if credential != "worker-secret" {
		return controlkernel.ExecutorPrincipal{}, errors.New("denied")
	}
	return controlkernel.ExecutorPrincipal{ID: "worker"}, nil
}

func (testAuthenticator) AuthenticateVerifier(credential string) (controlkernel.VerifierPrincipal, error) {
	if credential == "auditor-secret" {
		return controlkernel.VerifierPrincipal{ID: "auditor"}, nil
	}
	if credential == "worker-secret" {
		return controlkernel.VerifierPrincipal{ID: "worker"}, nil
	}
	return controlkernel.VerifierPrincipal{}, errors.New("denied")
}

type verifierFunc func(context.Context, wire.EffectRequest, wire.EffectResult, wire.EffectReceipt, effects.Binding) (Verification, error)

func (f verifierFunc) Verify(ctx context.Context, request wire.EffectRequest, result wire.EffectResult, receipt wire.EffectReceipt, expected effects.Binding) (Verification, error) {
	return f(ctx, request, result, receipt, expected)
}

type readFunc func(context.Context, string, string, int64) ([]byte, error)

func (f readFunc) Read(ctx context.Context, rootID, path string, maxBytes int64) ([]byte, error) {
	return f(ctx, rootID, path, maxBytes)
}

type fixture struct {
	t        *testing.T
	now      time.Time
	kernel   *controlkernel.Kernel
	journal  string
	config   Config
	sup      *Supervisor
	reader   *effects.Reader
	reads    int
	verifies int
	verify   verifierFunc
	read     readFunc
}

func verifiedReply(request wire.EffectRequest, result wire.EffectResult, receipt wire.EffectReceipt, expected effects.Binding) Verification {
	requestHash, _ := effects.RequestHash(request)
	resultHash, _ := effects.ResultHash(result)
	raw, _ := effects.ReceiptSigningBytes(receipt)
	hash := sha256.Sum256(raw)
	return Verification{Verified: true, RequestHash: requestHash, ResultHash: resultHash, ReceiptHash: hex.EncodeToString(hash[:]), Expected: expected}
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	f := &fixture{t: t, now: time.Now().UTC(), journal: filepath.Join(dir, "kernel.journal")}
	f.openKernel()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, "data")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "input.txt"), []byte("abc"), 0600); err != nil {
		t.Fatal(err)
	}
	f.reader, err = effects.OpenReader(map[string]string{"fixture": root})
	if err != nil {
		t.Fatal(err)
	}
	f.read = f.reader.Read
	f.verify = func(_ context.Context, request wire.EffectRequest, result wire.EffectResult, receipt wire.EffectReceipt, expected effects.Binding) (Verification, error) {
		return verifiedReply(request, result, receipt, expected), nil
	}
	f.config = Config{Kernel: f.kernel, LedgerPath: filepath.Join(dir, "plan.journal"), SignerKeyID: "host-key", PrivateKey: key,
		ExecutorID: "worker", ExecutorCredential: "worker-secret", VerifierID: "auditor", VerifierCredential: "auditor-secret",
		Plan: Plan{TaskID: "task", RunID: "run", ModuleHash: strings.Repeat("0", 64), Entry: "main", MaxEffects: 4, MaxReadBytes: 8, Deadline: f.now.Add(time.Hour),
			Effects: []string{"clock.read", "fs.read"}, Bindings: []Binding{{Function: "main", Effect: "clock.read", Capability: "clock_read"}, {Function: "main", Effect: "fs.read", Capability: "workspace_read"}}},
		Scopes:    []Scope{{Function: "main", Effect: "clock.read", Capability: "clock_read"}, {Function: "main", Effect: "fs.read", Capability: "workspace_read", Path: "input.txt", RootID: "fixture", MaxReadBytes: 4}},
		RootPaths: map[string]string{"fixture": root}, Now: func() time.Time { return f.now },
		Reader: readFunc(func(ctx context.Context, rootID, path string, maxBytes int64) ([]byte, error) {
			f.reads++
			return f.read(ctx, rootID, path, maxBytes)
		}),
		Verifier: verifierFunc(func(ctx context.Context, request wire.EffectRequest, result wire.EffectResult, receipt wire.EffectReceipt, expected effects.Binding) (Verification, error) {
			f.verifies++
			return f.verify(ctx, request, result, receipt, expected)
		})}
	t.Cleanup(func() {
		if f.sup != nil {
			_ = f.sup.Close()
		}
		_ = f.kernel.Close()
		_ = f.reader.Close()
	})
	return f
}

func (f *fixture) openKernel() {
	f.t.Helper()
	var err error
	f.kernel, err = controlkernel.OpenKernel(f.journal, controlkernel.WithClock(func() time.Time { return f.now }),
		controlkernel.WithExecutorAuthenticator(testAuthenticator{}), controlkernel.WithVerifierAuthenticator(testAuthenticator{}))
	if err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) open() {
	f.t.Helper()
	var err error
	f.sup, err = Open(f.config)
	if err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) reopen() {
	f.t.Helper()
	if err := f.sup.Close(); err != nil {
		f.t.Fatal(err)
	}
	if err := f.kernel.Close(); err != nil {
		f.t.Fatal(err)
	}
	f.openKernel()
	f.config.Kernel = f.kernel
	f.open()
}

func (f *fixture) start() {
	f.t.Helper()
	f.open()
	if err := f.sup.Start(context.Background()); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) request(sequence uint64, effect string) wire.EffectRequest {
	request := wire.EffectRequest{ProtocolVersion: 1, RequestID: f.config.Plan.RunID + ":" + strconv.FormatUint(sequence, 10),
		ModuleHash: f.config.Plan.ModuleHash, Function: "main", Effect: effect, Capability: "clock_read"}
	if effect == "fs.read" {
		request.Capability, request.Path = "workspace_read", "input.txt"
	}
	return request
}

func (f *fixture) handle(sequence uint64, effect string) Evidence {
	f.t.Helper()
	evidence, err := f.sup.Handle(context.Background(), f.request(sequence, effect))
	if err != nil {
		f.t.Fatal(err)
	}
	return evidence
}

func TestPlanVerifiesAndCommitsThenReopensStatusOnly(t *testing.T) {
	f := newFixture(t)
	f.start()
	first := f.handle(1, "fs.read")
	second := f.handle(2, "clock.read")
	if string(first.Result.Value) != "abc" || first.NodeState != controlkernel.NodeSucceeded || second.NodeState != controlkernel.NodeSucceeded || f.reads != 1 || f.verifies != 2 {
		t.Fatalf("first=%+v second=%+v reads=%d verifies=%d", first, second, f.reads, f.verifies)
	}
	for _, evidence := range []Evidence{first, second} {
		intent, ok := f.kernel.IntentByKey("effect:v1:" + evidence.Request.RequestID)
		verdicts := f.kernel.Verifications(evidence.Expected.NodeID)
		if !ok || intent.State != controlkernel.IntentCommitted || len(verdicts) != 1 || verdicts[0].Decision != controlkernel.VerificationPassed || verdicts[0].VerifierID == evidence.Expected.ExecutorID {
			t.Fatalf("intent=%+v verdicts=%+v", intent, verdicts)
		}
	}
	status, err := f.sup.Finish(context.Background(), strings.Repeat("1", 64))
	if err != nil || status.State != StateSucceeded || status.Issued != 2 || status.Committed != 2 || status.ReservedReadBytes != 4 {
		t.Fatalf("finish=%+v err=%v", status, err)
	}
	for sequence := uint64(3); sequence <= 4; sequence++ {
		node, _ := f.kernel.Node(nodeID(status.PlanHash, sequence))
		if node.State != controlkernel.NodeCancelled {
			t.Fatalf("unused node=%+v", node)
		}
	}
	f.reopen()
	if reopened := f.sup.Status(); reopened != status {
		t.Fatalf("reopened=%+v want=%+v", reopened, status)
	}
	if err := f.sup.Start(context.Background()); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatalf("terminal restart err=%v", err)
	}
	if _, err := f.sup.Handle(context.Background(), f.request(1, "fs.read")); !errors.Is(err, ErrRecoveryRequired) || f.reads != 1 {
		t.Fatalf("terminal replay err=%v reads=%d", err, f.reads)
	}
}

func TestPlanDeniesGuestMismatchesBeforeGrantOrBudgetReservation(t *testing.T) {
	for _, name := range []string{"module", "function", "capability", "path", "run", "sequence", "effect", "deadline", "cancelled"} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			f.start()
			request, ctx := f.request(1, "fs.read"), context.Background()
			switch name {
			case "module":
				request.ModuleHash = strings.Repeat("1", 64)
			case "function":
				request.Function = "other"
			case "capability":
				request.Capability = "other"
			case "path":
				request.Path = "other.txt"
			case "run":
				request.RequestID = "other:1"
			case "sequence":
				request.RequestID = "run:2"
			case "effect":
				request.Effect = "fs.write"
			case "deadline":
				f.now = f.config.Plan.Deadline
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			if _, err := f.sup.Handle(ctx, request); !errors.Is(err, ErrDenied) {
				t.Fatalf("denied err=%v", err)
			}
			status := f.sup.Status()
			if status.Issued != 0 || status.ReservedReadBytes != 0 || status.State != StateFailed || f.reads != 0 || f.verifies != 0 {
				t.Fatalf("status=%+v reads=%d verifies=%d", status, f.reads, f.verifies)
			}
			if _, exists := f.kernel.Lease(nodeID(status.PlanHash, 1)); exists {
				t.Fatal("denied request minted a lease")
			}
			if _, err := f.sup.Handle(context.Background(), f.request(1, "fs.read")); !errors.Is(err, ErrRecoveryRequired) {
				t.Fatalf("continued after denial: %v", err)
			}
		})
	}
}

func TestPlanReservesWholeReadBudgetAndEffectCountDurably(t *testing.T) {
	for _, limit := range []string{"read", "count"} {
		t.Run(limit, func(t *testing.T) {
			f := newFixture(t)
			if limit == "count" {
				f.config.Plan.MaxEffects = 2
			}
			f.start()
			f.handle(1, "fs.read")
			f.handle(2, "fs.read")
			if _, err := f.sup.Handle(context.Background(), f.request(3, "fs.read")); !errors.Is(err, ErrDenied) || f.reads != 2 {
				t.Fatalf("budget err=%v reads=%d", err, f.reads)
			}
			before := f.sup.Status()
			if before.Issued != 2 || before.Committed != 2 || before.ReservedReadBytes != 8 || before.State != StateFailed {
				t.Fatalf("budget status=%+v", before)
			}
			f.reopen()
			if f.sup.Status() != before {
				t.Fatalf("reopening reset quota: %+v", f.sup.Status())
			}
			if err := f.sup.Start(context.Background()); !errors.Is(err, ErrRecoveryRequired) {
				t.Fatalf("budget restart allowed: %v", err)
			}
		})
	}
}

func TestReopenStartedPlanCannotLaunchGuestEvenBeforeFirstRequest(t *testing.T) {
	f := newFixture(t)
	f.start()
	f.reopen()
	if err := f.sup.Start(context.Background()); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatalf("guest launch replay err=%v", err)
	}
	if _, err := f.sup.Handle(context.Background(), f.request(1, "fs.read")); !errors.Is(err, ErrRecoveryRequired) || f.reads != 0 {
		t.Fatalf("effect replay err=%v reads=%d", err, f.reads)
	}
}

func TestSupervisorPolicyAndLedgerOwnershipCannotBeReset(t *testing.T) {
	for _, changed := range []string{"budget", "scope", "roots", "execution_policy", "missing_ledger"} {
		t.Run(changed, func(t *testing.T) {
			f := newFixture(t)
			f.open()
			if err := f.sup.Close(); err != nil {
				t.Fatal(err)
			}
			switch changed {
			case "budget":
				f.config.Plan.MaxReadBytes++
			case "scope":
				f.config.Scopes[1].MaxReadBytes++
			case "roots":
				f.config.RootPaths["fixture"] = t.TempDir()
			case "execution_policy":
				f.config.ExecutionPolicyHash = strings.Repeat("2", 64)
			case "missing_ledger":
				if err := os.Remove(f.config.LedgerPath); err != nil {
					t.Fatal(err)
				}
			}
			if reopened, err := Open(f.config); err == nil {
				_ = reopened.Close()
				t.Fatal("changed/missing durable policy accepted")
			} else if changed == "missing_ledger" {
				if !errors.Is(err, ErrRecoveryRequired) {
					t.Fatalf("missing ledger err=%v", err)
				}
				if _, err := os.Stat(f.config.LedgerPath); !os.IsNotExist(err) {
					t.Fatalf("missing ledger recreated: %v", err)
				}
			} else if !errors.Is(err, ErrPolicyChanged) {
				t.Fatalf("changed policy err=%v", err)
			}
		})
	}
}

func TestSupervisorVerifierMustCorrelateIndependentEvidenceAndEpoch(t *testing.T) {
	for _, failure := range []string{"reject", "request_hash", "result_hash", "receipt_hash", "epoch", "unavailable", "expired", "kernel_closed"} {
		t.Run(failure, func(t *testing.T) {
			f := newFixture(t)
			f.verify = func(_ context.Context, request wire.EffectRequest, result wire.EffectResult, receipt wire.EffectReceipt, expected effects.Binding) (Verification, error) {
				reply := verifiedReply(request, result, receipt, expected)
				switch failure {
				case "reject":
					reply.Verified = false
				case "request_hash":
					reply.RequestHash = strings.Repeat("1", 64)
				case "result_hash":
					reply.ResultHash = strings.Repeat("1", 64)
				case "receipt_hash":
					reply.ReceiptHash = strings.Repeat("1", 64)
				case "epoch":
					reply.Expected.Fence++
				case "unavailable":
					return Verification{}, errors.New("offline verifier")
				case "expired":
					f.now = f.config.Plan.Deadline
				case "kernel_closed":
					if err := f.kernel.Close(); err != nil {
						t.Fatal(err)
					}
				}
				return reply, nil
			}
			f.start()
			evidence, err := f.sup.Handle(context.Background(), f.request(1, "fs.read"))
			if err == nil || evidence.NodeState == controlkernel.NodeSucceeded || f.reads != 1 || f.verifies != 1 {
				t.Fatalf("failure=%s evidence=%+v err=%v", failure, evidence, err)
			}
			status := f.sup.Status()
			if status.State != StateUncertain || status.Issued != 1 || status.Committed != 0 || status.ReservedReadBytes != 4 {
				t.Fatalf("unverified status=%+v", status)
			}
			if failure == "reject" {
				verdicts := f.kernel.Verifications(evidence.Expected.NodeID)
				if len(verdicts) != 1 || verdicts[0].Decision != controlkernel.VerificationFailed {
					t.Fatalf("independent rejected verdict not durable: %+v", verdicts)
				}
			}
			if _, err := f.sup.Handle(context.Background(), f.request(2, "clock.read")); !errors.Is(err, ErrRecoveryRequired) {
				t.Fatalf("verification failure continued: %v", err)
			}
			f.reopen()
			if err := f.sup.Start(context.Background()); !errors.Is(err, ErrRecoveryRequired) || f.reads != 1 {
				t.Fatalf("uncertain restart err=%v reads=%d", err, f.reads)
			}
		})
	}
}

func TestSupervisorLedgerFailureNeverGrantsOrResetsLaunch(t *testing.T) {
	f := newFixture(t)
	f.start()
	if err := f.sup.store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sup.Handle(context.Background(), f.request(1, "fs.read")); err == nil || f.reads != 0 || f.sup.Status().Issued != 0 {
		t.Fatalf("failed reservation err=%v reads=%d status=%+v", err, f.reads, f.sup.Status())
	}
	f.reopen()
	if err := f.sup.Start(context.Background()); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatalf("failed ledger reset launch: %v", err)
	}
}

func TestSupervisorRejectsSharedIdentityAndInvalidPolicyBeforeLedgerCreation(t *testing.T) {
	for _, invalid := range []string{"identity", "run_id", "maxeffects", "hosthash", "ambiguous", "badroot", "clock_scope"} {
		t.Run(invalid, func(t *testing.T) {
			f := newFixture(t)
			switch invalid {
			case "identity":
				f.config.VerifierID, f.config.VerifierCredential = "worker", "worker-secret"
			case "run_id":
				f.config.Plan.RunID = ""
			case "maxeffects":
				f.config.Plan.MaxEffects = MaxPlanEffects + 1
			case "hosthash":
				f.config.ExecutionPolicyHash = "invalid"
			case "ambiguous":
				f.config.Plan.Bindings = append(f.config.Plan.Bindings, f.config.Plan.Bindings[0])
			case "badroot":
				f.config.RootPaths["fixture"] = "relative"
			case "clock_scope":
				f.config.Scopes[0].RootID = "fixture"
			}
			if sup, err := Open(f.config); err == nil {
				_ = sup.Close()
				t.Fatal("invalid policy accepted")
			}
			if _, err := os.Stat(f.config.LedgerPath); !os.IsNotExist(err) {
				t.Fatalf("invalid policy created ledger: %v", err)
			}
		})
	}
}

func TestPlanAllowsConservativeUnusedEffectDeclaration(t *testing.T) {
	f := newFixture(t)
	f.config.Plan.Bindings = f.config.Plan.Bindings[1:]
	f.config.Scopes = f.config.Scopes[1:]
	f.start()
	f.handle(1, "fs.read")
	if _, err := f.sup.Finish(context.Background(), strings.Repeat("1", 64)); err != nil {
		t.Fatal(err)
	}
}

func TestSupervisorCannotFinishCancelledOrUncommittedRun(t *testing.T) {
	f := newFixture(t)
	f.start()
	f.verify = func(context.Context, wire.EffectRequest, wire.EffectResult, wire.EffectReceipt, effects.Binding) (Verification, error) {
		return Verification{}, fmt.Errorf("verification unavailable")
	}
	if _, err := f.sup.Handle(context.Background(), f.request(1, "fs.read")); err == nil {
		t.Fatal("unverified request accepted")
	}
	if _, err := f.sup.Finish(context.Background(), strings.Repeat("1", 64)); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatalf("uncommitted run finished: %v", err)
	}
}
