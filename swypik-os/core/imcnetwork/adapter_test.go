package imcnetwork

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"swypik-os/core/controlkernel"
	"testing"
	"time"
)

func TestIssuerProgressedResumePreservesGenesis(t *testing.T) {
	dir := t.TempDir()
	genesis := json.RawMessage(`{"synthetic":1}`)
	parent := json.RawMessage(`{"synthetic":2}`)
	genesisHash, err := Checkpoint(dir, genesis)
	if err != nil {
		t.Fatal(err)
	}
	parentHash, err := Checkpoint(dir, parent)
	if err != nil {
		t.Fatal(err)
	}
	want := networkProgress{Session: "session-test", Genesis: genesisHash, Parent: parentHash, Lineage: hash([]byte("lineage")), Sequence: 3}
	if err := save(filepath.Join(dir, "progress.json"), encode(want)); err != nil {
		t.Fatal(err)
	}
	got, current, err := loadIssuerProgress(dir, true, genesis, genesisHash)
	if err != nil {
		t.Fatal(err)
	}
	if got != want || !bytes.Equal(current, parent) {
		t.Fatalf("resume metadata/current parent changed: %+v", got)
	}
	if next := fmt.Sprintf("round-%d", got.Sequence+1); next != "round-4" {
		t.Fatal(next)
	}
	if err := persistInitialCheckpoints(dir, genesisHash, genesis, current, got.Parent); err != nil {
		t.Fatal(err)
	}
	stored, err := os.ReadFile(filepath.Join(dir, genesisHash+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, genesis) || hash(stored) != genesisHash {
		t.Fatalf("resumed parent overwrote immutable genesis: %s", stored)
	}
	active, err := os.ReadFile(filepath.Join(dir, "active.json"))
	if err != nil || string(active) != parentHash {
		t.Fatalf("active parent: %s, %v", active, err)
	}
	if _, _, err := loadIssuerProgress(dir, true, genesis, genesisHash); err != nil {
		t.Fatal(err)
	}
}

func TestIssuerFreshInitializationPersistsGenesis(t *testing.T) {
	dir := t.TempDir()
	genesis := json.RawMessage(`{"synthetic":1}`)
	id := hash(genesis)
	progress, parent, err := loadIssuerProgress(dir, false, genesis, id)
	if err != nil {
		t.Fatal(err)
	}
	if progress.Genesis != id || progress.Parent != id || progress.Lineage != id || progress.Sequence != 0 {
		t.Fatal(progress)
	}
	if err := persistInitialCheckpoints(dir, id, genesis, parent, progress.Parent); err != nil {
		t.Fatal(err)
	}
	stored, err := os.ReadFile(filepath.Join(dir, id+".json"))
	if err != nil || !bytes.Equal(stored, genesis) {
		t.Fatalf("fresh genesis: %s, %v", stored, err)
	}
}

func TestIssuerInitializationRejectsExistingGenesisMismatch(t *testing.T) {
	dir := t.TempDir()
	genesis := json.RawMessage(`{"synthetic":1}`)
	id := hash(genesis)
	tampered := []byte(`{"synthetic":999}`)
	if err := save(filepath.Join(dir, id+".json"), tampered); err != nil {
		t.Fatal(err)
	}
	if err := save(filepath.Join(dir, "active.json"), []byte("prior-active")); err != nil {
		t.Fatal(err)
	}
	if err := persistInitialCheckpoints(dir, id, genesis, genesis, id); err == nil {
		t.Fatal("mismatched immutable genesis accepted")
	}
	stored, err := os.ReadFile(filepath.Join(dir, id+".json"))
	if err != nil || !bytes.Equal(stored, tampered) {
		t.Fatal("mismatched genesis overwritten")
	}
	active, err := os.ReadFile(filepath.Join(dir, "active.json"))
	if err != nil || string(active) != "prior-active" {
		t.Fatal("active changed on rejected genesis")
	}
}

func TestIssuerResumeRejectsTamperedCurrentParent(t *testing.T) {
	dir := t.TempDir()
	genesis := json.RawMessage(`{"synthetic":1}`)
	parent := json.RawMessage(`{"synthetic":2}`)
	genesisHash, parentHash := hash(genesis), hash(parent)
	if err := save(filepath.Join(dir, "progress.json"), encode(networkProgress{Genesis: genesisHash, Parent: parentHash, Sequence: 3})); err != nil {
		t.Fatal(err)
	}
	if err := save(filepath.Join(dir, parentHash+".json"), genesis); err != nil {
		t.Fatal(err)
	}
	if _, _, err := loadIssuerProgress(dir, true, genesis, genesisHash); err == nil {
		t.Fatal("tampered current parent accepted")
	}
}

func TestMissingAuthenticatedSessionFailsClosed(t *testing.T) {
	if _, e := (SocketRelay{}).Exchange(context.Background(), nil); e == nil {
		t.Fatal("missing session accepted")
	}
}
func TestReviewF2MaximumRoundReservations(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 9; i++ {
		job := fmt.Sprintf(`{"session_id":"public-session","round_id":"r%d","nonce":"n%d"}`, i, i)
		if e := reserveWork(dir, job); e != nil {
			t.Fatalf("F2 eight rounds plus final reject failed at job%d: %v", i, e)
		}
	}
}
func TestReviewF3CheckpointTamperValidReceiptDenied(t *testing.T) {
	dir := t.TempDir()
	id, e := Checkpoint(dir, map[string]any{"public": true})
	if e != nil {
		t.Fatal(e)
	}
	active := filepath.Join(dir, "active.json")
	_ = AtomicFile(active, []byte(id))
	// Receipt is already independently authenticated by caller; only unsigned
	// checkpoint bytes are altered, advertised/signature fields unchanged.
	receipt := map[string]any{"candidate_checkpoint_hash": id}
	evaluation := map[string]json.RawMessage{"checkpoint_hash": encode(id), "checkpoint": json.RawMessage(`{"tampered":true}`)}
	if validateCheckpointReceipt(evaluation, receipt) == nil {
		t.Fatal("F3 valid receipt accepted mismatching published checkpoint bytes")
	}
	after, _ := os.ReadFile(active)
	if string(after) != id {
		t.Fatal("denial mutated active")
	}
}

func TestNetworkActualCrashBeforeAfterPublication(t *testing.T) {
	if os.Getenv("IMC_NETWORK_CRASH_HELPER") == "1" {
		dir := os.Getenv("IMC_NETWORK_CRASH_DIRECTORY")
		base, _ := Checkpoint(dir, map[string]any{"synthetic_base": true})
		candidate, _ := Checkpoint(dir, map[string]any{"synthetic_candidate": true})
		_ = AtomicFile(filepath.Join(dir, "active.json"), []byte(base))
		_ = AtomicFile(filepath.Join(dir, "pending.json"), encode(map[string]string{"base": base, "candidate": candidate, "intent_key": "uncertain"}))
		if os.Getenv("IMC_NETWORK_CRASH_PHASE") == "after" {
			_ = AtomicFile(filepath.Join(dir, "active.json"), []byte(candidate))
		}
		os.Exit(23)
	}
	for _, phase := range []string{"before", "after"} {
		dir := t.TempDir()
		cmd := exec.Command(os.Args[0], "-test.run=^TestNetworkActualCrashBeforeAfterPublication$")
		cmd.Env = append(os.Environ(), "IMC_NETWORK_CRASH_HELPER=1", "IMC_NETWORK_CRASH_DIRECTORY="+dir, "IMC_NETWORK_CRASH_PHASE="+phase)
		e := cmd.Run()
		var exit *exec.ExitError
		if !errors.As(e, &exit) || exit.ExitCode() != 23 {
			t.Fatalf("actual crash %v", e)
		}
		k, e := controlkernel.OpenKernel(filepath.Join(dir, "journal"))
		if e != nil {
			t.Fatal(e)
		}
		if e = ReconcileNetworkPublication(dir, k); e != nil {
			t.Fatal(e)
		}
		k.Close()
		base, e := Checkpoint(dir, map[string]any{"synthetic_base": true})
		got, _ := os.ReadFile(filepath.Join(dir, "active.json"))
		if e != nil || string(got) != base {
			t.Fatal("crash did not restore parent")
		}
	}
}
func TestDurableWorkerReplayAndConsent(t *testing.T) {
	dir := t.TempDir()
	job := `{"session_id":"public-session","round_id":"r1","nonce":"fresh"}`
	if e := reserveWork(dir, job); e != nil {
		t.Fatal(e)
	}
	if reserveWork(dir, job) == nil {
		t.Fatal("worker replay accepted after reopen")
	}
	if e := AtomicFile(filepath.Join(dir, "consent.json"), []byte(`{"opt_in":true,"epoch":1,"scope":"synthetic-public-v1","purpose":"local-network-training"}`)); e != nil {
		t.Fatal(e)
	}
	if e := consent(dir); e != nil {
		t.Fatal(e)
	}
	if e := AtomicFile(filepath.Join(dir, "consent.json"), []byte(`{"opt_in":false,"epoch":2,"scope":"synthetic-public-v1","purpose":"local-network-training"}`)); e != nil {
		t.Fatal(e)
	}
	if consent(dir) == nil {
		t.Fatal("live revoke ignored")
	}
}

func TestUncertainPublicationReconcilesWithoutReapply(t *testing.T) {
	dir := t.TempDir()
	base, e := Checkpoint(dir, map[string]any{"public_base": true})
	if e != nil {
		t.Fatal(e)
	}
	candidate, e := Checkpoint(dir, map[string]any{"public_candidate": true})
	if e != nil {
		t.Fatal(e)
	}
	kernel, e := controlkernel.OpenKernel(filepath.Join(dir, "authority.journal"))
	if e != nil {
		t.Fatal(e)
	}
	defer kernel.Close()
	for _, phase := range []string{"before-publication", "after-publication"} {
		active := base
		if phase == "after-publication" {
			active = candidate
		}
		if e = AtomicFile(filepath.Join(dir, "active.json"), []byte(active)); e != nil {
			t.Fatal(e)
		}
		if e = AtomicFile(filepath.Join(dir, "pending.json"), encode(map[string]string{"base": base, "candidate": candidate, "intent_key": "uncommitted"})); e != nil {
			t.Fatal(e)
		}
		if e = ReconcileNetworkPublication(dir, kernel); e != nil {
			t.Fatal(e)
		}
		got, e := os.ReadFile(filepath.Join(dir, "active.json"))
		if e != nil || string(got) != base {
			t.Fatal("uncertain publication not rolled back", phase)
		}
	}
}

type publicationTestAuth map[string]string

func (a publicationTestAuth) AuthenticateExecutor(credential string) (controlkernel.ExecutorPrincipal, error) {
	id, ok := a[credential]
	if !ok {
		return controlkernel.ExecutorPrincipal{}, errors.New("unknown test executor credential")
	}
	return controlkernel.ExecutorPrincipal{ID: id}, nil
}

func (a publicationTestAuth) AuthenticateVerifier(credential string) (controlkernel.VerifierPrincipal, error) {
	id, ok := a[credential]
	if !ok {
		return controlkernel.VerifierPrincipal{}, errors.New("unknown test verifier credential")
	}
	return controlkernel.VerifierPrincipal{ID: id}, nil
}

// The fixture uses the actual durable authority API, including independent
// verification. Reopening makes recovery consume journal evidence from disk.
func publicationTestKernel(t *testing.T, dir, key, request, external string, committed bool) *controlkernel.Kernel {
	t.Helper()
	auth := publicationTestAuth{"issuer-test": "issuer", "evaluator-test": "independent-evaluator"}
	options := []controlkernel.Option{controlkernel.WithExecutorAuthenticator(auth), controlkernel.WithVerifierAuthenticator(auth)}
	path := filepath.Join(dir, "publication.journal")
	k, err := controlkernel.OpenKernel(path, options...)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = k.CreateTask(controlkernel.Task{ID: "task", Goal: "synthetic local publication recovery"}); err != nil {
		t.Fatal(err)
	}
	if _, err = k.AddNode(controlkernel.Node{ID: "round-2", TaskID: "task", Kind: "network-publication"}); err != nil {
		t.Fatal(err)
	}
	if err = k.TransitionNode("round-2", controlkernel.NodeReady, controlkernel.LeaseToken{}); err != nil {
		t.Fatal(err)
	}
	lease, err := k.ClaimLease("round-2", "issuer-test", "issuer", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	token := controlkernel.LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	if err = k.TransitionNode("round-2", controlkernel.NodePreparing, token); err != nil {
		t.Fatal(err)
	}
	intent, _, err := k.PrepareIntent(controlkernel.Intent{TaskID: "task", NodeID: "round-2", Kind: "synthetic-model-publication", IdempotencyKey: key, RequestHash: request}, token)
	if err != nil {
		t.Fatal(err)
	}
	if err = k.TransitionNode("round-2", controlkernel.NodeExecuting, token); err != nil {
		t.Fatal(err)
	}
	if _, err = k.StartIntent(intent.ID, token); err != nil {
		t.Fatal(err)
	}
	if _, err = k.RecordIntentResult(intent.ID, token, external, hash([]byte("authenticated-test-receipt"))); err != nil {
		t.Fatal(err)
	}
	if committed {
		if err = k.TransitionNode("round-2", controlkernel.NodeVerifying, token); err != nil {
			t.Fatal(err)
		}
		if _, err = k.RecordVerification("evaluator-test", controlkernel.VerificationRequest{NodeID: "round-2", Decision: controlkernel.VerificationPassed, EvidenceHash: hash([]byte("authenticated-test-receipt")), ExpectedVerifierID: "independent-evaluator"}); err != nil {
			t.Fatal(err)
		}
		if err = k.TransitionNode("round-2", controlkernel.NodeCommitting, token); err != nil {
			t.Fatal(err)
		}
		if _, err = k.CommitIntent(intent.ID, token); err != nil {
			t.Fatal(err)
		}
	}
	if err = k.Close(); err != nil {
		t.Fatal(err)
	}
	k, err = controlkernel.OpenKernel(path, options...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = k.Close() })
	intent, ok := k.IntentByKey(key)
	if !ok || (committed && intent.State != controlkernel.IntentCommitted) {
		t.Fatalf("reopened journal lacks fixture evidence: %+v", intent)
	}
	return k
}

func publicationTestStates(t *testing.T, dir string) (networkProgress, networkProgress) {
	t.Helper()
	genesis, err := Checkpoint(dir, map[string]any{"synthetic": "genesis"})
	if err != nil {
		t.Fatal(err)
	}
	base, err := Checkpoint(dir, map[string]any{"synthetic": "round-1"})
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := Checkpoint(dir, map[string]any{"synthetic": "round-2"})
	if err != nil {
		t.Fatal(err)
	}
	before := networkProgress{Session: "public-test-session", Genesis: genesis, Parent: base, Lineage: hash([]byte("round-1-lineage")), Sequence: 1}
	after := before
	after.Parent, after.Sequence = candidate, 2
	after.Lineage = hash([]byte(before.Lineage + candidate))
	return before, after
}

func publicationTestPending(t *testing.T, dir string, before, after networkProgress, key string) {
	t.Helper()
	// Structural JSON avoids tying the regression to a production Go type.
	pending := struct {
		Before    networkProgress `json:"before"`
		After     networkProgress `json:"after"`
		IntentKey string          `json:"intent_key"`
	}{before, after, key}
	if err := AtomicFile(filepath.Join(dir, "pending.json"), encode(pending)); err != nil {
		t.Fatal(err)
	}
}

func publicationTestReadProgress(t *testing.T, dir string) networkProgress {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "progress.json"))
	if err != nil {
		t.Fatal(err)
	}
	var progress networkProgress
	if err = json.Unmarshal(data, &progress); err != nil {
		t.Fatal(err)
	}
	return progress
}

