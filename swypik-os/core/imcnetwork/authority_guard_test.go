package imcnetwork

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"path/filepath"
	"swypik-os/core/federated"
	"swypik-os/generated/myriad"
	"testing"
)

func authorityGuardKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return public, private
}

func authorityGuardConsent(t *testing.T, state string, enabled bool, epoch int) {
	t.Helper()
	value := map[string]any{"opt_in": enabled, "epoch": epoch, "scope": "synthetic-public-v1", "purpose": "local-network-training"}
	if err := AtomicFile(filepath.Join(state, "consent.json"), encode(value)); err != nil {
		t.Fatal(err)
	}
}

func TestAuthorityGuardReceiveRevocationBlocksDispatch(t *testing.T) {
	for _, epoch := range []int{1, 2} {
		t.Run(string(rune('0'+epoch)), func(t *testing.T) {
			state := t.TempDir()
			authorityGuardConsent(t, state, true, 1)
			received, dispatched := false, false
			_, err := receiveWithConsent(state, func() ([]byte, error) {
				received = true
				// The peer was already waiting when its operator withdrew consent.
				authorityGuardConsent(t, state, false, epoch)
				return []byte(`{"operation":"network-propose"}`), nil
			})
			if err == nil {
				dispatched = true
			}
			if !received || dispatched || err == nil {
				t.Fatalf("revoked receive dispatched: received=%v, dispatched=%v, err=%v", received, dispatched, err)
			}
		})
	}
}

func TestAuthorityGuardReceiveChecksAdmissionAndPreservesPayload(t *testing.T) {
	state := t.TempDir()
	authorityGuardConsent(t, state, false, 1)
	called := false
	if _, err := receiveWithConsent(state, func() ([]byte, error) {
		called = true
		return nil, nil
	}); err == nil || called {
		t.Fatalf("revoked admission reached receive: called=%v, err=%v", called, err)
	}
	authorityGuardConsent(t, state, true, 1)
	want := []byte(`{"operation":"network-propose"}`)
	got, err := receiveWithConsent(state, func() ([]byte, error) { return want, nil })
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("consented receive lost payload: got=%q, err=%v", got, err)
	}
}

func authorityGuardConfig(t *testing.T, local string) NodeConfig {
	t.Helper()
	issuer, _ := authorityGuardKey(t)
	proposer, _ := authorityGuardKey(t)
	config := NodeConfig{ID: local, Members: []Pin{
		{ID: "issuer", Endpoint: "127.0.0.1:31001", Public: hex.EncodeToString(issuer), Role: "issuer"},
		{ID: "proposer", Endpoint: "127.0.0.1:31002", Public: hex.EncodeToString(proposer), Role: "worker"},
	}}
	if local == "issuer" {
		config.Endpoint, config.RemoteID = config.Members[0].Endpoint, "proposer"
	} else {
		config.Endpoint, config.RemoteID = config.Members[1].Endpoint, "issuer"
	}
	return config
}

func TestAuthorityGuardPilotMembershipRejectsAuthorityExpansion(t *testing.T) {
	for _, local := range []string{"issuer", "proposer"} {
		config := authorityGuardConfig(t, local)
		if err := validatePilotMembership(config); err != nil {
			t.Fatalf("valid %s membership refused: %v", local, err)
		}
	}
	for _, fault := range []string{"third-member", "issuer-worker-role", "proposer-issuer-role", "unknown-local", "self-counterpart", "unknown-counterpart"} {
		t.Run(fault, func(t *testing.T) {
			config := authorityGuardConfig(t, "issuer")
			switch fault {
			case "third-member":
				public, _ := authorityGuardKey(t)
				config.Members = append(config.Members, Pin{ID: "third", Endpoint: "127.0.0.1:31003", Public: hex.EncodeToString(public), Role: "worker"})
			case "issuer-worker-role":
				config.Members[0].Role = "worker"
			case "proposer-issuer-role":
				config.Members[1].Role = "issuer"
			case "unknown-local":
				config.ID = "third"
			case "self-counterpart":
				config.RemoteID = config.ID
			case "unknown-counterpart":
				config.RemoteID = "third"
			}
			if err := validatePilotMembership(config); err == nil {
				t.Fatal("expanded or misassigned pilot authority admitted")
			}
		})
	}
}

