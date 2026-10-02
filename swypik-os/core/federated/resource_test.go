package federated

import (
	"fmt"
	"strings"
	"testing"
)

func TestPhoneTrainerRejectsOversizedDelta(t *testing.T) {
	t.Setenv("SWYPIK_RESOURCE_PROFILE", "phone")
	trainer := trainerFixture(t, "phone-node", 10)
	if trainer.maxParamCount != 32768 {
		t.Fatalf("max params=%d want 32768", trainer.maxParamCount)
	}
	if _, err := trainer.ComputeMicroBatch(1, "transformer.lora_a", trainer.maxParamCount+1); err == nil ||
		!strings.Contains(err.Error(), "invalid training parameters") {
		t.Fatalf("oversized microbatch err=%v", err)
	}
}

func TestAggregatorBoundsPendingRoundDeltas(t *testing.T) {
	fa := aggregationFixture(t, 1, 64)
	fa.maxPendingDeltas = 1

	first := trainerFixture(t, "node-a", 10)
	if err := fa.RegisterNodeKey("node-a", first.PublicKey()); err != nil {
		t.Fatal(err)
	}
	d1, err := first.ComputeMicroBatch(1, "transformer.lora_a", 64)
	if err != nil {
		t.Fatal(err)
	}
	if ok, reason := fa.SubmitDelta(d1); !ok {
		t.Fatalf("first delta rejected: %s", reason)
	}

	second := trainerFixture(t, "node-b", 10)
	if err := fa.RegisterNodeKey("node-b", second.PublicKey()); err != nil {
		t.Fatal(err)
	}
	d2, err := second.ComputeMicroBatch(1, "transformer.lora_a", 64)
	if err != nil {
		t.Fatal(err)
	}
	if ok, reason := fa.SubmitDelta(d2); ok || reason != "REJECTED_ROUND_FULL" {
		t.Fatalf("second delta accepted=%v reason=%s", ok, reason)
	}
}

func TestPhoneTransportBoundsResidentPeersAndInspectionQueue(t *testing.T) {
	t.Setenv("SWYPIK_RESOURCE_PROFILE", "phone")
	mesh := NewTransportMesh("local", "mobile")
	if mesh.maxPeers != 16 || cap(mesh.packetStream) != 4 {
		t.Fatalf("maxPeers=%d queue=%d", mesh.maxPeers, cap(mesh.packetStream))
	}
	for i := 0; i < 80; i++ {
		mesh.RegisterPeer(&PeerNode{
			NodeID:     fmt.Sprintf("peer-%03d", i),
			GPUModel:   "edge",
			Reputation: 1,
		})
	}
	if got := len(mesh.GetPeers()); got != 16 {
		t.Fatalf("resident peers=%d want 16", got)
	}

	delta := &WeightDelta{
		NodeID:    "local",
		RoundID:   1,
		LayerName: "transformer.lora_a",
		Values:    make([]float64, 32768),
	}
	if sent, err := mesh.BroadcastGradient(delta); err == nil || sent != 0 {
		t.Fatalf("unimplemented transport reported delivery: sent=%d err=%v", sent, err)
	}
	select {
	case packet := <-mesh.packetStream:
		if packet.PublicIP != "" || packet.NATType != "UNKNOWN" {
			t.Fatalf("inspection packet fabricated network identity: %+v", packet)
		}
		if len(packet.Payload) > mesh.inspectMax {
			t.Fatalf("inspection payload=%d > %d", len(packet.Payload), mesh.inspectMax)
		}
		if len(packet.Payload) > 512 {
			t.Fatalf("inspection payload retained too much delta data: %d bytes", len(packet.Payload))
		}
	default:
		t.Fatal("expected local inspection packet")
	}
}
