package federated

import (
	"strings"
	"testing"
)

func TestFederatedLearningAndPoC(t *testing.T) {
	// 1. Test Local GPU Micro-Batch Generation
	trainer := NewLocalTrainer("worker_rtx_4070_node", 40.0) // 40% GPU allocation
	delta, err := trainer.ComputeMicroBatch(1, "transformer.lora_a", 32)
	if err != nil {
		t.Fatalf("Micro-batch computation failed: %v", err)
	}

	if len(delta.Values) != 32 || delta.TFLOPSComputed <= 0 || delta.Loss <= 0 {
		t.Errorf("Invalid delta structure: %+v", delta)
	}

	// 2. Test Proof-of-Compute Verification
	if !VerifyProofOfCompute(delta) {
		t.Errorf("Legitimate Proof-of-Compute failed validation")
	}

	// Tampering test: altering a gradient value should immediately fail PoC
	tamperedValues := make([]float64, len(delta.Values))
	copy(tamperedValues, delta.Values)
	tamperedValues[0] += 1.0
	tamperedDelta := *delta
	tamperedDelta.Values = tamperedValues
	if VerifyProofOfCompute(&tamperedDelta) {
		t.Errorf("Tampered gradient unexpectedly passed Proof-of-Compute verification")
	}

	// 3. Test Federated Aggregator & Byzantine Poisoning Filter
	aggregator := NewFederatedAggregator(1)

	// Valid submission from Worker 1
	accepted, reason := aggregator.SubmitDelta(delta)
	if !accepted {
		t.Errorf("Expected valid delta to be accepted: %s", reason)
	}

	// Valid submission from Worker 2 (RTX 3080)
	trainer2 := NewLocalTrainer("worker_rtx_3080_node", 50.0)
	delta2, _ := trainer2.ComputeMicroBatch(1, "transformer.lora_a", 32)
	accepted, _ = aggregator.SubmitDelta(delta2)
	if !accepted {
		t.Errorf("Expected Worker 2 delta to be accepted")
	}

	// Malicious Byzantine Poisoning Attack:
	// Rogue node attempts to inject massive destabilizing gradients (+50.0)
	trainerRogue := NewLocalTrainer("rogue_cheat_node", 10.0)
	maliciousDelta, _ := trainerRogue.ComputeMicroBatch(1, "transformer.lora_a", 32)
	for i := range maliciousDelta.Values {
		maliciousDelta.Values[i] = 50.0 // Massive gradient perturbation
	}
	// Recompute proof so PoC check passes, but norm filter must catch it
	maliciousDelta.ProofHash = calculateProofHash(maliciousDelta.NodeID, maliciousDelta.RoundID, maliciousDelta.LayerName, maliciousDelta.ProofNonce, maliciousDelta.Values)

	acceptedMalicious, reasonMalicious := aggregator.SubmitDelta(maliciousDelta)
	if acceptedMalicious {
		t.Errorf("Byzantine anti-poisoning filter failed: rogue gradient was accepted!")
	}
	if !strings.Contains(reasonMalicious, "POISONING_ATTACK") {
		t.Errorf("Expected poisoning rejection reason, got: %s", reasonMalicious)
	}

	// 4. Test Federated Averaging Round Aggregation
	checkpoint, totalTflops, err := aggregator.AggregateRound()
	if err != nil {
		t.Fatalf("Round aggregation failed: %v", err)
	}

	if checkpoint.RoundID != 2 || checkpoint.Version != "ilaria-v1.2" {
		t.Errorf("Expected model to advance to ilaria-v1.2, got: %s (Round %d)", checkpoint.Version, checkpoint.RoundID)
	}
	if checkpoint.Contributors != 2 {
		t.Errorf("Expected exactly 2 valid contributors (rogue excluded), got: %d", checkpoint.Contributors)
	}
	if totalTflops <= 0 {
		t.Errorf("Expected positive total TFLOPS aggregated, got: %.3f", totalTflops)
	}

	// 5. Test SWP Reward Calculation
	reward := aggregator.CalculateReward(0.50) // 0.5 TFLOPS
	if reward <= 0 || reward != 0.05 {
		t.Errorf("Expected 0.05 SWP reward for 0.5 TFLOPS, got: %.3f", reward)
	}

	// 6. Test P2P Transport Mesh
	mesh := NewTransportMesh("local_node", "NVIDIA RTX 4070")
	peer1 := &PeerNode{
		NodeID:   "worker_rtx_3080_node",
		GPUModel: "NVIDIA RTX 3080",
		TFLOPS:   29.7,
		Endpoint: "192.168.1.100:9988",
		NATType:  "FullCone",
	}
	mesh.RegisterPeer(peer1)

	peers := mesh.GetPeers()
	if len(peers) != 1 || peers[0].Reputation != 1.0 {
		t.Errorf("Failed to retrieve peer: %+v", peers)
	}

	// Broadcast test
	sent, err := mesh.BroadcastGradient(delta)
	if err != nil || sent != 1 {
		t.Errorf("Broadcast failed: sent=%d, err=%v", sent, err)
	}

	// Penalize rogue peer
	mesh.PenalizePeer(peer1.NodeID, 0.4)
	if peer1.Reputation != 0.6 {
		t.Errorf("Expected peer reputation to decay to 0.6, got: %.2f", peer1.Reputation)
	}
}