func TestTypedCommittedPublicationRecoversPointerAndLinkedProgress(t *testing.T) {
	for _, phase := range []string{"before-pointer", "after-pointer"} {
		t.Run(phase, func(t *testing.T) {
			dir := t.TempDir()
			before, after := publicationTestStates(t, dir)
			key := after.Session + "round-2"
			k := publicationTestKernel(t, dir, key, before.Parent, after.Parent, true)
			active := before.Parent
			if phase == "after-pointer" {
				active = after.Parent
			}
			if err := AtomicFile(filepath.Join(dir, "active.json"), []byte(active)); err != nil {
				t.Fatal(err)
			}
			if err := AtomicFile(filepath.Join(dir, "progress.json"), encode(before)); err != nil {
				t.Fatal(err)
			}
			publicationTestPending(t, dir, before, after, key)
			if err := ReconcileNetworkPublication(dir, k); err != nil {
				t.Fatal(err)
			}
			pointer, err := os.ReadFile(filepath.Join(dir, "active.json"))
			if err != nil || string(pointer) != after.Parent || publicationTestReadProgress(t, dir) != after {
				t.Fatal("committed recovery did not repair parent, lineage and sequence together")
			}
			if _, err = os.Stat(filepath.Join(dir, "pending.json")); !os.IsNotExist(err) {
				t.Fatalf("completed publication retained pending record: %v", err)
			}
			if err = ReconcileNetworkPublication(dir, k); err != nil {
				t.Fatal("completed recovery was not idempotent", err)
			}
		})
	}
}

