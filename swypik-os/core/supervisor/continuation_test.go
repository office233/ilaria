package supervisor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"swypik-os/core/effects"
)

func enableContinuationFixture(f *fixture) {
	f.t.Helper()
	f.config.Plan.FuelLimit = 100
	f.config.Plan.MaxEffectBytes = 1024
	f.config.Continuation = ContinuationPolicy{
		Enabled: true, Mode: ContinuationModeAES256GCM,
		Directory: filepath.Join(filepath.Dir(f.config.LedgerPath), "continuations"),
		KeyID:     "fixture-continuation-key", MaxEnvelopeBytes: MaxContinuationEnvelopeBytes,
	}
	copy(f.config.Continuation.Key[:], []byte("0123456789abcdef0123456789abcdef"))
}

func fixtureCheckpoint(t *testing.T, f *fixture, evidence Evidence, sequence uint64, state []byte) []byte {
	t.Helper()
	requestHash, err := effectsRequestHash(evidence)
	if err != nil {
		t.Fatal(err)
	}
	resultHash, err := effectsResultHash(evidence)
	if err != nil {
		t.Fatal(err)
	}
	envelope := ContinuationEnvelope{
		ProtocolVersion: 1, Type: "continuation", StateVersion: 1,
		RunID: f.config.Plan.RunID, ModuleHash: f.config.Plan.ModuleHash, Entry: f.config.Plan.Entry,
		FuelLimit: f.config.Plan.FuelLimit, StepsUsed: sequence + 1,
		MaxEffectBytes: f.config.Plan.MaxEffectBytes, EffectBytes: 0, EffectCursor: sequence,
		EffectRequestHash: requestHash, EffectResultHash: resultHash, StateHash: digestHex(state), State: state,
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func effectsRequestHash(evidence Evidence) (string, error) {
	return effects.RequestHash(evidence.Request)
}

func effectsResultHash(evidence Evidence) (string, error) {
	return effects.ResultHash(evidence.Result)
}

func TestContinuationEnvelopeHashMatchesSwypPublicVector(t *testing.T) {
	state := []byte("opaque-vector-state")
	envelope := ContinuationEnvelope{
		ProtocolVersion: 1, Type: "continuation", StateVersion: 1, RunID: "run-vector:1",
		ModuleHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", Entry: "main",
		FuelLimit: 100, StepsUsed: 7, MaxEffectBytes: 1024, EffectBytes: 12, EffectCursor: 1,
		EffectRequestHash: strings.Repeat("1", 64), EffectResultHash: strings.Repeat("2", 64),
		StateHash: "b165836b8f85f1bb45ce98f258ccdeceda792770c482b6396d1ba3f84f6dbb59", State: state,
	}
	if digestHex(state) != envelope.StateHash {
		t.Fatal("Swyp public state-hash vector drifted")
	}
	hash, err := continuationEnvelopeHash(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if hash != "97d41556bc3d9db077970070d027a804468c16944f1be7790bac542d39ffe9a6" {
		t.Fatalf("Swyp public BindingBytes/EnvelopeHash vector mismatch: %s", hash)
	}
}

func TestAuthenticatedContinuationCrashSuspendResumeDoesNotReplayResolvedEffect(t *testing.T) {
	f := newFixture(t)
	enableContinuationFixture(f)
	f.start()
	first := f.handle(1, "fs.read")
	raw := fixtureCheckpoint(t, f, first, 1, []byte("opaque-state-with-sensitive-local"))
	binding, err := f.sup.StoreContinuation(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if binding.EffectCursor != 1 || binding.RequestHash == "" || binding.ResultHash == "" || binding.Fence == 0 {
		t.Fatalf("incomplete continuation binding: %+v", binding)
	}
	ledgerRaw, err := os.ReadFile(f.config.LedgerPath)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ledgerRaw, []byte("sensitive-local")) || bytes.Contains(ledgerRaw, f.config.Continuation.Key[:]) {
		t.Fatal("ledger leaked continuation plaintext or raw key")
	}
	payload := f.sup.ledger.continuations[1]
	sealedRaw, err := os.ReadFile(f.sup.continuationRecordPathLocked(payload))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealedRaw, []byte("sensitive-local")) || bytes.Contains(sealedRaw, f.config.Continuation.Key[:]) {
		t.Fatal("sealed continuation store exposed plaintext state or raw key")
	}

	s := reopenForRecovery(t, f)
	report, err := s.Recover(context.Background())
	if err != nil || report.Outcome != RecoveryResumeAvailable || !report.ContinuationAvailable || report.ContinuationResumed ||
		!report.EvidenceVerified || report.Sequence != 1 || report.Status.State != StateRunning {
		t.Fatalf("recovery=%+v err=%v", report, err)
	}
	resume, err := s.BeginResume(context.Background())
	if err != nil || !bytes.Equal(resume.Envelope, raw) {
		t.Fatalf("resume=%+v err=%v", resume.Binding, err)
	}

	// Suspending before another effect changes no durable cursor, so the same
	// authenticated checkpoint remains admissible after another host restart.
	s.ForgetResumeAuthorization()
	s = reopenForRecovery(t, f)
	report, err = s.Recover(context.Background())
	if err != nil || report.Outcome != RecoveryResumeAvailable {
		t.Fatalf("second recovery=%+v err=%v", report, err)
	}
	if _, err := s.BeginResume(context.Background()); err != nil {
		t.Fatal(err)
	}
	second := f.handle(2, "clock.read")
	if first.Result.RequestID == second.Result.RequestID || f.reads != 1 || f.verifies != 2 {
		t.Fatalf("resolved effect replayed: reads=%d verifies=%d first=%s second=%s", f.reads, f.verifies, first.Result.RequestID, second.Result.RequestID)
	}
}

func TestAuthenticatedContinuationBlocksNextEffectAndCompletionUntilCheckpointIsDurable(t *testing.T) {
	f := newFixture(t)
	enableContinuationFixture(f)
	f.start()
	_ = f.handle(1, "fs.read")
	if _, err := f.sup.Handle(context.Background(), f.request(2, "clock.read")); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatalf("next effect admitted before durable continuation: %v", err)
	}
	if f.reads != 1 || f.verifies != 1 || f.sup.Status().Issued != 1 || f.sup.Status().Committed != 1 {
		t.Fatalf("provider/verifier advanced without checkpoint: status=%+v reads=%d verifies=%d", f.sup.Status(), f.reads, f.verifies)
	}
	if _, err := f.sup.Finish(context.Background(), strings.Repeat("3", 64)); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatalf("completion admitted before durable continuation: %v", err)
	}
	status, err := f.sup.Abort(context.Background(), "missing_checkpoint")
	if err != nil || status.State != StateUncertain {
		t.Fatalf("missing continuation was not preserved as uncertain: status=%+v err=%v", status, err)
	}
}

