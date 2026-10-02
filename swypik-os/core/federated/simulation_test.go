package federated

// Test-only synthetic simulator. It lives in a _test.go file so that no shipped
// binary can generate random gradients presented as training. Deltas are labelled
// Evidence "SIMULATED" and exist only to exercise signature, aggregation and
// resource-bound tests. The real path is swarm.ExecuteVerifiedRound (imcnetwork).

import (
	"crypto/ed25519"
	"fmt"
	"math"
	"math/rand"
	"sync"
	"time"
)

const SimulationConfigVersion = 1

// SimulationConfig describes synthetic, reproducible test data only. No field is
// a measured loss, accelerator utilization or work attestation.
type SimulationConfig struct {
	Version        int
	Seed           int64
	InitialLoss    float64
	LossFloor      float64
	LossDecay      float64
	GradientBias   float64
	GradientScale  float64
	TFLOPSEstimate float64
}

func (c SimulationConfig) Validate() error {
	for _, value := range []float64{c.InitialLoss, c.LossFloor, c.LossDecay,
		c.GradientBias, c.GradientScale, c.TFLOPSEstimate} {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return fmt.Errorf("simulation configuration must be finite")
		}
	}
	if c.Version != SimulationConfigVersion || c.InitialLoss <= 0 || c.LossFloor < 0 ||
		c.LossFloor > c.InitialLoss || c.LossDecay <= 0 || c.LossDecay > 1 ||
		c.GradientBias < 0 || c.GradientBias > 1 || c.GradientScale <= 0 ||
		c.TFLOPSEstimate < 0 || c.TFLOPSEstimate > MaxTFLOPSPerDelta {
		return fmt.Errorf("invalid synthetic simulation configuration")
	}
	return nil
}

type simulationState struct {
	config        SimulationConfig
	random        *rand.Rand
	currentLoss   float64
	completedRuns int64
}

var simulations sync.Map // *LocalTrainer -> *simulationState

func simState(t *LocalTrainer) *simulationState {
	if v, ok := simulations.Load(t); ok {
		return v.(*simulationState)
	}
	return nil
}

// simRuns reports synthetic work completed by a trainer (0 when unconfigured).
func simRuns(t *LocalTrainer) int64 {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if s := simState(t); s != nil {
		return s.completedRuns
	}
	return 0
}

func simConfig(t *LocalTrainer) SimulationConfig {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if s := simState(t); s != nil {
		return s.config
	}
	return SimulationConfig{}
}

// ConfigureSimulation explicitly enables synthetic deltas for tests. A trainer
// cannot be reset after work has started; the supplied config is copied.
func (t *LocalTrainer) ConfigureSimulation(config SimulationConfig) error {
	if err := config.Validate(); err != nil {
		return err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if simState(t) != nil {
		return fmt.Errorf("simulation is already configured")
	}
	simulations.Store(t, &simulationState{config: config, random: rand.New(rand.NewSource(config.Seed)), currentLoss: config.InitialLoss})
	return nil
}

// ComputeMicroBatch returns explicitly labelled synthetic data, never claims a
// real forward/backward pass, and refuses operation without simulation config.
func (t *LocalTrainer) ComputeMicroBatch(roundID int, layerName string, paramCount int) (*WeightDelta, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if roundID < 0 || layerName == "" || t.nodeID == "" || paramCount <= 0 || paramCount > t.maxParamCount {
		return nil, fmt.Errorf("invalid training parameters")
	}
	if t.maxGPUPercent <= 0 || math.IsNaN(t.maxGPUPercent) || math.IsInf(t.maxGPUPercent, 0) {
		return nil, fmt.Errorf("training is paused: a finite positive GPU ceiling is required")
	}
	if len(t.privKey) != ed25519.PrivateKeySize || len(t.pubKey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("training requires a signing key pair")
	}
	derived := ed25519.NewKeyFromSeed(t.privKey[:ed25519.SeedSize])
	if !derived.Equal(t.privKey) || !derived.Public().(ed25519.PublicKey).Equal(t.pubKey) {
		return nil, fmt.Errorf("training signing keys do not match")
	}
	state := simState(t)
	if state == nil {
		return nil, fmt.Errorf("training unavailable: no Ilaria backend; synthetic simulation requires explicit configuration")
	}
	if state.completedRuns == math.MaxInt64 {
		return nil, fmt.Errorf("completed run counter exhausted")
	}
	config := state.config

	// 1. Simulate GPU gradient calculation scaled by GPU percentage
	gpuFactor := t.maxGPUPercent / 100.0
	tflops := config.TFLOPSEstimate * gpuFactor

	deltas := make([]float64, paramCount)
	for i := range deltas {
		// Uniform synthetic values, scaled by the configured test assumptions.
		deltas[i] = (state.random.Float64() - config.GradientBias) * config.GradientScale / math.Sqrt(float64(roundID)+1)
	}

	// Loss decreases gradually
	nextLoss := math.Max(config.LossFloor, state.currentLoss*config.LossDecay)

	// 2. Compute delta integrity hash
	// Hash = SHA256(nodeID + roundID + layerName + Nonce + deltas)
	var nonce uint64 = uint64(time.Now().UnixNano())
	proofHash := calculateProofHash(t.nodeID, roundID, layerName, nonce, deltas)

	delta := &WeightDelta{
		NodeID:         t.nodeID,
		RoundID:        roundID,
		LayerName:      layerName,
		Values:         deltas,
		Loss:           nextLoss,
		TFLOPSComputed: tflops,
		ProofNonce:     nonce,
		ProofHash:      proofHash,
		IsPoisonous:    false,
		Timestamp:      time.Now().UTC(),
		Evidence:       "SIMULATED",
	}

	// 3. Cryptographically sign the canonical fields if key is configured
	if len(t.privKey) == ed25519.PrivateKeySize {
		if err := delta.Sign(t.privKey); err != nil {
			return nil, fmt.Errorf("failed to sign weight delta: %w", err)
		}
	}

	state.currentLoss = nextLoss
	state.completedRuns++
	return delta, nil
}
