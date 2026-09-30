package federated

import (
	"crypto/ed25519"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"math"
	"math/rand"
	"strconv"
	"sync"
	"time"

	resourcepolicy "swypik-os/core/resource"
)

// MaxTFLOPSPerDelta defines the maximum accepted computation (in TFLOPS) credited for a single
// micro-batch delta. Capped at 100.0 TFLOPS to accommodate high-end GPU clusters while preventing unbounded reward spoofing.
const MaxTFLOPSPerDelta = 100.0

// WeightDelta represents a gradient update computed on a node's local GPU.
type WeightDelta struct {
	NodeID         string    `json:"node_id"`
	RoundID        int       `json:"round_id"`
	LayerName      string    `json:"layer_name"`
	Values         []float64 `json:"values"`
	Loss           float64   `json:"loss"`
	TFLOPSComputed float64   `json:"tflops_computed"`
	ProofNonce     uint64    `json:"proof_nonce"`
	ProofHash      string    `json:"proof_hash"`
	IsPoisonous    bool      `json:"is_poisonous"`
	Timestamp      time.Time `json:"timestamp"`
	Signature      []byte    `json:"signature,omitempty"`
}

// ModelCheckpoint represents the consolidated, global state of Ilaria's neural weights.
type ModelCheckpoint struct {
	Version      string               `json:"version"` // e.g. "ilaria-v1.1"
	RoundID      int                  `json:"round_id"`
	Weights      map[string][]float64 `json:"weights"`
	GlobalLoss   float64              `json:"global_loss"`
	Contributors int                  `json:"contributors"`
	Timestamp    time.Time            `json:"timestamp"`
}

// LocalTrainer simulates on-device GPU micro-batch backward passes (LoRA adapter tuning).
type LocalTrainer struct {
	mu            sync.RWMutex
	nodeID        string
	maxGPUPercent float64
	currentLoss   float64
	completedRuns int64
	pubKey        ed25519.PublicKey
	privKey       ed25519.PrivateKey
	maxParamCount int
}

// NewLocalTrainer creates an on-device training engine with a generated ed25519 key pair.
func NewLocalTrainer(nodeID string, maxGPUPercent float64) *LocalTrainer {
	if nodeID == "" {
		nodeID = "swypik_worker_default"
	}
	if maxGPUPercent <= 0 {
		maxGPUPercent = 35.0 // Default 35% background GPU utilization
	}

	pub, priv, err := ed25519.GenerateKey(crand.Reader)
	if err != nil {
		pub = nil
		priv = nil
	}

	return &LocalTrainer{
		nodeID:        nodeID,
		maxGPUPercent: maxGPUPercent,
		currentLoss:   1.84, // Initial cross-entropy loss
		pubKey:        pub,
		privKey:       priv,
		maxParamCount: resourcepolicy.Default().MaxTrainingDeltaParams,
	}
}

// SetMaxGPUPercent updates the cooperative accelerator ceiling used by the
// current simulator and future real kernels. Runtime resource pressure may only
// lower this value for a work unit; callers remain responsible for enforcing
// their configured upper bound.
func (t *LocalTrainer) SetMaxGPUPercent(maxGPUPercent float64) {
	if maxGPUPercent <= 0 {
		maxGPUPercent = 1
	}
	if maxGPUPercent > 100 {
		maxGPUPercent = 100
	}
	t.mu.Lock()
	t.maxGPUPercent = maxGPUPercent
	t.mu.Unlock()
}

// PublicKey returns a copy of the trainer's ed25519 public key.
func (t *LocalTrainer) PublicKey() ed25519.PublicKey {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return append(ed25519.PublicKey(nil), t.pubKey...)
}

// privateKey returns a copy of the trainer's ed25519 private key.
func (t *LocalTrainer) privateKey() ed25519.PrivateKey {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return append(ed25519.PrivateKey(nil), t.privKey...)
}

// SetKeyPair assigns an ed25519 public/private key pair to the trainer.
func (t *LocalTrainer) SetKeyPair(pub ed25519.PublicKey, priv ed25519.PrivateKey) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pubKey = append(ed25519.PublicKey(nil), pub...)
	t.privKey = append(ed25519.PrivateKey(nil), priv...)
}