func TestAuthorityGuardAuthenticatedCounterpartIsPinned(t *testing.T) {
	for _, local := range []string{"issuer", "proposer"} {
		t.Run(local, func(t *testing.T) {
			config := authorityGuardConfig(t, local)
			var peer federated.BootstrapMember
			for _, pin := range config.Members {
				if pin.ID == config.RemoteID {
					public, err := hex.DecodeString(pin.Public)
					if err != nil {
						t.Fatal(err)
					}
					peer = federated.BootstrapMember{ID: pin.ID, Endpoint: pin.Endpoint, PublicKey: public, Role: pin.Role}
				}
			}
			if err := validateCounterpart(config, peer); err != nil {
				t.Fatalf("pinned authenticated counterpart refused: %v", err)
			}
			for _, fault := range []string{"id", "role", "key", "endpoint"} {
				t.Run(fault, func(t *testing.T) {
					changed := peer
					switch fault {
					case "id":
						changed.ID = config.ID
					case "role":
						if peer.Role == "issuer" {
							changed.Role = "worker"
						} else {
							changed.Role = "issuer"
						}
					case "key":
						changed.PublicKey, _ = authorityGuardKey(t)
					case "endpoint":
						changed.Endpoint = "127.0.0.1:31003"
					}
					if err := validateCounterpart(config, changed); err == nil {
						t.Fatal("wrong authenticated counterpart admitted")
					}
				})
			}
		})
	}
}

func authorityGuardIssued() myriad.IMCNetworkRoundJob {
	return myriad.IMCNetworkRoundJob{
		ProtocolVersion: 2, SessionID: "public-test-session", RoundID: "round-4", RoundSequence: 4,
		GenesisCheckpointHash:       hash([]byte("synthetic-genesis")),
		CurrentParentCheckpointHash: hash([]byte("synthetic-parent")),
		LineageHash:                 hash([]byte("synthetic-parent-lineage")),
	}
}

func authorityGuardSignedAck(progress networkProgress, private ed25519.PrivateKey) []byte {
	return encode(networkProgressSync{Progress: progress, Signature: hex.EncodeToString(ed25519.Sign(private, encode(progress)))})
}

func TestAuthorityGuardIssuerAckAcceptedAndRejectedTransitions(t *testing.T) {
	public, private := authorityGuardKey(t)
	issued := authorityGuardIssued()
	for _, accepted := range []bool{false, true} {
		progress := networkProgress{Session: issued.SessionID, Genesis: issued.GenesisCheckpointHash, Parent: issued.CurrentParentCheckpointHash, Lineage: issued.LineageHash, Sequence: issued.RoundSequence}
		if accepted {
			progress.Parent = hash([]byte("synthetic-candidate"))
			progress.Lineage = hash([]byte(issued.LineageHash + progress.Parent))
		}
		got, err := validateIssuerAck(issued, authorityGuardSignedAck(progress, private), public)
		if err != nil || got != progress {
			t.Fatalf("valid accepted=%v transition refused: got=%+v, err=%v", accepted, got, err)
		}
	}
}

func TestAuthorityGuardIssuerAckRejectsForgeryAndResignedWrongState(t *testing.T) {
	public, private := authorityGuardKey(t)
	_, transportPrivate := authorityGuardKey(t)
	issued := authorityGuardIssued()
	accepted := networkProgress{Session: issued.SessionID, Genesis: issued.GenesisCheckpointHash, Parent: hash([]byte("synthetic-candidate")), Sequence: issued.RoundSequence}
	accepted.Lineage = hash([]byte(issued.LineageHash + accepted.Parent))
	for _, fault := range []string{"unsigned", "transport-key", "forged-signature", "sequence", "session", "genesis", "accepted-lineage", "rejected-lineage", "invalid-parent"} {
		t.Run(fault, func(t *testing.T) {
			progress := accepted
			signingKey := private
			switch fault {
			case "transport-key":
				signingKey = transportPrivate
			case "sequence":
				progress.Sequence++
			case "session":
				progress.Session = "other-public-session"
			case "genesis":
				progress.Genesis = hash([]byte("other-synthetic-genesis"))
			case "accepted-lineage":
				progress.Lineage = issued.LineageHash
			case "rejected-lineage":
				progress.Parent = issued.CurrentParentCheckpointHash
			case "invalid-parent":
				progress.Parent = "not-a-checkpoint-hash"
				progress.Lineage = hash([]byte(issued.LineageHash + progress.Parent))
			}
			raw := authorityGuardSignedAck(progress, signingKey)
			if fault == "unsigned" {
				raw = encode(progress)
			} else if fault == "forged-signature" {
				raw = encode(networkProgressSync{Progress: progress, Signature: hex.EncodeToString(make([]byte, ed25519.SignatureSize))})
			}
			if _, err := validateIssuerAck(issued, raw, public); err == nil {
				t.Fatal("forged or mismatched issuer progress admitted")
			}
		})
	}
}
