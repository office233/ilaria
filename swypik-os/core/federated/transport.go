package federated

import (
	"crypto/sha256"
	"fmt"
	"sync"
	"time"

	resourcepolicy "swypik-os/core/resource"
)

// P2PMessageType denotes the wire protocol packet category.
type P2PMessageType string

const (
	MsgHello             P2PMessageType = "P2P_HELLO"
	MsgGradientBroadcast P2PMessageType = "P2P_GRADIENT_BROADCAST"
	MsgCheckpointSync    P2PMessageType = "P2P_CHECKPOINT_SYNC"
	MsgNATTraversalProbe P2PMessageType = "P2P_STUN_NAT_PROBE"
)

// P2PPacket encapsulates messages transmitted across the QUIC / WebRTC P2P mesh.
type P2PPacket struct {
	Type      P2PMessageType `json:"type"`
	SenderID  string         `json:"sender_id"`
	PublicIP  string         `json:"public_ip"`
	Port      int            `json:"port"`
	NATType   string         `json:"nat_type"` // e.g. "FullCone", "Symmetric", "RestrictedCone"
	Payload   []byte         `json:"payload"`
	Timestamp time.Time      `json:"timestamp"`
}

// PeerNode represents an active remote GPU worker in the federated network.
type PeerNode struct {
	NodeID       string    `json:"node_id"`
	GPUModel     string    `json:"gpu_model"` // e.g. "NVIDIA RTX 4070"
	TFLOPS       float64   `json:"tflops"`
	Endpoint     string    `json:"endpoint"`
	NATType      string    `json:"nat_type"`
	LastSeen     time.Time `json:"last_seen"`
	Reputation   float64   `json:"reputation"` // 0.0 - 1.0 (decays on invalid proofs / poisoning)
	DeltasPushed int64     `json:"deltas_pushed"`
}

// TransportMesh coordinates brokerless peer-to-peer gossip across workers.
type TransportMesh struct {
	mu           sync.RWMutex
	localID      string
	localGPU     string
	peers        map[string]*PeerNode
	packetStream chan P2PPacket
	maxPeers     int
	inspectMax   int
	socket       *SocketTransport
}

// NewTransportMesh initializes the P2P transport layer.
func NewTransportMesh(localID string, gpuModel string) *TransportMesh {
	if localID == "" {
		localID = "swypik_peer_local"
	}
	if gpuModel == "" {
		gpuModel = "CUDA Direct / Metal Compute Node"
	}

	policy := resourcepolicy.Default()
	return &TransportMesh{
		localID:      localID,
		localGPU:     gpuModel,
		peers:        make(map[string]*PeerNode, min(policy.MaxResidentPeers, 64)),
		packetStream: make(chan P2PPacket, policy.P2PInspectionQueue),
		maxPeers:     policy.MaxResidentPeers,
		inspectMax:   policy.P2PInspectionPayloadMax,
	}
}

// DefaultInitialReputation is the default trust score assigned to newly connected peers.
const DefaultInitialReputation = 1.0

// RegisterPeer adds or updates a known peer in the P2P routing table.
// Existing reputation is preserved for known peers, and internal copies are maintained
// to prevent data races with concurrent PenalizePeer calls.
func (tm *TransportMesh) RegisterPeer(peer *PeerNode) {
	if peer == nil {
		return
	}
	tm.mu.Lock()
	defer tm.mu.Unlock()

	cp := *peer
	cp.LastSeen = time.Now()

	if existing, ok := tm.peers[peer.NodeID]; ok {
		// Retain existing reputation for known peers
		cp.Reputation = existing.Reputation
	} else if cp.Reputation <= 0 {
		cp.Reputation = DefaultInitialReputation
	}
	if _, exists := tm.peers[peer.NodeID]; !exists && len(tm.peers) >= tm.maxPeers {
		oldestID := ""
		var oldest time.Time
		for id, candidate := range tm.peers {
			if oldestID == "" || candidate.LastSeen.Before(oldest) {
				oldestID, oldest = id, candidate.LastSeen
			}
		}
		if oldestID != "" {
			delete(tm.peers, oldestID)
		}
	}

	tm.peers[peer.NodeID] = &cp
}

// BroadcastGradient records a bounded local inspection packet. This package has
// no QUIC/WebRTC sender yet, so it must never report remote delivery.
func (tm *TransportMesh) BroadcastGradient(delta *WeightDelta) (int, error) {
	if delta == nil {
		return 0, fmt.Errorf("nil weight delta")
	}
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	digest := sha256.Sum256(CanonicalDeltaMessage(delta))
	payload := []byte(fmt.Sprintf(
		"delta sha256:%x round:%d layer:%s values:%d",
		digest[:], delta.RoundID, delta.LayerName, len(delta.Values),
	))
	if tm.inspectMax > 0 && len(payload) > tm.inspectMax {
		payload = payload[:tm.inspectMax]
	}

	packet := P2PPacket{
		Type:      MsgGradientBroadcast,
		SenderID:  tm.localID,
		PublicIP:  "",
		Port:      0,
		NATType:   "UNKNOWN",
		Payload:   payload,
		Timestamp: time.Now(),
	}

	// Queue to local stream for inspection
	select {
	case tm.packetStream <- packet:
	default:
	}

	return 0, fmt.Errorf("P2P broadcast unavailable: no network transport is configured")
}

// PenalizePeer reduces a peer's reputation on Byzantine poisoning or cheating.
func (tm *TransportMesh) PenalizePeer(nodeID string, penalty float64) {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	if peer, ok := tm.peers[nodeID]; ok {
		peer.Reputation = peer.Reputation - penalty
		if peer.Reputation < 0.0 {
			peer.Reputation = 0.0
		}
	}
}

// GetPeers returns a snapshot copy of all active P2P training peers.
func (tm *TransportMesh) GetPeers() []*PeerNode {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	list := make([]*PeerNode, 0, len(tm.peers))
	for _, p := range tm.peers {
		cp := *p
		list = append(list, &cp)
	}
	return list
}

// GetPeer returns a snapshot copy of a peer by nodeID if present.
func (tm *TransportMesh) GetPeer(nodeID string) (*PeerNode, bool) {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	p, ok := tm.peers[nodeID]
	if !ok {
		return nil, false
	}
	cp := *p
	return &cp, true
}
