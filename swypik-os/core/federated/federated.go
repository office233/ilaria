package federated

import (
	"crypto/ed25519"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"sync"
	"time"

	resourcepolicy "swypik-os/core/resource"
)

// MaxTFLOPSPerDelta bounds self-reported TFLOPS metadata on a single delta. It is a
// validation limit only: TFLOPS are never credited, paid or rewarded.
const MaxTFLOPSPerDelta = 100.0

const DeltaSignatureVersion = 1

// WeightDelta carries a candidate update with explicit evidence metadata.
// Signed contents prove authorship/integrity, not that training was performed.
type WeightDelta struct {
	NodeID           string    `json:"node_id"`
	RoundID          int       `json:"round_id"`
	LayerName        string    `json:"layer_name"`
	Values           []float64 `json:"values"`
	Loss             float64   `json:"loss"`
	TFLOPSComputed   float64   `json:"tflops_computed"`
	ProofNonce       uint64    `json:"proof_nonce"`
	ProofHash        string    `json:"proof_hash"`
	IsPoisonous      bool      `json:"is_poisonous"`
	Timestamp        time.Time `json:"timestamp"`
	Signature        []byte    `json:"signature,omitempty"`
	SignatureVersion int       `json:"signature_version,omitempty"`
	Evidence         string    `json:"evidence,omitempty"`
}

// ModelCheckpoint is a candidate snapshot, not a promoted Ilaria checkpoint.
type ModelCheckpoint struct {
	Version      string               `json:"version"` // e.g. "ilaria-v1.1"
	RoundID      int                  `json:"round_id"`
	Weights      map[string][]float64 `json:"weights"`
	GlobalLoss   float64              `json:"global_loss"`
	Contributors int                  `json:"contributors"`
	Timestamp    time.Time            `json:"timestamp"`
}

// LocalTrainer owns a signing identity and can run an explicitly configured
// synthetic simulation. Real IMC training belongs to Ilaria, not this OS package.
type LocalTrainer struct {
	mu            sync.RWMutex
	nodeID        string
	maxGPUPercent float64
	pubKey        ed25519.PublicKey
	privKey       ed25519.PrivateKey
	maxParamCount int
}

