package federated

import (
	"crypto/ed25519"
	crand "crypto/rand"
	"math"
	"sync"
	"testing"
	"time"
)

func TestRegressionK3SignatureAndRewardBounds(t *testing.T) {
	agg := NewFederatedAggregator(1)
	trainer := NewLocalTrainer("valid-node", 35)

	// Register valid node's public key
	if err := agg.RegisterNodeKey(trainer.nodeID, trainer.PublicKey()); err != nil {
		t.Fatalf("failed to register node key: %v", err)
	}

	// 1. Validly signed delta accepted
	validDelta, err := trainer.ComputeMicroBatch(1, "transformer.lora_a", 32)
	if err != nil {
		t.Fatalf("failed to compute microbatch: %v", err)
	}
	accepted, reason := agg.SubmitDelta(validDelta)
	if !accepted || reason != "ACCEPTED" {
		t.Fatalf("expected valid delta to be accepted, got: accepted=%v, reason=%s", accepted, reason)
	}

	// 2. Forged delta from unregistered / unknown NodeID rejected
	unknownTrainer := NewLocalTrainer("unknown-node", 35)
	unknownDelta, err := unknownTrainer.ComputeMicroBatch(1, "transformer.lora_a", 32)
	if err != nil {
		t.Fatalf("failed computing delta: %v", err)
	}
	accepted, reason = agg.SubmitDelta(unknownDelta)
	if accepted || reason != "REJECTED_UNKNOWN_NODE" {
		t.Fatalf("expected REJECTED_UNKNOWN_NODE for unregistered node, got: accepted=%v, reason=%s", accepted, reason)
	}

	// 3. Forged delta: delta forged with bad/tampered signature rejected
	forgedDelta, err := trainer.ComputeMicroBatch(1, "transformer.lora_a", 32)
	if err != nil {
		t.Fatalf("failed computing delta: %v", err)
	}
	// Corrupt signature
	forgedDelta.Signature[0] ^= 0xFF
	accepted, reason = agg.SubmitDelta(forgedDelta)
	if accepted || reason != "REJECTED_INVALID_SIGNATURE" {
		t.Fatalf("expected REJECTED_INVALID_SIGNATURE for bad signature, got: accepted=%v, reason=%s", accepted, reason)
	}

	// 4. Forged delta: signed with a different node's private key
	_, otherPriv, err := ed25519.GenerateKey(crand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	impersonatedDelta, err := trainer.ComputeMicroBatch(1, "transformer.lora_a", 32)
	if err != nil {
		t.Fatal(err)
	}
	if err := impersonatedDelta.Sign(otherPriv); err != nil {
		t.Fatal(err)
	}
	accepted, reason = agg.SubmitDelta(impersonatedDelta)
	if accepted || reason != "REJECTED_INVALID_SIGNATURE" {
		t.Fatalf("expected REJECTED_INVALID_SIGNATURE for mismatched key, got: accepted=%v, reason=%s", accepted, reason)
	}

	// 5. Oversized TFLOPS rejected
	oversizedTrainer := NewLocalTrainer("oversized-node", 35)
	if err := agg.RegisterNodeKey(oversizedTrainer.nodeID, oversizedTrainer.PublicKey()); err != nil {
		t.Fatal(err)
	}
	oversizedDelta, err := oversizedTrainer.ComputeMicroBatch(1, "transformer.lora_a", 32)
	if err != nil {
		t.Fatal(err)
	}
	oversizedDelta.TFLOPSComputed = MaxTFLOPSPerDelta + 50.0
	// Re-sign with oversized TFLOPS so signature is valid, but TFLOPS boundary rejects it
	if err := oversizedDelta.Sign(oversizedTrainer.privateKey()); err != nil {
		t.Fatal(err)
	}
	accepted, reason = agg.SubmitDelta(oversizedDelta)
	if accepted || reason != "REJECTED_EXCESSIVE_TFLOPS" {
		t.Fatalf("expected REJECTED_EXCESSIVE_TFLOPS for %f TFLOPS, got: accepted=%v, reason=%s", oversizedDelta.TFLOPSComputed, accepted, reason)
	}

	// 6. Rewards are strictly bounded
	excessiveReward := agg.CalculateReward(1e9)
	maxExpectedReward := math.Round(MaxTFLOPSPerDelta*agg.rewardPerTflop*1000) / 1000
	if excessiveReward > maxExpectedReward {
		t.Fatalf("reward exceeded ceiling: got %f, max expected %f", excessiveReward, maxExpectedReward)
	}
	if zeroReward := agg.CalculateReward(-10.0); zeroReward != 0.0 {
		t.Fatalf("negative TFLOPS got non-zero reward: %f", zeroReward)
	}
}

func TestRegressionK4PeerReputationRetention(t *testing.T) {
	mesh := NewTransportMesh("test_mesh", "RTX 4090")
	peer := &PeerNode{
		NodeID:   "peer-malicious",
		GPUModel: "RTX 3080",
		TFLOPS:   30.0,
		Endpoint: "10.0.0.1:9000",
	}

	// Register peer initially -> should have initial reputation (1.0)
	mesh.RegisterPeer(peer)
	peers := mesh.GetPeers()
	if len(peers) != 1 || peers[0].Reputation != 1.0 {
		t.Fatalf("initial peer reputation unexpected: %+v", peers)
	}

	// Penalize peer all the way down to 0.0
	mesh.PenalizePeer("peer-malicious", 1.0)
	peers = mesh.GetPeers()
	if len(peers) != 1 || peers[0].Reputation != 0.0 {
		t.Fatalf("penalized peer reputation want 0.0, got: %f", peers[0].Reputation)
	}

	// Peer attempts to reset reputation by re-registering with 0 or 1.0
	reconnectPeer := &PeerNode{
		NodeID:     "peer-malicious",
		GPUModel:   "RTX 3080",
		TFLOPS:     30.0,
		Endpoint:   "10.0.0.1:9000",
		Reputation: 0.0,
	}
	mesh.RegisterPeer(reconnectPeer)

	// Known peer must RETAIN existing penalized reputation (0.0), NOT reset to 1.0
	peers = mesh.GetPeers()
	if len(peers) != 1 || peers[0].Reputation != 0.0 {
		t.Fatalf("penalized peer recovered reputation upon re-registration: %f", peers[0].Reputation)
	}

	// Re-registering with forged positive reputation must also be ignored in favor of stored reputation
	reconnectPeerForged := &PeerNode{
		NodeID:     "peer-malicious",
		GPUModel:   "RTX 3080",
		TFLOPS:     30.0,
		Endpoint:   "10.0.0.1:9000",
		Reputation: 1.0,
	}
	mesh.RegisterPeer(reconnectPeerForged)
	peers = mesh.GetPeers()
	if len(peers) != 1 || peers[0].Reputation != 0.0 {
		t.Fatalf("peer forged reputation upon re-registration: %f", peers[0].Reputation)
	}
}

func TestRegressionK4PeerCopySafetyAndDataRace(t *testing.T) {
	mesh := NewTransportMesh("race_mesh", "RTX 4090")
	peer := &PeerNode{
		NodeID:   "race-peer",
		GPUModel: "RTX 3080",
		TFLOPS:   30.0,
		Endpoint: "10.0.0.2:9000",
	}
	mesh.RegisterPeer(peer)

	var wg sync.WaitGroup
	stop := make(chan struct{})

	// Goroutine 1: Rapidly penalizing peer
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				mesh.PenalizePeer("race-peer", 0.01)
			}
		}
	}()

	// Goroutine 2: Reading peers snapshot and inspecting reputation
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				peers := mesh.GetPeers()
				if len(peers) > 0 {
					_ = peers[0].Reputation
					// Mutating the returned copy must not affect mesh or cause race
					peers[0].Reputation = 9.9
				}
			}
		}
	}()

	// Goroutine 3: Mutating the caller's original peer pointer
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				peer.Reputation = 5.0
				peer.LastSeen = time.Now()
			}
		}
	}()

	time.Sleep(100 * time.Millisecond)
	close(stop)
	wg.Wait()
}

func TestSignatureCoversExactFloatBits(t *testing.T) {
	trainer := NewLocalTrainer("bits-node", 35)
	delta, err := trainer.ComputeMicroBatch(1, "transformer.lora_a", 8)
	if err != nil {
		t.Fatal(err)
	}
	if !delta.VerifySignature(trainer.PublicKey()) {
		t.Fatal("fresh delta must verify")
	}
	// A change far below the old %.8f formatting resolution must break the signature.
	tampered := *delta
	tampered.Loss = math.Nextafter(delta.Loss, math.Inf(1))
	if tampered.VerifySignature(trainer.PublicKey()) {
		t.Fatal("signature must not survive a one-ulp change to Loss")
	}
	tampered = *delta
	tampered.TFLOPSComputed = math.Nextafter(delta.TFLOPSComputed, math.Inf(1))
	if tampered.VerifySignature(trainer.PublicKey()) {
		t.Fatal("signature must not survive a one-ulp change to TFLOPSComputed")
	}
}
