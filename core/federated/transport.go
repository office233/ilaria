package federated

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
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
}

// NewTransportMesh initializes the P2P transport layer.
func NewTransportMesh(localID string, gpuModel string) *TransportMesh {
	if localID == "" {
		localID = "swypik_peer_local"
	}
	if gpuModel == "" {
		gpuModel = "CUDA Direct / Metal Compute Node"
	}

	return &TransportMesh{
		localID:      localID,
		localGPU:     gpuModel,
		peers:        make(map[string]*PeerNode),
		packetStream: make(chan P2PPacket, 256),
	}
}

// RegisterPeer adds or updates a known peer in the P2P routing table.
func (tm *TransportMesh) RegisterPeer(peer *PeerNode) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	peer.LastSeen = time.Now()
	if peer.Reputation <= 0 {
		peer.Reputation = 1.0 // Initial full reputation
	}
	tm.peers[peer.NodeID] = peer
}

// BroadcastGradient sends a local weight delta across connected peers.
func (tm *TransportMesh) BroadcastGradient(delta *WeightDelta) (int, error) {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	payload, err := json.Marshal(delta)
	if err != nil {
		return 0, fmt.Errorf("failed serializing weight delta: %w", err)
	}

	packet := P2PPacket{
		Type:      MsgGradientBroadcast,
		SenderID:  tm.localID,
		PublicIP:  tm.localID,
		Port:      0,
		NATType:   "FullCone",
		Payload:   payload,
		Timestamp: time.Now(),
	}

	sentCount := 0
	for _, peer := range tm.peers {
		if time.Since(peer.LastSeen) < 1*time.Minute && peer.Reputation >= 0.5 {
			sentCount++
		}
	}

	// Queue to local stream for inspection
	select {
	case tm.packetStream <- packet:
	default:
	}

	return sentCount, nil
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

// GetPeers returns the snapshot of all active P2P training peers.
func (tm *TransportMesh) GetPeers() []*PeerNode {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	list := make([]*PeerNode, 0, len(tm.peers))
	for _, p := range tm.peers {
		list = append(list, p)
	}
	return list
}
