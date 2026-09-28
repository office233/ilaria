package azure

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAzureCoordinatorAndCosmosSchema(t *testing.T) {
	tempCache := filepath.Join(os.TempDir(), "swypik_azure_test_cache.json")
	defer os.Remove(tempCache)

	cfg := CoordinatorConfig{
		CosmosEndpoint:   "https://mock-swypik.documents.azure.com:443/",
		CosmosKey:        "MockKey==",
		DatabaseName:     "SwypikSwarmTestDB",
		BlobStorageURI:   "https://swypikstorage.blob.core.windows.net/ilaria-checkpoints",
		OfflineCachePath: tempCache,
	}

	client := NewCoordinatorClient(cfg)

	// 1. Test Node Registration
	node := NodeDocument{
		ID:              "node_rtx_4070_usr1",
		Address:         "swp_usr1_wallet_address",
		AvailableTflops: 29.5,
		IlariaVersion:   "ilaria-v1.0",
		GPUModel:        "NVIDIA GeForce RTX 4070",
		ReputationScore: 1.0,
		PublicEndpoint:  "86.120.44.18:9988",
		NATType:         "FullCone",
	}

	err := client.RegisterNode(node)
	if err != nil {
		t.Fatalf("Failed to register node: %v", err)
	}

	if client.GetActiveNodeCount() != 1 {
		t.Errorf("Expected 1 active node, got: %d", client.GetActiveNodeCount())
	}

	// 2. Test Proof-of-Compute submission & Wallet Crediting
	poc := ProofOfComputeDocument{
		ID:             "poc_tx_001",
		RoundID:        1,
		NodeID:         "node_rtx_4070_usr1",
		DeltaHash:      "a1b2c3d4e5f6",
		TflopsComputed: 0.25,
		RewardSWP:      0.025,
		Signature:      "SIG_TEST_POC_2026",
	}

	err = client.SubmitProofOfCompute(poc)
	if err != nil {
		t.Fatalf("Failed to submit PoC: %v", err)
	}

	wallet, found := client.GetWalletStatus("node_rtx_4070_usr1")
	if !found || wallet.SWPBalance != 0.025 || wallet.ValidatedProofCount != 1 {
		t.Errorf("Wallet was not credited accurately: %+v", wallet)
	}

	// 3. Test Training Round Publication and Model Checkpoint Sync
	round := TrainingRoundDocument{
		ID:                    "round_002",
		RoundID:               2,
		BaseVersion:           "ilaria-v1.0",
		TargetVersion:         "ilaria-v1.1",
		GlobalLoss:            0.985,
		TotalTflops:           142.5,
		ParticipantNodeIDs:    []string{"node_rtx_4070_usr1"},
		AggregatedWeightsBlob: "https://swypikstorage.blob.core.windows.net/ilaria-checkpoints/ilaria-v1.1.safetensors",
		AggregatedWeightsHash: "b4c5d6e7f8",
		Status:                "FINALIZED",
		CreatedAt:             time.Now().Add(-10 * time.Minute),
		CompletedAt:           time.Now(),
	}

	err = client.PublishTrainingRound(round)
	if err != nil {
		t.Fatalf("Failed to publish training round: %v", err)
	}

	latest, err := client.FetchLatestModelCheckpoint()
	if err != nil || latest.Version != "ilaria-v1.1" || latest.Loss != 0.985 {
		t.Errorf("Latest model checkpoint mismatch: %+v", latest)
	}

	// 4. Verify PostgreSQL Schema DDL
	if !strings.Contains(PostgreSQLSchemaDDL, "CREATE TABLE IF NOT EXISTS swarm_nodes") ||
		!strings.Contains(PostgreSQLSchemaDDL, "CREATE TABLE IF NOT EXISTS training_rounds") ||
		!strings.Contains(PostgreSQLSchemaDDL, "CREATE TABLE IF NOT EXISTS wallets") ||
		!strings.Contains(PostgreSQLSchemaDDL, "CREATE TABLE IF NOT EXISTS proof_of_computes") {
		t.Errorf("PostgreSQL DDL schema missing required table definitions")
	}

	// 5. Test Cache Persistence Reload
	reloadedClient := NewCoordinatorClient(cfg)
	if reloadedClient.GetActiveNodeCount() != 1 {
		t.Errorf("Reloaded client failed to restore active nodes from cache: %d", reloadedClient.GetActiveNodeCount())
	}
	rWallet, rFound := reloadedClient.GetWalletStatus("node_rtx_4070_usr1")
	if !rFound || rWallet.SWPBalance != 0.025 {
		t.Errorf("Reloaded client failed to restore wallet balance: %+v", rWallet)
	}
}
