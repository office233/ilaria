package pce

import (
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"

	"ilaria/generated/myriad"
	"ilaria/runtime/protocol"
)

const testHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func event(privacy string) myriad.WorldEvent {
	return myriad.WorldEvent{
		ProtocolVersion: protocol.Version,
		EventID:         "evt-obd-1",
		DeviceClass:     "vehicle",
		SourceNamespace: "obd2",
		ObservationType: "diagnostic",
		Features:        map[string]string{"dtc": "P0301", "rpm": "820"},
		Action:          "inspect-cylinder-1",
		Result:          "misfire confirmed",
		Verifier:        "obd-replay-v1",
		ConfidencePPM:   980_000,
		PrivacyClass:    privacy,
	}
}

func options() Options {
	return Options{
		CapsuleID:            "cap-1",
		SourceCellID:         "cell-a",
		SourceExpertID:       "DeviceCortex",
		AncestryHash:         testHash,
		Domain:               "automotive.diagnostics",
		ObservationSchema:    "world-event-v1",
		AbstractState:        "single-cylinder misfire pattern",
		ActionOrHypothesis:   "inspect cylinder 1",
		RewardPPM:            950_000,
		VerifierEvidenceHash: testHash,
		ProvenanceRefs:       []string{"dataset:obd-replay-v1"},
		ReplayRecipe:         ReplayRecipeSupervisedV1,
		CreatedUnixMS:        1_800_000_000_000,
	}
}

func TestCapsuleSignVerifyAndTamper(t *testing.T) {
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
	if err := Verify(cap, pub); err != nil {
		t.Fatal(err)
	}
	cap.Result = "tampered"
	if err := Verify(cap, pub); err == nil || !strings.Contains(err.Error(), "verification failed") {
		t.Fatalf("tamper was not detected: %v", err)
	}
}

func TestCapsuleRejectsPrivateExperience(t *testing.T) {
	_, err := NewFromWorldEvent(event(string(protocol.PrivacyLocalPrivate)), options())
	if err == nil {
		t.Fatal("local private experience must not become a transferable PCE")
	}
}

func TestCapsuleContentHashDeterministic(t *testing.T) {
	a, err := NewFromWorldEvent(event(string(protocol.PrivacyDeviceNonPersonal)), options())
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewFromWorldEvent(event(string(protocol.PrivacyDeviceNonPersonal)), options())
	if err != nil {
		t.Fatal(err)
	}
	ha, err := ContentHash(a)
	if err != nil {
		t.Fatal(err)
	}
	hb, err := ContentHash(b)
	if err != nil {
		t.Fatal(err)
	}
	if ha != hb {
		t.Fatalf("content hash differs: %s != %s", ha, hb)
	}
}

func TestToReplayExampleRequiresVerifiedCompatibleCapsule(t *testing.T) {
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
	example, err := ToReplayExample(cap, pub, testHash)
	if err != nil {
		t.Fatal(err)
	}
	if example.CapsuleHash == "" || !strings.Contains(example.Prompt, "automotive.diagnostics") || !strings.Contains(example.Target, "misfire confirmed") {
		t.Fatalf("unexpected replay example: %+v", example)
	}
	cap.Result = "tampered"
	if _, err := ToReplayExample(cap, pub, testHash); err == nil {
		t.Fatal("tampered capsule must not become replay data")
	}
}