func TestAuthenticatedContinuationRejectsMismatchBudgetAndMissingResult(t *testing.T) {
	cases := []string{"module", "run", "fuel", "effect-budget", "request-hash", "result-hash"}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			enableContinuationFixture(f)
			f.start()
			evidence := f.handle(1, "fs.read")
			raw := fixtureCheckpoint(t, f, evidence, 1, []byte("state"))
			var envelope ContinuationEnvelope
			if err := json.Unmarshal(raw, &envelope); err != nil {
				t.Fatal(err)
			}
			switch name {
			case "module":
				envelope.ModuleHash = strings.Repeat("1", 64)
			case "run":
				envelope.RunID = "other-run"
			case "fuel":
				envelope.FuelLimit++
			case "effect-budget":
				envelope.MaxEffectBytes++
			case "request-hash":
				envelope.EffectRequestHash = strings.Repeat("1", 64)
			case "result-hash":
				envelope.EffectResultHash = strings.Repeat("2", 64)
			}
			envelope.StateHash = digestHex(envelope.State)
			mutated, _ := json.Marshal(envelope)
			if _, err := f.sup.StoreContinuation(context.Background(), mutated); !errors.Is(err, ErrContinuationRejected) {
				t.Fatalf("StoreContinuation err=%v", err)
			}
			if len(f.sup.ledger.continuations) != 0 {
				t.Fatal("rejected checkpoint became durable")
			}
		})
	}
}