func TestTypedUncommittedPublicationRestoresProgressAndPreservesAmbiguity(t *testing.T) {
	dir := t.TempDir()
	before, after := publicationTestStates(t, dir)
	key := after.Session + "round-2"
	k := publicationTestKernel(t, dir, key, before.Parent, after.Parent, false)
	if err := AtomicFile(filepath.Join(dir, "active.json"), []byte(after.Parent)); err != nil {
		t.Fatal(err)
	}
	if err := AtomicFile(filepath.Join(dir, "progress.json"), encode(after)); err != nil {
		t.Fatal(err)
	}
	publicationTestPending(t, dir, before, after, key)
	if err := ReconcileNetworkPublication(dir, k); err == nil {
		t.Fatal("uncertain publication reported successful completion")
	}
	pointer, err := os.ReadFile(filepath.Join(dir, "active.json"))
	if err != nil || string(pointer) != before.Parent || publicationTestReadProgress(t, dir) != before {
		t.Fatal("uncertain publication did not restore previous linked progress")
	}
	if _, err = os.Stat(filepath.Join(dir, "pending.json")); err != nil {
		t.Fatal("unresolved authority evidence was discarded", err)
	}
}

func TestTypedCommittedPublicationRejectsJournalBindingMismatch(t *testing.T) {
	for _, mismatch := range []string{"request", "external"} {
		t.Run(mismatch, func(t *testing.T) {
			dir := t.TempDir()
			before, after := publicationTestStates(t, dir)
			request, external := before.Parent, after.Parent
			if mismatch == "request" {
				request = before.Genesis
			} else {
				external = before.Genesis
			}
			key := after.Session + "round-2"
			k := publicationTestKernel(t, dir, key, request, external, true)
			if err := AtomicFile(filepath.Join(dir, "active.json"), []byte(before.Parent)); err != nil {
				t.Fatal(err)
			}
			if err := AtomicFile(filepath.Join(dir, "progress.json"), encode(before)); err != nil {
				t.Fatal(err)
			}
			publicationTestPending(t, dir, before, after, key)
			if err := ReconcileNetworkPublication(dir, k); err == nil {
				t.Fatal("unrelated committed intent authorized pending publication")
			}
			pointer, err := os.ReadFile(filepath.Join(dir, "active.json"))
			if err != nil || string(pointer) != before.Parent || publicationTestReadProgress(t, dir) != before {
				t.Fatal("journal binding mismatch changed publication")
			}
			if _, err = os.Stat(filepath.Join(dir, "pending.json")); err != nil {
				t.Fatal("journal binding mismatch discarded unresolved record", err)
			}
		})
	}
}