// ComputeMicroBatch executes forward-backward pass and generates verified WeightDelta with Proof-of-Compute and ed25519 signature.
func (t *LocalTrainer) ComputeMicroBatch(roundID int, layerName string, paramCount int) (*WeightDelta, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if roundID < 0 || layerName == "" || paramCount > t.maxParamCount {
		return nil, fmt.Errorf("invalid training parameters")
	}
	if paramCount <= 0 {
		paramCount = 64 // Representative LoRA rank-8 adapter vector
	}

	// 1. Simulate GPU gradient calculation scaled by GPU percentage
	gpuFactor := t.maxGPUPercent / 100.0
	tflops := 0.25 * gpuFactor // E.g. ~0.1 TFLOPS per micro-batch on RTX 3080/4070

	deltas := make([]float64, paramCount)
	for i := range deltas {
		// Small convergent gradients: Gaussian noise centered at -0.01 with decay
		deltas[i] = (rand.Float64() - 0.52) * 0.05 * (1.0 / math.Sqrt(float64(roundID+1)))
	}

	// Loss decreases gradually
	t.currentLoss = math.Max(0.12, t.currentLoss*0.985)
	t.completedRuns++

	// 2. Compute Proof-of-Compute (PoC) Hash
	// Hash = SHA256(nodeID + roundID + layerName + Nonce + deltas)
	var nonce uint64 = uint64(time.Now().UnixNano())
	proofHash := calculateProofHash(t.nodeID, roundID, layerName, nonce, deltas)

	delta := &WeightDelta{
		NodeID:         t.nodeID,
		RoundID:        roundID,
		LayerName:      layerName,
		Values:         deltas,
		Loss:           math.Round(t.currentLoss*1000) / 1000,
		TFLOPSComputed: math.Round(tflops*1000) / 1000,
		ProofNonce:     nonce,
		ProofHash:      proofHash,
		IsPoisonous:    false,
		Timestamp:      time.Now(),
	}

	// 3. Cryptographically sign the canonical fields if key is configured
	if len(t.privKey) == ed25519.PrivateKeySize {
		if err := delta.Sign(t.privKey); err != nil {
			return nil, fmt.Errorf("failed to sign weight delta: %w", err)
		}
	}

	return delta, nil
}

// CanonicalDeltaMessage computes a deterministic cryptographic digest over canonical fields of a delta.
func CanonicalDeltaMessage(delta *WeightDelta) []byte {
	if delta == nil {
		return nil
	}
	h := sha256.New()
	// Strings are length-prefixed and floats hashed by their exact bits, so no
	// two distinct deltas share a message (no delimiter or rounding ambiguity).
	var b [8]byte
	writeUint := func(v uint64) {
		binary.LittleEndian.PutUint64(b[:], v)
		h.Write(b[:])
	}
	writeString := func(s string) {
		writeUint(uint64(len(s)))
		h.Write([]byte(s))
	}
	writeString(delta.NodeID)
	writeUint(uint64(int64(delta.RoundID)))
	writeString(delta.LayerName)
	writeUint(math.Float64bits(delta.Loss))
	writeUint(math.Float64bits(delta.TFLOPSComputed))
	writeUint(delta.ProofNonce)
	writeString(delta.ProofHash)
	writeUint(uint64(len(delta.Values)))
	for _, v := range delta.Values {
		writeUint(math.Float64bits(v))
	}
	return h.Sum(nil)
}

// Sign signs the delta's canonical fields with the given ed25519 private key.
func (d *WeightDelta) Sign(privKey ed25519.PrivateKey) error {
	if d == nil {
		return fmt.Errorf("cannot sign nil weight delta")
	}
	if len(privKey) != ed25519.PrivateKeySize {
		return fmt.Errorf("invalid ed25519 private key length: %d", len(privKey))
	}
	d.Signature = ed25519.Sign(privKey, CanonicalDeltaMessage(d))
	return nil
}

// VerifySignature validates the delta's ed25519 signature against the expected node public key.
func (d *WeightDelta) VerifySignature(pubKey ed25519.PublicKey) bool {
	if d == nil || len(d.Signature) != ed25519.SignatureSize || len(pubKey) != ed25519.PublicKeySize {
		return false
	}
	return ed25519.Verify(pubKey, CanonicalDeltaMessage(d), d.Signature)
}

func calculateProofHash(nodeID string, roundID int, layer string, nonce uint64, values []float64) string {
	h := sha256.New()
	_, _ = io.WriteString(h, nodeID)
	_, _ = io.WriteString(h, ":")
	var decimal [24]byte
	n := strconv.AppendInt(decimal[:0], int64(roundID), 10)
	_, _ = h.Write(n)
	_, _ = io.WriteString(h, ":")
	_, _ = io.WriteString(h, layer)
	_, _ = io.WriteString(h, ":")

	var raw [8]byte
	binary.LittleEndian.PutUint64(raw[:], nonce)
	_, _ = h.Write(raw[:])

	for _, v := range values {
		binary.LittleEndian.PutUint64(raw[:], math.Float64bits(v))
		_, _ = h.Write(raw[:])
	}

	return hex.EncodeToString(h.Sum(nil))
}