func TestAuthenticatedContinuationRejectsTamperRollbackAndFenceMismatch(t *testing.T) {
	t.Run("ciphertext-tamper", func(t *testing.T) {
		f := newFixture(t)
		enableContinuationFixture(f)
		f.start()
		evidence := f.handle(1, "fs.read")
		if _, err := f.sup.StoreContinuation(context.Background(), fixtureCheckpoint(t, f, evidence, 1, []byte("secret-state"))); err != nil {
			t.Fatal(err)
		}
		payload := f.sup.ledger.continuations[1]
		path := f.sup.continuationRecordPathLocked(payload)
		record, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		record[len(record)-2] ^= 1
		if err := os.WriteFile(path, record, 0600); err != nil {
			t.Fatal(err)
		}
		s := reopenForRecovery(t, f)
		report, err := s.Recover(context.Background())
		if !errors.Is(err, ErrContinuationRejected) || report.Outcome != RecoveryContinuationRejected || report.Status.State != StateUncertain ||
			f.reads != 1 || f.verifies != 1 {
			t.Fatalf("tamper recovery=%+v err=%v reads=%d verifies=%d", report, err, f.reads, f.verifies)
		}
	})

	t.Run("rollback-does-not-fallback", func(t *testing.T) {
		f := newFixture(t)
		enableContinuationFixture(f)
		f.start()
		first := f.handle(1, "fs.read")
		if _, err := f.sup.StoreContinuation(context.Background(), fixtureCheckpoint(t, f, first, 1, []byte("state-one"))); err != nil {
			t.Fatal(err)
		}
		second := f.handle(2, "clock.read")
		if _, err := f.sup.StoreContinuation(context.Background(), fixtureCheckpoint(t, f, second, 2, []byte("state-two"))); err != nil {
			t.Fatal(err)
		}
		oldPayload, newPayload := f.sup.ledger.continuations[1], f.sup.ledger.continuations[2]
		oldRaw, err := os.ReadFile(f.sup.continuationRecordPathLocked(oldPayload))
		if err != nil {
			t.Fatal(err)
		}
		newPath := f.sup.continuationRecordPathLocked(newPayload)
		if err := os.WriteFile(newPath, oldRaw, 0600); err != nil {
			t.Fatal(err)
		}
		s := reopenForRecovery(t, f)
		report, err := s.Recover(context.Background())
		if !errors.Is(err, ErrContinuationRejected) || report.Status.State != StateUncertain || report.Sequence != 2 {
			t.Fatalf("rollback recovery=%+v err=%v", report, err)
		}
	})

	t.Run("fence-mismatch", func(t *testing.T) {
		f := newFixture(t)
		enableContinuationFixture(f)
		f.start()
		evidence := f.handle(1, "fs.read")
		raw := fixtureCheckpoint(t, f, evidence, 1, []byte("state"))
		envelope, err := decodeContinuationEnvelope(raw, f.config.Continuation.MaxEnvelopeBytes)
		if err != nil {
			t.Fatal(err)
		}
		checkpointHash := digestHex(raw)
		envelopeHash, err := continuationEnvelopeHash(envelope)
		if err != nil {
			t.Fatal(err)
		}
		binding, err := f.sup.continuationBindingLocked(1, checkpointHash, envelopeHash, envelope.StateHash)
		if err != nil {
			t.Fatal(err)
		}
		binding.Fence++
		recordRaw, recordHash, err := f.sup.sealContinuationLocked(binding, raw)
		if err != nil {
			t.Fatal(err)
		}
		payload := continuationPayload{
			Sequence: 1, RecordHash: recordHash, CheckpointHash: checkpointHash, EnvelopeHash: envelopeHash, StateHash: envelope.StateHash,
			KeyID: f.config.Continuation.KeyID, NodeID: binding.NodeID, AttemptID: binding.AttemptID, LeaseID: binding.LeaseID, Fence: binding.Fence,
			RequestHash: binding.RequestHash, ResultHash: binding.ResultHash, ReceiptHash: binding.ReceiptHash, IntentID: binding.IntentID,
		}
		if err := f.sup.persistContinuationRecordLocked(payload, recordRaw); err != nil {
			t.Fatal(err)
		}
		f.sup.mu.Lock()
		err = f.sup.appendLocked(eventContinuation, payload)
		f.sup.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		s := reopenForRecovery(t, f)
		report, err := s.Recover(context.Background())
		if !errors.Is(err, ErrContinuationRejected) || report.Status.State != StateUncertain {
			t.Fatalf("fence recovery=%+v err=%v", report, err)
		}
	})
}

func TestAuthenticatedContinuationPolicyChangeAndMissingRecordFailClosed(t *testing.T) {
	t.Run("policy-change", func(t *testing.T) {
		f := newFixture(t)
		enableContinuationFixture(f)
		f.start()
		evidence := f.handle(1, "fs.read")
		if _, err := f.sup.StoreContinuation(context.Background(), fixtureCheckpoint(t, f, evidence, 1, []byte("state"))); err != nil {
			t.Fatal(err)
		}
		if err := f.sup.Close(); err != nil {
			t.Fatal(err)
		}
		f.sup = nil
		if err := f.kernel.Close(); err != nil {
			t.Fatal(err)
		}
		f.openKernel()
		c := f.config
		c.Kernel = f.kernel
		c.Plan = Plan{}
		c.Reader = nil
		c.Continuation.KeyID = "rotated-without-migration"
		if _, err := OpenRecovery(c); !errors.Is(err, ErrPolicyChanged) {
			t.Fatalf("changed continuation policy err=%v", err)
		}
	})

	t.Run("missing-record", func(t *testing.T) {
		f := newFixture(t)
		enableContinuationFixture(f)
		f.start()
		evidence := f.handle(1, "fs.read")
		if _, err := f.sup.StoreContinuation(context.Background(), fixtureCheckpoint(t, f, evidence, 1, []byte("state"))); err != nil {
			t.Fatal(err)
		}
		payload := f.sup.ledger.continuations[1]
		if err := os.Remove(f.sup.continuationRecordPathLocked(payload)); err != nil {
			t.Fatal(err)
		}
		s := reopenForRecovery(t, f)
		report, err := s.Recover(context.Background())
		if !errors.Is(err, ErrContinuationRejected) || report.Status.State != StateUncertain || report.ContinuationAvailable {
			t.Fatalf("missing record recovery=%+v err=%v", report, err)
		}
	})
}