func TestIssuerPersistsLinkedProgressBeforeAcknowledgment(t *testing.T) {
	dir := t.TempDir()
	before, after := publicationTestStates(t, dir)
	if err := AtomicFile(filepath.Join(dir, "progress.json"), encode(before)); err != nil {
		t.Fatal(err)
	}
	called := false
	err := persistAndAckIssuerProgress(dir, after, func(payload []byte) error {
		called = true
		if durable := publicationTestReadProgress(t, dir); durable != after {
			t.Fatalf("acknowledged round before durable parent/lineage/sequence: %+v", durable)
		}
		var acknowledged networkProgress
		if err := json.Unmarshal(payload, &acknowledged); err != nil || acknowledged != after {
			t.Fatalf("ack does not match durable round-2 progress: %+v, %v", acknowledged, err)
		}
		return nil
	})
	if err != nil || !called {
		t.Fatalf("persist-and-ack failed: called=%v, err=%v", called, err)
	}
}

func TestIssuerFailedAcknowledgmentKeepsDurableLinkedProgress(t *testing.T) {
	dir := t.TempDir()
	_, after := publicationTestStates(t, dir)
	failure := errors.New("synthetic interrupted acknowledgment")
	err := persistAndAckIssuerProgress(dir, after, func([]byte) error { return failure })
	if !errors.Is(err, failure) {
		t.Fatalf("acknowledgment error was hidden: %v", err)
	}
	if durable := publicationTestReadProgress(t, dir); durable != after {
		t.Fatalf("failed acknowledgment lost durable progress: %+v", durable)
	}
}

