package imcnetwork

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
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

// These are public synthetic policy fixtures, not model-quality or TCP proof.
// Every ancestor admission below nevertheless uses a real committed kernel journal.
type rollbackTestState struct {
	directory      string
	kernel         *controlkernel.Kernel
	credential     string
	issuer         ed25519.PublicKey
	private        ed25519.PrivateKey
	genesis        json.RawMessage
	before, target networkProgress
	notice         networkRollbackNotice
	intent         controlkernel.Intent
	token          controlkernel.LeaseToken
}

func rollbackTestMust(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func rollbackTestFixture(t *testing.T, directory string) rollbackTestState {
	t.Helper()
	f := rollbackTestState{directory: directory, credential: "rollback-test-executor", genesis: json.RawMessage(`{"synthetic_checkpoint":0}`)}
	var err error
	f.issuer, f.private, err = ed25519.GenerateKey(rand.Reader)
	rollbackTestMust(t, err)
	f.kernel, err = controlkernel.OpenKernel(filepath.Join(directory, "authority.journal"), controlkernel.WithExecutorAuthenticator(nodeAuth(f.credential)), controlkernel.WithVerifierAuthenticator(nodeAuth(f.credential)))
	rollbackTestMust(t, err)
	t.Cleanup(func() { _ = f.kernel.Close() })
	_, err = f.kernel.CreateTask(controlkernel.Task{ID: "public-rollback-fixture", Goal: "synthetic rollback policy verification"})
	rollbackTestMust(t, err)
	for _, sequence := range []uint64{1, 2, 4} {
		_, err = f.kernel.AddNode(controlkernel.Node{ID: sequenceRound(sequence), TaskID: "public-rollback-fixture", Kind: "synthetic-publication-fixture"})
		rollbackTestMust(t, err)
	}
	genesis, err := Checkpoint(directory, f.genesis)
	rollbackTestMust(t, err)
	progress := networkProgress{Session: "public-rollback-session", Genesis: genesis, Parent: genesis, Lineage: genesis}
	rollbackTestMust(t, progressHistory(directory, progress))
	for sequence := uint64(1); sequence <= 2; sequence++ {
		parent, err := Checkpoint(directory, map[string]uint64{"synthetic_checkpoint": sequence})
		rollbackTestMust(t, err)
		before := progress
		progress.Parent = parent
		progress.Lineage = hash([]byte(before.Lineage + parent))
		progress.Sequence = sequence
		round := sequenceRound(sequence)
		rollbackTestMust(t, f.kernel.TransitionNode(round, controlkernel.NodeReady, controlkernel.LeaseToken{}))
		lease, err := f.kernel.ClaimLease(round, f.credential, "synthetic fixture", time.Minute)
		rollbackTestMust(t, err)
		token := controlkernel.LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
		rollbackTestMust(t, f.kernel.TransitionNode(round, controlkernel.NodePreparing, token))
		intent, created, err := f.kernel.PrepareIntent(controlkernel.Intent{NodeID: round, Kind: "synthetic-model-publication", IdempotencyKey: progress.Session + round, RequestHash: before.Parent}, token)
		rollbackTestMust(t, err)
		if !created {
			t.Fatal("fixture intent reused")
		}
		rollbackTestMust(t, f.kernel.TransitionNode(round, controlkernel.NodeExecuting, token))
		_, err = f.kernel.StartIntent(intent.ID, token)
		rollbackTestMust(t, err)
		evidence := hash([]byte("public synthetic verifier evidence " + round))
		_, err = f.kernel.RecordIntentResult(intent.ID, token, parent, evidence)
		rollbackTestMust(t, err)
		rollbackTestMust(t, f.kernel.TransitionNode(round, controlkernel.NodeVerifying, token))
		_, err = f.kernel.RecordVerification("pinned-independent-evaluator", controlkernel.VerificationRequest{NodeID: round, Decision: controlkernel.VerificationPassed, EvidenceHash: evidence, ExpectedVerifierID: "network-evaluator"})
		rollbackTestMust(t, err)
		rollbackTestMust(t, f.kernel.TransitionNode(round, controlkernel.NodeCommitting, token))
		rollbackTestMust(t, save(filepath.Join(directory, "active.json"), []byte(parent)))
		_, err = f.kernel.CommitIntent(intent.ID, token)
		rollbackTestMust(t, err)
		rollbackTestMust(t, f.kernel.TransitionNode(round, controlkernel.NodeSucceeded, token))
		rollbackTestMust(t, progressHistory(directory, progress))
		rollbackTestMust(t, committedProgress(directory, progress))
		if sequence == 1 {
			f.target = progress
		}
	}
	// A rejected round preserves parent and lineage while advancing sequence.
	progress.Sequence = 3
	f.before = progress
	rollbackTestMust(t, progressHistory(directory, progress))
	rollbackTestMust(t, save(filepath.Join(directory, "progress.json"), encode(progress)))
	rollbackTestMust(t, save(filepath.Join(directory, "consent.json"), []byte(`{"opt_in":true,"epoch":1,"scope":"synthetic-public-v1","purpose":"local-network-training"}`)))
	round := sequenceRound(4)
	rollbackTestMust(t, f.kernel.TransitionNode(round, controlkernel.NodeReady, controlkernel.LeaseToken{}))
	lease, err := f.kernel.ClaimLease(round, f.credential, "public fixture rollback", time.Minute)
	rollbackTestMust(t, err)
	f.token = controlkernel.LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	rollbackTestMust(t, f.kernel.TransitionNode(round, controlkernel.NodePreparing, f.token))
	c := networkRollbackCertificate{ProtocolVersion: 1, Operation: "rollback", Before: f.before, Target: f.target, TargetIntentKey: progress.Session + sequenceRound(1), RollbackIntentKey: progress.Session + round, Nonce: hash([]byte("public rollback nonce")), ConsentEpoch: 1, LeaseFence: f.token.Fence, DeadlineUnixMS: lease.ExpiresAt.UnixMilli()}
	c.After = networkProgress{Session: c.Before.Session, Genesis: c.Before.Genesis, Parent: c.Target.Parent, Sequence: 4}
	c.After.Lineage = rollbackLineage(c.Before, c.Target, c.TargetIntentKey, c.After.Sequence)
	f.notice = networkRollbackNotice{Certificate: c, Signature: hex.EncodeToString(ed25519.Sign(f.private, encode(c)))}
	f.intent, _, err = f.kernel.PrepareIntent(controlkernel.Intent{NodeID: round, Kind: "synthetic-model-rollback", IdempotencyKey: c.RollbackIntentKey, RequestHash: hash(encode(c))}, f.token)
	rollbackTestMust(t, err)
	rollbackTestMust(t, f.kernel.TransitionNode(round, controlkernel.NodeExecuting, f.token))
	return f
}

func rollbackTestPeer(t *testing.T, f rollbackTestState) string {
	t.Helper()
	directory := t.TempDir()
	rollbackTestMust(t, progressHistory(directory, f.target))
	rollbackTestMust(t, progressHistory(directory, f.before))
	rollbackTestMust(t, save(filepath.Join(directory, "progress.json"), encode(f.before)))
	rollbackTestMust(t, save(filepath.Join(directory, "consent.json"), []byte(`{"opt_in":true,"epoch":1,"scope":"synthetic-public-v1","purpose":"local-network-training"}`)))
	return directory
}

func TestRollbackDurableJournalAndIndependentRestart(t *testing.T) {
	f := rollbackTestFixture(t, t.TempDir())
	rollbackTestMust(t, publishRollback(context.Background(), f.directory, f.kernel, f.credential, f.token, f.intent, f.notice, f.issuer))
	rollbackTestMust(t, f.kernel.Close())
	kernel, err := controlkernel.OpenKernel(filepath.Join(f.directory, "authority.journal"))
	rollbackTestMust(t, err)
	defer kernel.Close()
	progress, parent, err := loadIssuerProgress(f.directory, true, f.genesis, f.before.Genesis)
	rollbackTestMust(t, err)
	if progress != f.notice.Certificate.After || hash(canonicalJSON(parent)) != f.target.Parent || progress.Sequence+1 != 5 {
		t.Fatal("restart did not select committed rollback parent at monotonic sequence4")
	}
	notice, err := committedRollback(f.directory, progress, kernel, f.issuer)
	rollbackTestMust(t, err)
	if notice == nil || !bytes.Equal(encode(*notice), encode(f.notice)) {
		t.Fatal("fresh journal could not authorize the stored rollback certificate")
	}
	peer := rollbackTestPeer(t, f)
	peerProgress, err := admitPeerRollback(peer, f.before, *notice, f.issuer, true, 8)
	rollbackTestMust(t, err)
	if peerProgress != progress {
		t.Fatal("lost notification did not reconcile exact peer progress")
	}
	// Lost peer ACK after its durable publication is an idempotent metadata repair.
	_, err = admitPeerRollback(peer, peerProgress, *notice, f.issuer, true, 8)
	rollbackTestMust(t, err)
	if _, err = admitPeerRollback(peer, peerProgress, *notice, f.issuer, false, 8); err == nil {
		t.Fatal("ordinary rollback replay admitted")
	}
	_, err = kernel.CreateTask(controlkernel.Task{ID: "public-rollback-fixture", Goal: "replayed old batch"})
	if err == nil {
		t.Fatal("independent journal reopened a previously consumed batch")
	}
}

func TestRollbackCannotUseOrdinaryResumeLineage(t *testing.T) {
	f := rollbackTestFixture(t, t.TempDir())
	defer f.kernel.Close()
	peer := rollbackTestPeer(t, f)
	rollbackTestMust(t, immutableBytes(peer, "used-"+hash([]byte(f.before.Session+sequenceRound(4))), []byte("reserved")))
	if err := acceptResumeProgress(peer, f.before, f.notice.Certificate.After); err == nil {
		t.Fatal("ordinary resume silently admitted a distinct rollback operation")
	}
	raw, err := os.ReadFile(filepath.Join(peer, "progress.json"))
	rollbackTestMust(t, err)
	if !bytes.Equal(raw, encode(f.before)) {
		t.Fatal("rejected ordinary resume changed peer progress")
	}
}

func TestRollbackRoleLineageAncestorAndFreshnessGuards(t *testing.T) {
	f := rollbackTestFixture(t, t.TempDir())
	defer f.kernel.Close()
	for _, fault := range []string{"transport-key", "sequence-jump", "lineage", "genesis", "unknown-ancestor", "uncommitted-target", "expired", "epoch", "overflow", "nonce"} {
		t.Run(fault, func(t *testing.T) {
			notice := f.notice
			c := &notice.Certificate
			signingKey := f.private
			switch fault {
			case "transport-key":
				_, signingKey, _ = ed25519.GenerateKey(rand.Reader)
			case "sequence-jump":
				c.After.Sequence++
			case "lineage":
				c.After.Lineage = c.Before.Lineage
			case "genesis":
				c.After.Genesis = hash([]byte("other public genesis"))
			case "unknown-ancestor":
				c.Target.Parent = hash([]byte("unknown public checkpoint"))
				c.After.Parent = c.Target.Parent
				c.After.Lineage = rollbackLineage(c.Before, c.Target, c.TargetIntentKey, c.After.Sequence)
			case "uncommitted-target":
				c.Target.Sequence = 2
				c.TargetIntentKey = c.Before.Session + sequenceRound(2)
			case "expired":
				c.DeadlineUnixMS = time.Now().Add(-time.Second).UnixMilli()
			case "epoch":
				c.ConsentEpoch++
			case "overflow":
				c.Before.Sequence = ^uint64(0)
				c.After.Sequence = 0
			case "nonce":
				c.Nonce = "short"
			}
			notice.Signature = hex.EncodeToString(ed25519.Sign(signingKey, encode(*c)))
			peer := rollbackTestPeer(t, f)
			if _, err := admitPeerRollback(peer, f.before, notice, f.issuer, false, 8); err == nil {
				t.Fatal("changed rollback authority/state admitted")
			}
			raw, err := os.ReadFile(filepath.Join(peer, "progress.json"))
			rollbackTestMust(t, err)
			if !bytes.Equal(raw, encode(f.before)) {
				t.Fatal("refused rollback changed progress")
			}
		})
	}
}

func TestRollbackPublicationRequiresConsentAndExactIntent(t *testing.T) {
	for _, fault := range []string{"revoked", "intent-result-binding", "unknown-committed-ancestor"} {
		t.Run(fault, func(t *testing.T) {
			f := rollbackTestFixture(t, t.TempDir())
			defer f.kernel.Close()
			intent := f.intent
			switch fault {
			case "revoked":
				rollbackTestMust(t, save(filepath.Join(f.directory, "consent.json"), []byte(`{"opt_in":false,"epoch":2}`)))
			case "intent-result-binding":
				intent.RequestHash = hash([]byte("unrelated rollback request"))
			case "unknown-committed-ancestor":
				rollbackTestMust(t, save(filepath.Join(f.directory, fmt.Sprintf("history-%d.json", f.target.Sequence)), encode(f.before)))
			}
			if err := publishRollback(context.Background(), f.directory, f.kernel, f.credential, f.token, intent, f.notice, f.issuer); err == nil {
				t.Fatal("unapproved rollback publication admitted")
			}
			active, err := os.ReadFile(filepath.Join(f.directory, "active.json"))
			rollbackTestMust(t, err)
			if string(active) != f.before.Parent {
				t.Fatal("refused rollback changed active parent")
			}
		})
	}
}

func TestRollbackActualProcessCrashCommittedAndUncertain(t *testing.T) {
	if os.Getenv("IMC_ROLLBACK_CRASH_HELPER") == "1" {
		f := rollbackTestFixture(t, os.Getenv("IMC_ROLLBACK_CRASH_DIRECTORY"))
		c := f.notice.Certificate
		rollbackTestMust(t, save(filepath.Join(f.directory, "test-public.json"), encode(hex.EncodeToString(f.issuer))))
		rollbackTestMust(t, rollbackMetadata(f.directory, f.notice))
		rollbackTestMust(t, save(filepath.Join(f.directory, "pending.json"), encode(networkPublication{Before: c.Before, After: c.After, IntentKey: c.RollbackIntentKey, Kind: "synthetic-model-rollback", Rollback: &f.notice})))
		_, err := f.kernel.StartIntent(f.intent.ID, f.token)
		rollbackTestMust(t, err)
		evidence := hash(encode(f.notice))
		_, err = f.kernel.RecordIntentResult(f.intent.ID, f.token, c.After.Parent, evidence)
		rollbackTestMust(t, err)
		rollbackTestMust(t, f.kernel.TransitionNode(f.intent.NodeID, controlkernel.NodeVerifying, f.token))
		_, err = f.kernel.RecordVerification("pinned-independent-evaluator", controlkernel.VerificationRequest{NodeID: f.intent.NodeID, Decision: controlkernel.VerificationPassed, EvidenceHash: evidence, ExpectedVerifierID: "network-evaluator"})
		rollbackTestMust(t, err)
		rollbackTestMust(t, f.kernel.TransitionNode(f.intent.NodeID, controlkernel.NodeCommitting, f.token))
		rollbackTestMust(t, save(filepath.Join(f.directory, "active.json"), []byte(c.After.Parent)))
		if os.Getenv("IMC_ROLLBACK_CRASH_PHASE") == "committed" {
			_, err = f.kernel.CommitIntent(f.intent.ID, f.token)
			rollbackTestMust(t, err)
		}
		// Exit between pointer publication/journal commit and durable progress/ACK.
		os.Exit(23)
	}
	for _, phase := range []string{"uncertain", "committed"} {
		t.Run(phase, func(t *testing.T) {
			directory := t.TempDir()
			cmd := exec.Command(os.Args[0], "-test.run=^TestRollbackActualProcessCrashCommittedAndUncertain$")
			cmd.Env = append(os.Environ(), "IMC_ROLLBACK_CRASH_HELPER=1", "IMC_ROLLBACK_CRASH_DIRECTORY="+directory, "IMC_ROLLBACK_CRASH_PHASE="+phase)
			err := cmd.Run()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 23 {
				t.Fatalf("expected real crash23: %v", err)
			}
			publicRaw, err := os.ReadFile(filepath.Join(directory, "test-public.json"))
			rollbackTestMust(t, err)
			var publicHex string
			rollbackTestMust(t, json.Unmarshal(publicRaw, &publicHex))
			public, err := hex.DecodeString(publicHex)
			rollbackTestMust(t, err)
			raw, err := os.ReadFile(filepath.Join(directory, "rollback-4.json"))
			rollbackTestMust(t, err)
			var notice networkRollbackNotice
			rollbackTestMust(t, decodeContract(raw, &notice))
			kernel, err := controlkernel.OpenKernel(filepath.Join(directory, "authority.journal"))
			rollbackTestMust(t, err)
			defer kernel.Close()
			err = ReconcileNetworkPublication(directory, kernel, public)
			want := notice.Certificate.Before
			if phase == "committed" {
				rollbackTestMust(t, err)
				want = notice.Certificate.After
			} else if err == nil {
				t.Fatal("uncommitted rollback outcome was silently promoted")
			}
			progressRaw, readErr := os.ReadFile(filepath.Join(directory, "progress.json"))
			rollbackTestMust(t, readErr)
			active, readErr := os.ReadFile(filepath.Join(directory, "active.json"))
			rollbackTestMust(t, readErr)
			if !bytes.Equal(progressRaw, encode(want)) || string(active) != want.Parent {
				t.Fatal("crash recovery selected inconsistent parent/sequence/lineage")
			}
			_, pendingErr := os.Stat(filepath.Join(directory, "pending.json"))
			if phase == "uncertain" && pendingErr != nil {
				t.Fatal("unresolved rollback evidence disappeared")
			}
			if phase == "committed" && !os.IsNotExist(pendingErr) {
				t.Fatal("committed rollback recovery retained stale pending")
			}
			if phase == "committed" {
				restored, err := committedRollback(directory, want, kernel, public)
				rollbackTestMust(t, err)
				if restored == nil {
					t.Fatal("committed crash lost restart certificate")
				}
			}
		})
	}
}

func TestRollbackReservationAndCommandBound(t *testing.T) {
	bounds, err := CheckedRoundBounds(8, true)
	rollbackTestMust(t, err)
	if bounds.Jobs != 9 || bounds.Reservations != 20 || bounds.WorkerCommands != 12 {
		t.Fatalf("rollback exceeded or omitted explicit work bound: %+v", bounds)
	}
}

func TestRollbackPeerPartialReservationRepairsOnlyExactCertificate(t *testing.T) {
	f := rollbackTestFixture(t, t.TempDir())
	defer f.kernel.Close()
	for _, stored := range []bool{false, true} {
		peer := rollbackTestPeer(t, f)
		if stored {
			rollbackTestMust(t, rollbackMetadata(peer, f.notice))
		}
		rollbackTestMust(t, immutableBytes(peer, "used-"+hash([]byte(f.before.Session+sequenceRound(4))), []byte("reserved")))
		progress, err := admitPeerRollback(peer, f.before, f.notice, f.issuer, true, 8)
		if !stored {
			if err == nil {
				t.Fatal("training/unknown round reservation was reinterpreted as rollback")
			}
			continue
		}
		rollbackTestMust(t, err)
		if progress != f.notice.Certificate.After {
			t.Fatal("partial metadata reservation did not finish exact rollback")
		}
		nonceMarker, err := os.ReadFile(filepath.Join(peer, "used-"+hash([]byte(f.before.Session+f.notice.Certificate.Nonce))))
		rollbackTestMust(t, err)
		if string(nonceMarker) != "reserved" {
			t.Fatal("partial rollback did not durably reserve its nonce")
		}
	}
}

func TestRollbackValidCheckpointAndHistoryDoNotReplaceCommittedAuthority(t *testing.T) {
	f := rollbackTestFixture(t, t.TempDir())
	defer f.kernel.Close()
	uncommitted, err := Checkpoint(f.directory, map[string]bool{"synthetic_uncommitted_checkpoint": true})
	rollbackTestMust(t, err)
	notice := f.notice
	notice.Certificate.Target.Parent = uncommitted
	notice.Certificate.After.Parent = uncommitted
	notice.Certificate.After.Lineage = rollbackLineage(notice.Certificate.Before, notice.Certificate.Target, notice.Certificate.TargetIntentKey, notice.Certificate.After.Sequence)
	notice.Signature = hex.EncodeToString(ed25519.Sign(f.private, encode(notice.Certificate)))
	// Deliberately corrupted local metadata cannot grant journal authority.
	rollbackTestMust(t, save(filepath.Join(f.directory, "history-1.json"), encode(notice.Certificate.Target)))
	rollbackTestMust(t, validateRollbackNotice(notice, f.issuer, time.Now(), true))
	if err := validateRollbackAncestor(f.directory, notice, f.kernel); err == nil || err.Error() != "rollback target lacks committed publication authority" {
		t.Fatalf("uncommitted immutable checkpoint authorized rollback: %v", err)
	}
}

func TestRollbackBothPeersMustAgreeBoundedMode(t *testing.T) {
	config := NodeConfig{Rounds: 2, Resume: false, RollbackAtEnd: true}
	mode := networkPilotMode{ProtocolVersion: 1, Operation: "pilot-mode", Rounds: 2, Resume: false, RollbackAtEnd: true}
	rollbackTestMust(t, validatePilotMode(config, mode))
	for _, fault := range []string{"rollback", "resume", "rounds", "version", "operation"} {
		changed := mode
		switch fault {
		case "rollback":
			changed.RollbackAtEnd = false
		case "resume":
			changed.Resume = true
		case "rounds":
			changed.Rounds++
		case "version":
			changed.ProtocolVersion++
		case "operation":
			changed.Operation = "ordinary-job"
		}
		if err := validatePilotMode(config, changed); err == nil {
			t.Fatalf("mismatched %s pilot mode admitted", fault)
		}
	}
}

func TestRollbackRepeatedCheckpointKeepsDistinctCommittedVersions(t *testing.T) {
	f := rollbackTestFixture(t, t.TempDir())
	rollbackTestMust(t, publishRollback(context.Background(), f.directory, f.kernel, f.credential, f.token, f.intent, f.notice, f.issuer))
	original, err := readProgressHistory(f.directory, 2)
	rollbackTestMust(t, err)
	checkpoint, err := os.ReadFile(filepath.Join(f.directory, original.Parent+".json"))
	rollbackTestMust(t, err)
	repeated, err := Checkpoint(f.directory, json.RawMessage(checkpoint))
	rollbackTestMust(t, err)
	if repeated != original.Parent {
		t.Fatal("regression did not reproduce the exact original checkpoint bytes")
	}
	before := f.notice.Certificate.After
	after := networkProgress{Session: before.Session, Genesis: before.Genesis, Parent: repeated, Lineage: hash([]byte(before.Lineage + repeated)), Sequence: 5}
	_, err = f.kernel.CreateTask(controlkernel.Task{ID: "public-resumed-batch", Goal: "commit identical public checkpoint as a distinct resumed event"})
	rollbackTestMust(t, err)
	round := sequenceRound(after.Sequence)
	_, err = f.kernel.AddNode(controlkernel.Node{ID: round, TaskID: "public-resumed-batch", Kind: "synthetic-publication-fixture"})
	rollbackTestMust(t, err)
	rollbackTestMust(t, f.kernel.TransitionNode(round, controlkernel.NodeReady, controlkernel.LeaseToken{}))
	lease, err := f.kernel.ClaimLease(round, f.credential, "public repeated checkpoint", time.Minute)
	rollbackTestMust(t, err)
	token := controlkernel.LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	rollbackTestMust(t, f.kernel.TransitionNode(round, controlkernel.NodePreparing, token))
	intent, created, err := f.kernel.PrepareIntent(controlkernel.Intent{NodeID: round, Kind: "synthetic-model-publication", IdempotencyKey: after.Session + round, RequestHash: before.Parent}, token)
	rollbackTestMust(t, err)
	if !created {
		t.Fatal("resumed event reused an old intent")
	}
	rollbackTestMust(t, f.kernel.TransitionNode(round, controlkernel.NodeExecuting, token))
	_, err = f.kernel.StartIntent(intent.ID, token)
	rollbackTestMust(t, err)
	rollbackTestMust(t, save(filepath.Join(f.directory, "pending.json"), encode(networkPublication{Before: before, After: after, IntentKey: after.Session + round})))
	evidence := hash([]byte("independent public repeated-checkpoint evidence"))
	_, err = f.kernel.RecordIntentResult(intent.ID, token, repeated, evidence)
	rollbackTestMust(t, err)
	rollbackTestMust(t, f.kernel.TransitionNode(round, controlkernel.NodeVerifying, token))
	_, err = f.kernel.RecordVerification("pinned-independent-evaluator", controlkernel.VerificationRequest{NodeID: round, Decision: controlkernel.VerificationPassed, EvidenceHash: evidence, ExpectedVerifierID: "network-evaluator"})
	rollbackTestMust(t, err)
	rollbackTestMust(t, f.kernel.TransitionNode(round, controlkernel.NodeCommitting, token))
	rollbackTestMust(t, save(filepath.Join(f.directory, "active.json"), []byte(repeated)))
	_, err = f.kernel.CommitIntent(intent.ID, token)
	rollbackTestMust(t, err)
	// Exercise production recovery after the real commit, before durable progress
	// or ACK, which is exactly where the failed actual run exposed the collision.
	rollbackTestMust(t, ReconcileNetworkPublication(f.directory, f.kernel, f.issuer))
	rollbackTestMust(t, f.kernel.Close())
	kernel, err := controlkernel.OpenKernel(filepath.Join(f.directory, "authority.journal"))
	rollbackTestMust(t, err)
	defer kernel.Close()
	progress, parent, err := loadIssuerProgress(f.directory, true, f.genesis, f.before.Genesis)
	rollbackTestMust(t, err)
	if progress != after || hash(canonicalJSON(parent)) != repeated {
		t.Fatal("independent restart lost the distinct resumed commit")
	}
	for _, expected := range []networkProgress{original, after} {
		stored, err := readCommittedProgress(f.directory, expected.Sequence)
		rollbackTestMust(t, err)
		if stored != expected {
			t.Fatal("identical checkpoint bytes erased an earlier committed version")
		}
	}
	for _, check := range []struct{ cutoff, expected networkProgress }{{f.before, original}, {after, after}} {
		selected, err := findCommittedAncestor(f.directory, check.cutoff, kernel)
		rollbackTestMust(t, err)
		if selected != check.expected {
			t.Fatal("repeated checkpoint lookup did not select the exact latest eligible commit")
		}
	}
	changed := after
	changed.Lineage = original.Lineage
	if err = committedProgress(f.directory, changed); err == nil {
		t.Fatal("same-sequence lineage conflict was silently ignored")
	}
	stored, err := readCommittedProgress(f.directory, after.Sequence)
	rollbackTestMust(t, err)
	unchanged, err := os.ReadFile(filepath.Join(f.directory, repeated+".json"))
	rollbackTestMust(t, err)
	if stored != after || !bytes.Equal(checkpoint, unchanged) {
		t.Fatal("conflicting event changed immutable progress or checkpoint bytes")
	}
}

func TestRollbackCommittedVersionLookupRefusesUnjournaledLatest(t *testing.T) {
	f := rollbackTestFixture(t, t.TempDir())
	original, err := readCommittedProgress(f.directory, 2)
	rollbackTestMust(t, err)
	future := original
	future.Sequence = 5
	future.Lineage = hash([]byte("unjournaled public version"))
	rollbackTestMust(t, committedProgress(f.directory, future))
	selected, err := findCommittedAncestor(f.directory, f.before, f.kernel)
	rollbackTestMust(t, err)
	if selected != original {
		t.Fatal("future version crossed the exact prior sequence cutoff")
	}
	cutoff := future
	cutoff.Sequence = 6
	if _, err = findCommittedAncestor(f.directory, cutoff, f.kernel); err == nil {
		t.Fatal("unjournaled latest version was authorized or silently skipped")
	}
	// Hash-addressed legacy evidence cannot become an arbitrary version choice.
	rollbackTestMust(t, immutableMetadata(f.directory, "committed-"+original.Parent+".json", original))
	if _, err = findCommittedAncestor(f.directory, f.before, f.kernel); err == nil {
		t.Fatal("unversioned committed metadata was silently treated as authority")
	}
}

func TestRollbackCommittedAncestorBindsPrecedingRequest(t *testing.T) {
	f := rollbackTestFixture(t, t.TempDir())
	before, err := readProgressHistory(f.directory, 0)
	rollbackTestMust(t, err)
	before.Parent = hash([]byte("different public preceding request"))
	rollbackTestMust(t, save(filepath.Join(f.directory, "history-0.json"), encode(before)))
	if err = validateRollbackAncestor(f.directory, f.notice, f.kernel); err == nil || err.Error() != "rollback committed event preceding progress mismatch" {
		t.Fatalf("committed ancestor lost exact preceding request binding: %v", err)
	}
}