// NewLocalTrainer creates a signing identity; it does not enable synthetic work.
func NewLocalTrainer(nodeID string, maxGPUPercent float64) *LocalTrainer {
	maxGPUPercent = boundedGPUPercent(maxGPUPercent)

	pub, priv, err := ed25519.GenerateKey(crand.Reader)
	if err != nil {
		pub = nil
		priv = nil
	}

	return &LocalTrainer{
		nodeID:        nodeID,
		maxGPUPercent: maxGPUPercent,
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
	t.mu.Lock()
	t.maxGPUPercent = boundedGPUPercent(maxGPUPercent)
	t.mu.Unlock()
}

func boundedGPUPercent(percent float64) float64 {
	if math.IsNaN(percent) || math.IsInf(percent, 0) || percent <= 0 {
		return 0
	}
	return math.Min(percent, 100)
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
	writeString("swypik-candidate-delta-v1")
	writeUint(uint64(delta.SignatureVersion))
	writeString(delta.NodeID)
	writeUint(uint64(int64(delta.RoundID)))
	writeString(delta.LayerName)
	writeUint(math.Float64bits(delta.Loss))
	writeUint(math.Float64bits(delta.TFLOPSComputed))
	writeUint(delta.ProofNonce)
	writeString(delta.ProofHash)
	writeString(delta.Evidence)
	writeUint(uint64(delta.Timestamp.Unix()))
	writeUint(uint64(delta.Timestamp.Nanosecond()))
	if delta.IsPoisonous {
		writeUint(1)
	} else {
		writeUint(0)
	}
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
	if d.SignatureVersion != 0 && d.SignatureVersion != DeltaSignatureVersion {
		return fmt.Errorf("unsupported delta signature version")
	}
	d.SignatureVersion = DeltaSignatureVersion
	d.Signature = ed25519.Sign(privKey, CanonicalDeltaMessage(d))
	return nil
}

// VerifySignature validates the delta's ed25519 signature against the expected node public key.
func (d *WeightDelta) VerifySignature(pubKey ed25519.PublicKey) bool {
	if d == nil || d.SignatureVersion != DeltaSignatureVersion || len(d.Signature) != ed25519.SignatureSize || len(pubKey) != ed25519.PublicKeySize {
		return false
	}
	return ed25519.Verify(pubKey, CanonicalDeltaMessage(d), d.Signature)
}

func calculateProofHash(nodeID string, roundID int, layer string, nonce uint64, values []float64) string {
	h := sha256.New()
	var raw [8]byte
	writeUint := func(value uint64) {
		binary.LittleEndian.PutUint64(raw[:], value)
		h.Write(raw[:])
	}
	writeString := func(value string) {
		writeUint(uint64(len(value)))
		h.Write([]byte(value))
	}
	writeString("swypik-candidate-content-v1")
	writeString(nodeID)
	writeUint(uint64(int64(roundID)))
	writeString(layer)
	writeUint(nonce)
	writeUint(uint64(len(values)))
	for _, v := range values {
		writeUint(math.Float64bits(v))
	}

	return hex.EncodeToString(h.Sum(nil))
}

// VerifyDeltaIntegrity recomputes the delta's integrity hash over its signed fields.
// It proves message integrity only: not that any work was performed, not data
// provenance and not contribution quality (those need independent evaluation).
func VerifyDeltaIntegrity(delta *WeightDelta) bool {
	if delta == nil || len(delta.Values) == 0 || delta.RoundID < 0 || delta.NodeID == "" || delta.LayerName == "" ||
		delta.Loss < 0 || delta.TFLOPSComputed < 0 || math.IsNaN(delta.Loss) || math.IsInf(delta.Loss, 0) ||
		math.IsNaN(delta.TFLOPSComputed) || math.IsInf(delta.TFLOPSComputed, 0) {
		return false
	}
	for _, value := range delta.Values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	expected := calculateProofHash(delta.NodeID, delta.RoundID, delta.LayerName, delta.ProofNonce, delta.Values)
	return delta.ProofHash == expected
}

// FederatedAggregator averages bounded, signed deltas into an explicit candidate.
// A norm ceiling is not a proof of Byzantine robustness or training quality.
type FederatedAggregator struct {
	mu               sync.RWMutex
	currentRound     int
	model            *ModelCheckpoint
	pendingDeltas    []*WeightDelta
	keyRegistry      map[string]ed25519.PublicKey
	maxPendingDeltas int
	learningRate     float64
	maxGradientNorm  float64
	configured       bool
}

// NewFederatedAggregator starts an empty candidate aggregator. It does not
// invent model weights, loss or learning rates; it has no payment or reward state.
func NewFederatedAggregator(initialRound int) *FederatedAggregator {
	if initialRound <= 0 {
		initialRound = 1
	}

	return &FederatedAggregator{
		currentRound:     initialRound,
		pendingDeltas:    make([]*WeightDelta, 0),
		keyRegistry:      make(map[string]ed25519.PublicKey),
		maxPendingDeltas: resourcepolicy.Default().MaxPendingDeltas,
		model: &ModelCheckpoint{
			Version:      fmt.Sprintf("candidate-v1.%d", initialRound),
			RoundID:      initialRound,
			Weights:      make(map[string][]float64),
			Contributors: 0,
			Timestamp:    time.Now(),
		},
	}
}

// AggregationPolicy is explicit candidate-update policy, not model promotion.
type AggregationPolicy struct {
	LearningRate    float64
	MaxGradientNorm float64
}

// ConfigureCandidate owns a copy of caller-supplied candidate weights. Promotion
// into an Ilaria production model is outside this prototype's authority.
func (fa *FederatedAggregator) ConfigureCandidate(weights map[string][]float64, policy AggregationPolicy) error {
	if policy.LearningRate <= 0 || policy.MaxGradientNorm <= 0 || len(weights) == 0 {
		return fmt.Errorf("candidate weights and valid aggregation policy are required")
	}
	for _, value := range []float64{policy.LearningRate, policy.MaxGradientNorm} {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return fmt.Errorf("aggregation policy must be finite")
		}
	}
	snapshot := make(map[string][]float64, len(weights))
	for layer, values := range weights {
		if layer == "" || len(values) == 0 || len(values) > resourcepolicy.Default().MaxTrainingDeltaParams {
			return fmt.Errorf("invalid candidate layer size")
		}
		for _, value := range values {
			if math.IsNaN(value) || math.IsInf(value, 0) {
				return fmt.Errorf("candidate weights must be finite")
			}
		}
		snapshot[layer] = append([]float64(nil), values...)
	}
	fa.mu.Lock()
	defer fa.mu.Unlock()
	if fa.configured || len(fa.pendingDeltas) != 0 {
		return fmt.Errorf("candidate is already configured")
	}
	fa.model.Weights = snapshot
	fa.learningRate, fa.maxGradientNorm = policy.LearningRate, policy.MaxGradientNorm
	fa.configured = true
	return nil
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
	if !fa.configured {
		return false, "REJECTED_UNCONFIGURED_CANDIDATE"
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

	// 2. delta integrity verification
	if !VerifyDeltaIntegrity(delta) {
		return false, "REJECTED_INVALID_PROOF_OF_COMPUTE"
	}

	if delta.RoundID != fa.currentRound {
		return false, "REJECTED_WRONG_ROUND"
	}
	base, exists := fa.model.Weights[delta.LayerName]
	if !exists {
		return false, "REJECTED_UNKNOWN_LAYER"
	}
	if len(delta.Values) != len(base) {
		return false, "REJECTED_DELTA_DIMENSION"
	}
	if delta.IsPoisonous {
		return false, "REJECTED_POISONOUS_DELTA"
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
	// Reject gradients above the configured norm ceiling without mutating the caller.
	var gradientNorm float64
	for _, v := range delta.Values {
		gradientNorm = math.Hypot(gradientNorm, v)
	}

	if gradientNorm > fa.maxGradientNorm || math.IsNaN(gradientNorm) {
		return false, fmt.Sprintf("REJECTED_BYZANTINE_POISONING_ATTACK: Gradient norm %.2f exceeds safety ceiling (%.2f)", gradientNorm, fa.maxGradientNorm)
	}

	snapshot := *delta
	snapshot.Values = append([]float64(nil), delta.Values...)
	if delta.Signature != nil {
		snapshot.Signature = append([]byte(nil), delta.Signature...)
	}
	fa.pendingDeltas = append(fa.pendingDeltas, &snapshot)
	return true, "ACCEPTED"
}

// AggregateRound applies mean averaging to candidate weights only. It does not
// implement trimmed-mean robustness or promote an official Ilaria checkpoint.
func (fa *FederatedAggregator) AggregateRound() (*ModelCheckpoint, float64, error) {
	fa.mu.Lock()
	defer fa.mu.Unlock()

	if len(fa.pendingDeltas) == 0 {
		return cloneCheckpoint(fa.model), 0.0, fmt.Errorf("no valid gradient deltas submitted for round %d", fa.currentRound)
	}
	if fa.currentRound == int(^uint(0)>>1) || fa.model.Contributors > int(^uint(0)>>1)-len(fa.pendingDeltas) {
		return nil, 0, fmt.Errorf("candidate round or contributor counter exhausted")
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
	next := cloneCheckpoint(fa.model)
	for layer, deltasList := range layerDeltas {
		base, exists := next.Weights[layer]
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
			base[i] += fa.learningRate * (avgDelta[i] / numPeers)
			if math.IsNaN(base[i]) || math.IsInf(base[i], 0) {
				return nil, 0, fmt.Errorf("candidate update exceeded its numeric range")
			}
		}
		next.Weights[layer] = base
	}
	if math.IsNaN(avgLoss) || math.IsInf(avgLoss, 0) || math.IsInf(totalTflops, 0) {
		return nil, 0, fmt.Errorf("candidate metrics exceeded their numeric range")
	}
	fa.model = next

	// Advance candidate round & version, never production model state.
	fa.currentRound++
	fa.model.RoundID = fa.currentRound
	fa.model.Version = fmt.Sprintf("candidate-v1.%d", fa.currentRound)
	fa.model.GlobalLoss = avgLoss
	fa.model.Contributors += validCount
	fa.model.Timestamp = time.Now()

	// Clear round buffer
	for i := range fa.pendingDeltas {
		fa.pendingDeltas[i] = nil
	}
	fa.pendingDeltas = fa.pendingDeltas[:0]

	return cloneCheckpoint(fa.model), totalTflops, nil
}

// GetCurrentCheckpoint returns an owned candidate snapshot, not production weights.
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