func TestIssuerFailedProgressPersistenceNeverAcknowledges(t *testing.T) {
	dir := t.TempDir()
	_, after := publicationTestStates(t, dir)
	if err := os.Mkdir(filepath.Join(dir, "progress.json"), 0700); err != nil {
		t.Fatal(err)
	}
	called := false
	err := persistAndAckIssuerProgress(dir, after, func([]byte) error { called = true; return nil })
	if err == nil || called {
		t.Fatalf("failed persistence acknowledged: called=%v, err=%v", called, err)
	}
}

func TestTypedCommittedPublicationRetainsPendingUntilProgressIsDurable(t *testing.T) {
	dir := t.TempDir()
	before, after := publicationTestStates(t, dir)
	key := after.Session + "round-2"
	k := publicationTestKernel(t, dir, key, before.Parent, after.Parent, true)
	if err := AtomicFile(filepath.Join(dir, "active.json"), []byte(before.Parent)); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "progress.json"), 0700); err != nil {
		t.Fatal(err)
	}
	publicationTestPending(t, dir, before, after, key)
	if err := ReconcileNetworkPublication(dir, k); err == nil {
		t.Fatal("publication completed despite progress persistence failure")
	}
	if _, err := os.Stat(filepath.Join(dir, "pending.json")); err != nil {
		t.Fatal("recovery evidence removed before progress was durable", err)
	}
}

