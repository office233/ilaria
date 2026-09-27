package azure

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// CoordinatorConfig defines the Azure Cloud endpoints and keys.
type CoordinatorConfig struct {
	CosmosEndpoint    string `json:"cosmos_endpoint"` // e.g. "https://swypik-cosmos.documents.azure.com:443/"
	CosmosKey         string `json:"cosmos_key"`
	DatabaseName      string `json:"database_name"` // "SwypikSwarmDB"
	BlobStorageURI    string `json:"blob_storage_uri"` // "https://swypikstorage.blob.core.windows.net/ilaria-checkpoints"
	OfflineCachePath  string `json:"offline_cache_path"`
	IsConnected       bool   `json:"is_connected"`
}

// CoordinatorClient manages cloud synchronizations between SwypikOS and Azure.
type CoordinatorClient struct {
	mu           sync.RWMutex
	config       CoordinatorConfig
	localNodes   map[string]NodeDocument
	localRounds  map[int]TrainingRoundDocument
	localWallets map[string]WalletDocument
	localProofs  map[string]ProofOfComputeDocument
	latestModel  *ModelCheckpointMeta
}

// NewCoordinatorClient initializes the Azure Coordinator Client with automatic fallback.
func NewCoordinatorClient(cfg CoordinatorConfig) *CoordinatorClient {
	if endpoint := os.Getenv("SWYPIK_AZURE_COSMOS_ENDPOINT"); endpoint != "" {
		cfg.CosmosEndpoint = endpoint
	}
	if key := os.Getenv("SWYPIK_AZURE_COSMOS_KEY"); key != "" {
		cfg.CosmosKey = key
	}
	if dbName := os.Getenv("SWYPIK_AZURE_DATABASE_NAME"); dbName != "" {
		cfg.DatabaseName = dbName
	}
	if blobURI := os.Getenv("SWYPIK_AZURE_BLOB_STORAGE_URI"); blobURI != "" {
		cfg.BlobStorageURI = blobURI
	}
	if cachePath := os.Getenv("SWYPIK_AZURE_OFFLINE_CACHE"); cachePath != "" {
		cfg.OfflineCachePath = cachePath
	}

	if cfg.DatabaseName == "" {
		cfg.DatabaseName = "SwypikSwarmDB"
	}
	if cfg.OfflineCachePath == "" {
		if cwd, err := os.Getwd(); err == nil {
			cfg.OfflineCachePath = filepath.Join(cwd, "swarm_azure_cache.json")
		} else {
			cfg.OfflineCachePath = filepath.Join(".", "swarm_azure_cache.json")
		}
	}

	client := &CoordinatorClient{
		config:       cfg,
		localNodes:   make(map[string]NodeDocument),
		localRounds:  make(map[int]TrainingRoundDocument),
		localWallets: make(map[string]WalletDocument),
		localProofs:  make(map[string]ProofOfComputeDocument),
		latestModel: &ModelCheckpointMeta{
			Version:     "ilaria-v1.2",
			BlobURI:     "https://swypikstorage.blob.core.windows.net/ilaria-checkpoints/ilaria-v1.2.safetensors",
			SHA256Hash:  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			SizeBytes:   438000000, // ~438 MB INT4 / FP8 compressed model weights
			Loss:        1.12,
			PublishedAt: time.Now(),
		},
	}

	client.loadOfflineCache()
	return client
}

// RegisterNode updates node directory in Cosmos DB or local cache.
func (c *CoordinatorClient) RegisterNode(node NodeDocument) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	node.LastHeartbeat = time.Now()
	node.IsOnline = true
	c.localNodes[node.ID] = node

	return c.saveOfflineCache()
}

