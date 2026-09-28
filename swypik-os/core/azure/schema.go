package azure

import (
	"time"
)

// Cosmos DB Partition Key Paths:
// - Nodes: /id
// - TrainingRounds: /round_id
// - Wallets: /address
// - ProofOfCompute: /round_id

// NodeDocument models a GPU compute worker in Azure Cosmos DB / PostgreSQL.
type NodeDocument struct {
	ID              string    `json:"id"` // Unique Node GUID
	Address         string    `json:"address"` // SWP Wallet Address
	AvailableTflops float64   `json:"available_tflops"`
	IlariaVersion   string    `json:"ilaria_version"` // e.g. "ilaria-v1.2"
	GPUModel        string    `json:"gpu_model"` // e.g. "NVIDIA GeForce RTX 4070"
	ReputationScore float64   `json:"reputation_score"` // 0.0 - 1.0
	PublicEndpoint  string    `json:"public_endpoint"` // IP:Port for WebRTC/QUIC P2P
	NATType         string    `json:"nat_type"` // FullCone, Symmetric, Restricted
	IsOnline        bool      `json:"is_online"`
	LastHeartbeat   time.Time `json:"last_heartbeat"`
}

// TrainingRoundDocument models a global Federated Averaging round in Cosmos DB.
type TrainingRoundDocument struct {
	ID                     string    `json:"id"`
	RoundID                int       `json:"round_id"`
	BaseVersion            string    `json:"base_version"`
	TargetVersion          string    `json:"target_version"`
	GlobalLoss             float64   `json:"global_loss"`
	TotalTflops            float64   `json:"total_tflops"`
	ParticipantNodeIDs     []string  `json:"participant_node_ids"`
	AggregatedWeightsBlob  string    `json:"aggregated_weights_blob_uri"` // Azure Blob Storage URL
	AggregatedWeightsHash  string    `json:"aggregated_weights_hash"`
	Status                 string    `json:"status"` // "ACTIVE", "AGGREGATING", "FINALIZED"
	CreatedAt              time.Time `json:"created_at"`
	CompletedAt            time.Time `json:"completed_at"`
}

// WalletDocument models sovereign balances and compute earnings in Cosmos DB.
type WalletDocument struct {
	ID                  string    `json:"id"` // Same as Address
	Address             string    `json:"address"` // swp_...
	SWPBalance          float64   `json:"swp_balance"`
	TotalEarnedTflops   float64   `json:"total_earned_tflops"`
	ValidatedProofCount int64     `json:"validated_proof_count"`
	LastProofHash       string    `json:"last_proof_hash"`
	LastUpdated         time.Time `json:"last_updated"`
}

// ProofOfComputeDocument records cryptographically verified GPU work.
type ProofOfComputeDocument struct {
	ID             string    `json:"id"`
	RoundID        int       `json:"round_id"`
	NodeID         string    `json:"node_id"`
	DeltaHash      string    `json:"delta_hash"`
	TflopsComputed float64   `json:"tflops_computed"`
	RewardSWP      float64   `json:"reward_swp"`
	Signature      string    `json:"signature"`
	Verified       bool      `json:"verified"`
	Timestamp      time.Time `json:"timestamp"`
}

// ModelCheckpointMeta represents downloadable model weights in Azure Blob Storage.
type ModelCheckpointMeta struct {
	Version      string    `json:"version"`
	BlobURI      string    `json:"blob_uri"`
	SHA256Hash   string    `json:"sha256_hash"`
	SizeBytes    int64     `json:"size_bytes"`
	Loss         float64   `json:"loss"`
	PublishedAt  time.Time `json:"published_at"`
}

// PostgreSQLSchemaDDL provides relational production DDL for Azure Database for PostgreSQL.
const PostgreSQLSchemaDDL = `
-- ============================================================================
-- SWYPIKOS AZURE POSTGRESQL PRODUCTION RELATIONAL SCHEMA
-- ============================================================================

CREATE TABLE IF NOT EXISTS swarm_nodes (
    id VARCHAR(64) PRIMARY KEY,
    address VARCHAR(64) NOT NULL,
    available_tflops NUMERIC(8, 3) NOT NULL DEFAULT 0.000,
    ilaria_version VARCHAR(32) NOT NULL DEFAULT 'ilaria-v1.0',
    gpu_model VARCHAR(128) NOT NULL,
    reputation_score NUMERIC(4, 3) NOT NULL DEFAULT 1.000,
    public_endpoint VARCHAR(128) NOT NULL,
    nat_type VARCHAR(32) NOT NULL DEFAULT 'FullCone',
    is_online BOOLEAN NOT NULL DEFAULT true,
    last_heartbeat TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_swarm_nodes_heartbeat ON swarm_nodes(last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_swarm_nodes_online ON swarm_nodes(is_online, available_tflops DESC);

CREATE TABLE IF NOT EXISTS training_rounds (
    round_id INT PRIMARY KEY,
    base_version VARCHAR(32) NOT NULL,
    target_version VARCHAR(32) NOT NULL,
    global_loss NUMERIC(8, 4) NOT NULL,
    total_tflops NUMERIC(12, 3) NOT NULL,
    participant_count INT NOT NULL DEFAULT 0,
    aggregated_weights_blob_uri TEXT NOT NULL,
    aggregated_weights_hash VARCHAR(64) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_training_rounds_status ON training_rounds(status);

CREATE TABLE IF NOT EXISTS wallets (
    address VARCHAR(64) PRIMARY KEY,
    swp_balance NUMERIC(16, 6) NOT NULL DEFAULT 0.000000,
    total_earned_tflops NUMERIC(16, 3) NOT NULL DEFAULT 0.000,
    validated_proof_count BIGINT NOT NULL DEFAULT 0,
    last_proof_hash VARCHAR(64),
    last_updated TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS proof_of_computes (
    id VARCHAR(64) PRIMARY KEY,
    round_id INT NOT NULL REFERENCES training_rounds(round_id),
    node_id VARCHAR(64) NOT NULL REFERENCES swarm_nodes(id),
    delta_hash VARCHAR(64) NOT NULL,
    tflops_computed NUMERIC(8, 3) NOT NULL,
    reward_swp NUMERIC(12, 6) NOT NULL,
    signature VARCHAR(128) NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT true,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_poc_round_node ON proof_of_computes(round_id, node_id);
`
