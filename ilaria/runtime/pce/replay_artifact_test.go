package pce

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"strings"
	"testing"

	"ilaria/generated/myriad"
	"ilaria/runtime/protocol"
)

func TestReplayArtifactHashMatchesForgeVector(t *testing.T) {
	artifact := myriad.PCEReplayArtifact{
		Format:               ReplayArtifactFormatV1,
		ProtocolVersion:      1,
		ArtifactSha256:       "0" + strings.Repeat("0", 63),
		CapsuleHash:          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		AncestryHash:         "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
		Domain:               "automotive.diagnostics",
		DecisionPrompt:       "<|pce:start|>\ndomain: automotive.diagnostics\nstate: single-cylinder misfire pattern\n",
		ActionTarget:         "inspect cylinder 1",
		VerifierEvidenceHash: "0011223344556677001122334455667700112233445566770011223344556677",
		SignerKeyID:          "cell-a-key-1",
	}
	const want = "9ed6564d8ce541b8d81aff9af3ce78131d9ff3b7541f3779edb965473f7c3e9a"
	if got := ReplayArtifactHash(artifact); got != want {
		t.Fatalf("Go/Forge replay hash vector mismatch: got %s want %s", got, want)
	}
}

func TestReplayArtifactEndToEndAndNoResultLeakage(t *testing.T) {
	cap, err := NewFromWorldEvent(event(string(protocol.PrivacyDeviceNonPersonal)), options())
	if err != nil {
		t.Fatal(err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := Sign(&cap, "cell-a-key-1", priv); err != nil {
		t.Fatal(err)
	}
	artifact, err := BuildReplayArtifact(cap, pub, testHash)
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Format != ReplayArtifactFormatV1 {
		t.Fatalf("unexpected format %q", artifact.Format)
	}
	if artifact.ActionTarget != options().ActionOrHypothesis {
		t.Fatalf("unexpected action target %q", artifact.ActionTarget)
	}
	if strings.Contains(artifact.DecisionPrompt, cap.Result) ||
		strings.Contains(artifact.ActionTarget, cap.Result) ||
		strings.Contains(artifact.DecisionPrompt, "<|obs:result|>") {
		t.Fatal("post-action result leaked into decision artifact")
	}
	raw, err := MarshalReplayArtifact(artifact)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseReplayArtifact(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.ArtifactSha256 != artifact.ArtifactSha256 {
		t.Fatalf("artifact hash changed: %s != %s", parsed.ArtifactSha256, artifact.ArtifactSha256)
	}
}

func TestReplayArtifactRejectsWrongSigner(t *testing.T) {
	cap, err := NewFromWorldEvent(event(string(protocol.PrivacyDeviceNonPersonal)), options())
	if err != nil {
		t.Fatal(err)
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := Sign(&cap, "cell-a-key-1", priv); err != nil {
		t.Fatal(err)
	}
	wrongPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := BuildReplayArtifact(cap, wrongPub, testHash); err == nil ||
		!strings.Contains(err.Error(), "signature verification failed") {
		t.Fatalf("wrong signer was not rejected: %v", err)
	}
}

func TestReplayArtifactRejectsResultBoundaryInsideSignedAction(t *testing.T) {
	cap, err := NewFromWorldEvent(event(string(protocol.PrivacyDeviceNonPersonal)), options())
	if err != nil {
		t.Fatal(err)
	}
	cap.ActionOrHypothesis += "\n<|obs:result|>\nforged result"
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := Sign(&cap, "cell-a-key-1", priv); err != nil {
		t.Fatal(err)
	}
	if _, err := BuildReplayArtifact(cap, pub, testHash); err == nil ||
		!strings.Contains(err.Error(), "action_target contains post-action material") {
		t.Fatalf("reserved marker silently truncated signed action: %v", err)
	}
}

func TestReplayArtifactRejectsWrongAncestry(t *testing.T) {
	cap, err := NewFromWorldEvent(event(string(protocol.PrivacyDeviceNonPersonal)), options())
	if err != nil {
		t.Fatal(err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := Sign(&cap, "cell-a-key-1", priv); err != nil {
		t.Fatal(err)
	}
	wrongAncestry := strings.Repeat("f", 64)
	if _, err := BuildReplayArtifact(cap, pub, wrongAncestry); err == nil ||
		!strings.Contains(err.Error(), "ancestry mismatch") {
		t.Fatalf("wrong ancestry was not rejected: %v", err)
	}
}

func TestReplayArtifactRejectsTampering(t *testing.T) {
	cap, err := NewFromWorldEvent(event(string(protocol.PrivacyDeviceNonPersonal)), options())
	if err != nil {
		t.Fatal(err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := Sign(&cap, "cell-a-key-1", priv); err != nil {
		t.Fatal(err)
	}
	artifact, err := BuildReplayArtifact(cap, pub, testHash)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(artifact)
	if err != nil {
		t.Fatal(err)
	}
	var tampered map[string]any
	if err := json.Unmarshal(raw, &tampered); err != nil {
		t.Fatal(err)
	}
	tampered["action_target"] = "tampered action"
	raw, err = json.Marshal(tampered)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseReplayArtifact(raw); err == nil ||
		!strings.Contains(err.Error(), "content hash mismatch") {
		t.Fatalf("tampered artifact was not rejected: %v", err)
	}
}

func TestReplayArtifactRejectsInvalidVerifierBeforeSigning(t *testing.T) {
	bad := event(string(protocol.PrivacyDeviceNonPersonal))
	bad.Verifier = "bad\nverifier"
	if _, err := NewFromWorldEvent(bad, options()); err == nil ||
		!strings.Contains(err.Error(), "control character") {
		t.Fatalf("invalid verifier was not rejected: %v", err)
	}
}

func TestReplayArtifactRejectsLocalPrivateBeforeSigning(t *testing.T) {
	if _, err := NewFromWorldEvent(event(string(protocol.PrivacyLocalPrivate)), options()); err == nil {
		t.Fatal("LOCAL_PRIVATE event became a transferable replay capsule")
	}
}