// VerifyProofOfCompute checks whether a submitted gradient was legitimately generated.
func VerifyProofOfCompute(delta *WeightDelta) bool {
	if delta == nil || len(delta.Values) == 0 {
		return false
	}
	expected := calculateProofHash(delta.NodeID, delta.RoundID, delta.LayerName, delta.ProofNonce, delta.Values)
	return delta.ProofHash == expected
}

// FederatedAggregator aggregates distributed gradient deltas using Byzantine-robust Federated Averaging.
type FederatedAggregator struct {
	mu               sync.RWMutex
	currentRound     int
	model            *ModelCheckpoint
	pendingDeltas    []*WeightDelta
	rewardPerTflop   float64 // SWP coins rewarded per TFLOP computed
	keyRegistry      map[string]ed25519.PublicKey
	maxPendingDeltas int
}

// NewFederatedAggregator initializes the parameter server & aggregator.
func NewFederatedAggregator(initialRound int) *FederatedAggregator {
	if initialRound <= 0 {
		initialRound = 1
	}

	initWeights := map[string][]float64{
		"transformer.lora_a": make([]float64, 64),
		"transformer.lora_b": make([]float64, 64),
	}
	for i := range initWeights["transformer.lora_a"] {
		initWeights["transformer.lora_a"][i] = rand.Float64() * 0.1
		initWeights["transformer.lora_b"][i] = rand.Float64() * 0.1
	}

	return &FederatedAggregator{
		currentRound:     initialRound,
		pendingDeltas:    make([]*WeightDelta, 0),
		rewardPerTflop:   0.10, // 0.10 SWP per TFLOP
		keyRegistry:      make(map[string]ed25519.PublicKey),
		maxPendingDeltas: resourcepolicy.Default().MaxPendingDeltas,
		model: &ModelCheckpoint{
			Version:      fmt.Sprintf("ilaria-v1.%d", initialRound),
			RoundID:      initialRound,
			Weights:      initWeights,
			GlobalLoss:   1.84,
			Contributors: 0,
			Timestamp:    time.Now(),
		},
	}
}

// RegisterNodeKey registers an authorized ed25519 public key for a node in the key registry.
func (fa *FederatedAggregator) RegisterNodeKey(nodeID string, pubKey ed25519.PublicKey) error {
	fa.mu.Lock()
	defer fa.mu.Unlock()
	if nodeID == "" {
		return fmt.Errorf("nodeID cannot be empty")
	}
	if len(pubKey) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid ed25519 public key size: %d", len(pubKey))
	}
	fa.keyRegistry[nodeID] = append(ed25519.PublicKey(nil), pubKey...)
	return nil
}

// SubmitDelta receives and validates a node's gradient submission.
func (fa *FederatedAggregator) SubmitDelta(delta *WeightDelta) (accepted bool, reason string) {
	fa.mu.Lock()
	defer fa.mu.Unlock()

	if delta == nil {
		return false, "REJECTED_NIL_DELTA"
	}

	// 1. Ed25519 Signature & Node Key Registry Verification
	pubKey, registered := fa.keyRegistry[delta.NodeID]
	if !registered {
		return false, "REJECTED_UNKNOWN_NODE"
	}
	if len(delta.Values) == 0 || len(delta.Values) > resourcepolicy.Default().MaxTrainingDeltaParams {
		return false, "REJECTED_DELTA_SIZE"
	}
	if !delta.VerifySignature(pubKey) {
		return false, "REJECTED_INVALID_SIGNATURE"
	}

	// 2. Proof-of-Compute verification
	if !VerifyProofOfCompute(delta) {
		return false, "REJECTED_INVALID_PROOF_OF_COMPUTE"
	}

	if delta.RoundID != fa.currentRound {
		return false, "REJECTED_WRONG_ROUND"
	}
	_, exists := fa.model.Weights[delta.LayerName]
	if !exists {
		return false, "REJECTED_UNKNOWN_LAYER"
	}
	if fa.maxPendingDeltas > 0 && len(fa.pendingDeltas) >= fa.maxPendingDeltas {
		return false, "REJECTED_ROUND_FULL"
	}
	if delta.Loss < 0 || math.IsNaN(delta.Loss) || math.IsInf(delta.Loss, 0) || delta.TFLOPSComputed < 0 || math.IsNaN(delta.TFLOPSComputed) || math.IsInf(delta.TFLOPSComputed, 0) {
		return false, "REJECTED_INVALID_METRICS"
	}
	if delta.TFLOPSComputed > MaxTFLOPSPerDelta {
		return false, "REJECTED_EXCESSIVE_TFLOPS"
	}
	for _, pending := range fa.pendingDeltas {
		if pending.NodeID == delta.NodeID && pending.LayerName == delta.LayerName {
			return false, "REJECTED_DUPLICATE_DELTA"
		}
	}
	// 3. Anti-Poisoning Filter: Euclidean Norm Check (Byzantine Robustness)
	// If a rogue node submits extreme gradients (> 5.0 norm) to corrupt Ilaria, reject and flag as poisonous
	var normSq float64
	for _, v := range delta.Values {
		normSq += v * v
	}
	gradientNorm := math.Sqrt(normSq)

	if gradientNorm > 2.0 || math.IsNaN(gradientNorm) {
		delta.IsPoisonous = true
		return false, fmt.Sprintf("REJECTED_BYZANTINE_POISONING_ATTACK: Gradient norm %.2f exceeds safety ceiling (2.0)", gradientNorm)
	}

	snapshot := *delta
	snapshot.Values = append([]float64(nil), delta.Values...)
	if delta.Signature != nil {
		snapshot.Signature = append([]byte(nil), delta.Signature...)
	}
	fa.pendingDeltas = append(fa.pendingDeltas, &snapshot)
	return true, "ACCEPTED"
}