func TestDiLoCoAndElasticMesh(t *testing.T) {
	cfg := DiLoCoConfig{
		InnerSteps:     10, // Shortened for unit test
		InnerLR:        0.001,
		OuterLR:        0.7,
		OuterMomentum:  0.9,
		MinPeersActive: 1,
	}

	worker := NewDiLoCoWorker("node_gtx1660ti", "NVIDIA GeForce GTX 1660 Ti", 6144, 5.5, cfg)

	// Setup mock checkpoint
	weights := map[string][]float64{
		"transformer.lora_a": {0.1, 0.2, 0.3, 0.4},
	}
	cp := &ModelCheckpoint{
		Version: "ilaria-v1.0",
		RoundID: 1,
		Weights: weights,
	}
	worker.SyncBaseModel(cp)

	// Run inner steps
	var finished bool
	var prog float64
	for i := 0; i < 10; i++ {
		var err error
		finished, prog, err = worker.StepInner(map[string][]float64{"transformer.lora_a": {1, 2, 3, 4}})
		if err != nil {
			t.Fatal(err)
		}
	}

	if !finished || prog < 1.0 {
		t.Errorf("Expected DiLoCo inner loop to finish after 10 steps, finished=%v, prog=%.2f", finished, prog)
	}

	delta, err := worker.ComputeOuterPseudoGradient("transformer.lora_a")
	if err != nil || len(delta) != 4 {
		t.Fatalf("Failed to compute outer pseudo gradient: %v", err)
	}

	// Test ElasticDeviceMesh churn
	mesh := NewElasticDeviceMesh()
	mesh.RegisterOrUpdateWorker("node_gtx1660ti", "NVIDIA GeForce GTX 1660 Ti", 6144, 5.5, true, true)
	mesh.RegisterOrUpdateWorker("node_laptop_battery", "Integrated Graphics", 2048, 0.5, true, false) // on battery
	mesh.RegisterOrUpdateWorker("node_gaming_user", "RTX 4090", 24576, 82.6, false, true)             // user gaming (not idle)

	active := mesh.GetActiveWorkers()
	if len(active) != 1 || active[0].NodeID != "node_gtx1660ti" {
		t.Errorf("Expected exactly 1 active worker (idle and plugged into AC), got %d", len(active))
	}
}

func TestDisTrODeMoCompression(t *testing.T) {
	compressor := NewDeMoCompressor(0.05) // Keep top 5% (20x compression for 100 elements)

	values := make([]float64, 100)
	for i := 0; i < 100; i++ {
		values[i] = float64(i) * 0.01 // [0.0, 0.01, ..., 0.99]
	}

	cg := compressor.Compress("transformer.layer0", values)
	if cg == nil || cg.OriginalDim != 100 {
		t.Fatalf("Compression failed: %+v", cg)
	}
	if len(cg.TopKIndices) != 5 {
		t.Errorf("Expected 5 top indices for 5%% ratio, got %d", len(cg.TopKIndices))
	}
	if cg.CompressionRatio < 10.0 {
		t.Errorf("Expected significant compression ratio, got %.1f", cg.CompressionRatio)
	}

	// Decompress
	decompressed := compressor.Decompress(cg)
	if len(decompressed) != 100 {
		t.Errorf("Expected decompressed dimension 100, got %d", len(decompressed))
	}
	// Largest element (index 99) should be non-zero
	if decompressed[99] == 0 {
		t.Errorf("Expected top magnitude entry to be preserved in decompressed vector")
	}
}

func TestMultiKrumByzantineDefense(t *testing.T) {
	krum := NewMultiKrumAggregator(1, 1)

	// Create 5 deltas: 4 benign/cohesive, 1 malicious outlier (+100.0)
	deltas := make([]*WeightDelta, 5)
	for i := 0; i < 4; i++ {
		deltas[i] = &WeightDelta{
			NodeID: "good_node",
			Values: []float64{0.05 + float64(i)*0.01, -0.02, 0.01},
		}
	}
	deltas[4] = &WeightDelta{
		NodeID: "byzantine_attacker",
		Values: []float64{100.0, -100.0, 50.0},
	}

	selected, err := krum.SelectRobustDeltas(deltas)
	if err != nil {
		t.Fatalf("Krum selection failed: %v", err)
	}
	if len(selected) != 1 {
		t.Fatalf("Expected 1 robustly selected delta, got %d", len(selected))
	}
	if selected[0].NodeID == "byzantine_attacker" {
		t.Errorf("Multi-Krum failed: malicious attacker was selected!")
	}
}

func TestExoHeterogeneousPartitioner(t *testing.T) {
	partitioner := NewExoPartitioner()

	layers := []string{
		"layer1.q_proj", "layer1.k_proj", "layer1.v_proj",
		"layer2.q_proj", "layer2.k_proj", "layer2.v_proj",
	}

	nodes := []HeterogeneousHardwareProfile{
		{NodeID: "pc_gtx1660ti", GPUModel: "NVIDIA GTX 1660 Ti", VRAMMB: 6144, TFLOPS: 5.5},
		{NodeID: "server_rtx4090", GPUModel: "NVIDIA RTX 4090", VRAMMB: 24576, TFLOPS: 82.6},
	}

	assignments, err := partitioner.PartitionModel(layers, 32, nodes)
	if err != nil {
		t.Fatalf("Exo partitioning failed: %v", err)
	}
	if len(assignments) != 2 {
		t.Fatalf("Expected 2 assignments, got %d", len(assignments))
	}

	gtx := assignments[0]
	rtx := assignments[1]

	// RTX 4090 (24GB) should receive larger batch size than GTX 1660 Ti (6GB)
	if rtx.LocalBatchSize <= gtx.LocalBatchSize {
		t.Errorf("Expected RTX 4090 batch size (%d) to be larger than GTX 1660 Ti (%d)",
			rtx.LocalBatchSize, gtx.LocalBatchSize)
	}

	t.Logf("Exo Partitioning -> GTX 1660 Ti: Batch=%d, Layers=%v | RTX 4090: Batch=%d, Layers=%v",
		gtx.LocalBatchSize, gtx.AssignedLayers, rtx.LocalBatchSize, rtx.AssignedLayers)
}
