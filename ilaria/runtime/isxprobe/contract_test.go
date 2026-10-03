package isxprobe

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"ilaria/generated/myriad"
	"testing"
	"time"
)

func TestSignedMetadataRawBytes(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Now()
	raw := []byte{0, 0, 0, 0}
	hash := sha256.Sum256(raw)
	b := Bindings{Version: 1, Expert: "synthetic-imc", Peer: "p", Round: "r", Config: "c", Base: "b", Fixture: "f", Recipe: "t", Nonce: "n", KeyID: "k", Consent: 1, Fence: 1, Deadline: now.Add(time.Minute).UnixMilli()}
	e := myriad.IMCLocalProbeEnvelope{ProtocolVersion: 1, PeerID: b.Peer, RoundID: b.Round, ModelConfigHash: b.Config, GenesisCheckpointHash: b.Base, CurriculumManifestHash: b.Fixture, TrainingRecipeHash: b.Recipe, Nonce: b.Nonce, SignerKeyID: b.KeyID, ConsentEpoch: 1, LeaseFence: 1, DeadlineUnixMS: b.Deadline, PayloadBytes: 4, PayloadBase64: base64.StdEncoding.EncodeToString(raw), ParameterDeltaHash: hex.EncodeToString(hash[:])}
	encoded, _ := json.Marshal(e)
	e.ExpertID = b.Expert
	encoded, _ = json.Marshal(e)
	var m map[string]any
	d := json.NewDecoder(bytes.NewReader(encoded))
	d.UseNumber()
	_ = d.Decode(&m)
	signed, _ := json.Marshal(m)
	e.SignedCanonicalBase64 = base64.StdEncoding.EncodeToString(signed)
	e.Signature = hex.EncodeToString(ed25519.Sign(private, signed))
	if err := ValidateEnvelope(e, b, raw, public, now); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*myriad.IMCLocalProbeEnvelope){func(e *myriad.IMCLocalProbeEnvelope) { e.TrainingRecipeHash = "resigned-policy" }, func(e *myriad.IMCLocalProbeEnvelope) { e.ModelConfigHash = "resigned-model" }, func(e *myriad.IMCLocalProbeEnvelope) { e.GenesisCheckpointHash = "resigned-base" }, func(e *myriad.IMCLocalProbeEnvelope) { e.CurriculumManifestHash = "resigned-fixture" }} {
		bad := e
		mutate(&bad)
		bad.Signature = ""
		bad.SignedCanonicalBase64 = ""
		data, _ := json.Marshal(bad)
		var fields map[string]any
		d := json.NewDecoder(bytes.NewReader(data))
		d.UseNumber()
		_ = d.Decode(&fields)
		signed, _ := json.Marshal(fields)
		bad.Signature = hex.EncodeToString(ed25519.Sign(private, signed))
		bad.SignedCanonicalBase64 = base64.StdEncoding.EncodeToString(signed)
		if !ed25519.Verify(public, signed, ed25519.Sign(private, signed)) {
			t.Fatal("valid signature required")
		}
		if ValidateEnvelope(bad, b, raw, public, now) == nil {
			t.Fatal("valid re-sign changed authorization")
		}
	}
	for _, missing := range []func(*Bindings){func(b *Bindings) { b.Recipe = "" }, func(b *Bindings) { b.Config = "" }, func(b *Bindings) { b.Base = "" }, func(b *Bindings) { b.Fixture = "" }, func(b *Bindings) { b.Expert = "" }, func(b *Bindings) { b.Version = 0 }} {
		bad := b
		missing(&bad)
		if ValidateEnvelope(e, bad, raw, public, now) == nil {
			t.Fatal("incomplete authorization")
		}
	}
	for _, mutate := range []func(*myriad.IMCLocalProbeEnvelope){func(e *myriad.IMCLocalProbeEnvelope) { e.PeerID = "unknown" }, func(e *myriad.IMCLocalProbeEnvelope) { e.LeaseFence++ }, func(e *myriad.IMCLocalProbeEnvelope) { e.ConsentEpoch++ }, func(e *myriad.IMCLocalProbeEnvelope) { e.TensorLayoutJSON = "tampered" }, func(e *myriad.IMCLocalProbeEnvelope) { e.Signature = "00" }} {
		bad := e
		mutate(&bad)
		if ValidateEnvelope(bad, b, raw, public, now) == nil {
			t.Fatal("tamper accepted")
		}
	}
	if ValidateEnvelope(e, b, raw, public, now.Add(time.Hour)) == nil {
		t.Fatal("expired")
	}
	for _, frame := range [][]byte{[]byte(`{"unknown":1}`), []byte(`{"nonce":"a","nonce":"b"}`), make([]byte, MaxFrameBytes+1)} {
		if _, err := DecodeStrict(frame); err == nil {
			t.Fatal("invalid frame")
		}
	}
}
func TestNetworkIssuedExactBytesAndFreshness(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Now()
	job := map[string]any{"protocol_version": 2, "round_sequence": 1, "consent_epoch": 1, "lease_fence": 1, "deadline_unix_ms": now.Add(time.Minute).UnixMilli()}
	for _, key := range []string{"issuer_id", "expert_id", "session_id", "round_id", "genesis_checkpoint_hash", "current_parent_checkpoint_hash", "lineage_hash", "model_config_hash", "curriculum_manifest_hash", "dataset_scope", "authorized_purpose", "training_recipe_hash", "proposer_id", "evaluator_id", "proposer_key_hash", "evaluator_key_hash", "nonce"} {
		job[key] = "public-" + key
	}
	raw, _ := json.Marshal(job)
	signature := hex.EncodeToString(ed25519.Sign(private, raw))
	if e := ValidateNetworkJob(raw, signature, public, raw, now); e != nil {
		t.Fatal(e)
	}
	job["current_parent_checkpoint_hash"] = "stale"
	changed, _ := json.Marshal(job)
	if ValidateNetworkJob(changed, hex.EncodeToString(ed25519.Sign(private, changed)), public, raw, now) == nil {
		t.Fatal("valid resign changed issued parent")
	}
	if ValidateNetworkJob(raw, signature, public, nil, now) == nil {
		t.Fatal("missing issued contract")
	}
	if ValidateNetworkJob(raw, signature, public, raw, now.Add(time.Hour)) == nil {
		t.Fatal("deadline")
	}
}