func TestLegacyPublicationRejectsUnrelatedCommittedIntent(t *testing.T) {
	for _, mismatch := range []string{"base", "candidate"} {
		t.Run(mismatch, func(t *testing.T) {
			dir := t.TempDir()
			before, after := publicationTestStates(t, dir)
			key := after.Session + "round-2"
			k := publicationTestKernel(t, dir, key, before.Parent, after.Parent, true)
			alternate, err := Checkpoint(dir, map[string]any{"synthetic": "unrelated-immutable-checkpoint"})
			if err != nil {
				t.Fatal(err)
			}
			pending := map[string]string{"base": before.Parent, "candidate": after.Parent, "intent_key": key}
			pending[mismatch] = alternate
			if err = AtomicFile(filepath.Join(dir, "active.json"), []byte(before.Parent)); err != nil {
				t.Fatal(err)
			}
			if err = AtomicFile(filepath.Join(dir, "pending.json"), encode(pending)); err != nil {
				t.Fatal(err)
			}
			if err = ReconcileNetworkPublication(dir, k); err == nil {
				t.Fatal("unrelated committed intent authorized legacy publication")
			}
			pointer, err := os.ReadFile(filepath.Join(dir, "active.json"))
			if err != nil || string(pointer) != before.Parent {
				t.Fatal("unrelated legacy publication changed active parent")
			}
			if _, err = os.Stat(filepath.Join(dir, "pending.json")); err != nil {
				t.Fatal("rejected legacy publication discarded recovery evidence", err)
			}
		})
	}
}