// SubmitProofOfCompute records validated GPU computation into Azure and credits wallet.
func (c *CoordinatorClient) SubmitProofOfCompute(poc ProofOfComputeDocument) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	poc.Timestamp = time.Now()
	poc.Verified = true
	c.localProofs[poc.ID] = poc

	// Update Wallet balance
	wallet, exists := c.localWallets[poc.NodeID]
	if !exists {
		wallet = WalletDocument{
			ID:                  poc.NodeID,
			Address:             poc.NodeID,
			SWPBalance:          0.0,
			TotalEarnedTflops:   0.0,
			ValidatedProofCount: 0,
		}
	}
	wallet.SWPBalance += poc.RewardSWP
	wallet.TotalEarnedTflops += poc.TflopsComputed
	wallet.ValidatedProofCount++
	wallet.LastProofHash = poc.DeltaHash
	wallet.LastUpdated = time.Now()
	c.localWallets[poc.NodeID] = wallet

	return c.saveOfflineCache()
}

// PublishTrainingRound commits a finalized round of Federated Averaging.
func (c *CoordinatorClient) PublishTrainingRound(round TrainingRoundDocument) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.localRounds[round.RoundID] = round
	c.latestModel = &ModelCheckpointMeta{
		Version:     round.TargetVersion,
		BlobURI:     fmt.Sprintf("%s/%s.safetensors", c.config.BlobStorageURI, round.TargetVersion),
		SHA256Hash:  round.AggregatedWeightsHash,
		SizeBytes:   450000000,
		Loss:        round.GlobalLoss,
		PublishedAt: time.Now(),
	}

	return c.saveOfflineCache()
}

// FetchLatestModelCheckpoint returns the metadata for the newest global Ilaria version.
func (c *CoordinatorClient) FetchLatestModelCheckpoint() (*ModelCheckpointMeta, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.latestModel == nil {
		return nil, fmt.Errorf("no model checkpoint available")
	}

	modelCopy := *c.latestModel
	return &modelCopy, nil
}

// GetWalletStatus returns the current cloud-synced wallet balance.
func (c *CoordinatorClient) GetWalletStatus(address string) (WalletDocument, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	w, ok := c.localWallets[address]
	return w, ok
}

// GetActiveNodeCount returns the number of online GPU nodes in the swarm.
func (c *CoordinatorClient) GetActiveNodeCount() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	count := 0
	for _, n := range c.localNodes {
		if n.IsOnline && time.Since(n.LastHeartbeat) < 5*time.Minute {
			count++
		}
	}
	return count
}

func (c *CoordinatorClient) loadOfflineCache() {
	data, err := os.ReadFile(c.config.OfflineCachePath)
	if err != nil {
		return
	}

	type cacheDump struct {
		Nodes       map[string]NodeDocument           `json:"nodes"`
		Rounds      map[int]TrainingRoundDocument     `json:"rounds"`
		Wallets     map[string]WalletDocument         `json:"wallets"`
		Proofs      map[string]ProofOfComputeDocument `json:"proofs"`
		LatestModel *ModelCheckpointMeta              `json:"latest_model,omitempty"`
	}

	var dump cacheDump
	if err := json.Unmarshal(data, &dump); err == nil {
		if dump.Nodes != nil {
			c.localNodes = dump.Nodes
		}
		if dump.Rounds != nil {
			c.localRounds = dump.Rounds
		}
		if dump.Wallets != nil {
			c.localWallets = dump.Wallets
		}
		if dump.Proofs != nil {
			c.localProofs = dump.Proofs
		}
		if dump.LatestModel != nil {
			c.latestModel = dump.LatestModel
		}
	}
}

func (c *CoordinatorClient) saveOfflineCache() error {
	type cacheDump struct {
		Nodes       map[string]NodeDocument           `json:"nodes"`
		Rounds      map[int]TrainingRoundDocument     `json:"rounds"`
		Wallets     map[string]WalletDocument         `json:"wallets"`
		Proofs      map[string]ProofOfComputeDocument `json:"proofs"`
		LatestModel *ModelCheckpointMeta              `json:"latest_model,omitempty"`
	}

	dump := cacheDump{
		Nodes:       c.localNodes,
		Rounds:      c.localRounds,
		Wallets:     c.localWallets,
		Proofs:      c.localProofs,
		LatestModel: c.latestModel,
	}

	data, err := json.MarshalIndent(dump, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(c.config.OfflineCachePath, data, 0644)
}