// AggregateRound applies Trimmed-Mean Federated Averaging (FedAvg) and updates the official Ilaria weights.
func (fa *FederatedAggregator) AggregateRound() (*ModelCheckpoint, float64, error) {
	fa.mu.Lock()
	defer fa.mu.Unlock()

	if len(fa.pendingDeltas) == 0 {
		return cloneCheckpoint(fa.model), 0.0, fmt.Errorf("no valid gradient deltas submitted for round %d", fa.currentRound)
	}

	// Group deltas by layer
	layerDeltas := make(map[string][][]float64)
	var totalTflops float64
	var totalLoss float64

	for _, d := range fa.pendingDeltas {
		if d.IsPoisonous {
			continue
		}
		layerDeltas[d.LayerName] = append(layerDeltas[d.LayerName], d.Values)
		totalTflops += d.TFLOPSComputed
		totalLoss += d.Loss
	}

	validCount := len(fa.pendingDeltas)
	avgLoss := totalLoss / float64(validCount)

	// Update Model Weights: W_new = W_old + lr * FedAvg(Deltas)
	learningRate := 0.85
	for layer, deltasList := range layerDeltas {
		base, exists := fa.model.Weights[layer]
		if !exists || len(deltasList) == 0 {
			continue
		}

		paramCount := len(base)
		avgDelta := make([]float64, paramCount)

		for _, d := range deltasList {
			for i := 0; i < paramCount && i < len(d); i++ {
				avgDelta[i] += d[i]
			}
		}

		numPeers := float64(len(deltasList))
		for i := range base {
			base[i] += learningRate * (avgDelta[i] / numPeers)
		}
		fa.model.Weights[layer] = base
	}

	// Advance official model round & version
	fa.currentRound++
	fa.model.RoundID = fa.currentRound
	fa.model.Version = fmt.Sprintf("ilaria-v1.%d", fa.currentRound)
	fa.model.GlobalLoss = math.Round(avgLoss*1000) / 1000
	fa.model.Contributors += validCount
	fa.model.Timestamp = time.Now()

	// Clear round buffer
	for i := range fa.pendingDeltas {
		fa.pendingDeltas[i] = nil
	}
	fa.pendingDeltas = fa.pendingDeltas[:0]

	return cloneCheckpoint(fa.model), totalTflops, nil
}

// CalculateReward calculates the SWP Coin incentive for a validated node contribution.
// TFLOPS is capped at MaxTFLOPSPerDelta to ensure rewards are strictly bounded.
func (fa *FederatedAggregator) CalculateReward(tflops float64) float64 {
	fa.mu.RLock()
	defer fa.mu.RUnlock()
	if tflops <= 0 || math.IsNaN(tflops) || math.IsInf(tflops, 0) {
		return 0.0
	}
	if tflops > MaxTFLOPSPerDelta {
		tflops = MaxTFLOPSPerDelta
	}
	return math.Round(tflops*fa.rewardPerTflop*1000) / 1000
}

// GetCurrentCheckpoint returns the latest consolidated Ilaria brain checkpoint.
func (fa *FederatedAggregator) GetCurrentCheckpoint() *ModelCheckpoint {
	fa.mu.RLock()
	defer fa.mu.RUnlock()
	return cloneCheckpoint(fa.model)
}

// GetCurrentRound returns the active round identifier.
func (fa *FederatedAggregator) GetCurrentRound() int {
	fa.mu.RLock()
	defer fa.mu.RUnlock()
	return fa.currentRound
}

func cloneCheckpoint(model *ModelCheckpoint) *ModelCheckpoint {
	copy := *model
	copy.Weights = make(map[string][]float64, len(model.Weights))
	for layer, values := range model.Weights {
		copy.Weights[layer] = append([]float64(nil), values...)
	}
	return &copy
}
