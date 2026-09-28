# Design Document — Ilaria Sparse Cognitive Architecture

## Architecture Philosophy

Ilaria is an experimental research prototype exploring biological, neuroscience-inspired alternatives to standard dense deep learning (e.g., Transformers, MLP-based systems). Rather than relying on massive floating-point matrix multiplications to generate the "next token," Ilaria models the interactions of **10 distinct anatomical brain regions** utilizing high-sparsity Sparse Distributed Representations (SDRs), active dendrites, ternary weights, and cyclic sleep consolidation.

Our core goal is to demonstrate that sparse, localized cognitive networks can run extremely fast on commodity CPU hardware with zero runtime memory allocations, while retaining long-term associative memory.

---

## 1. The 10 Cognitive Subsystems

Ilaria partitions cognitive processing into dedicated modules mimicking human brain anatomy. Each region is implemented inside the `cortex/` package and communicates via sparse state vectors:

```
                          ┌────────────────────────┐
                          │    Sensory Input       │
                          └───────────┬────────────┘
                                      ▼
    ┌─────────────────────────────────┴────────────────────────────────┐
    │                        Prefrontal Cortex                         │
    │                   (Executive Planning & Gating)                  │
    └────────┬────────────────────────┬────────────────────────┬───────┘
             ▼                        ▼                        ▼
  ┌────────────────────┐   ┌────────────────────┐   ┌────────────────────┐
  │  Wernicke's Area   │   │   Broca's Area     │   │    Hippocampus     │
  │(Semantic Decoding) │   │ (Speech Synthesis) │   │ (Episodic Memory)  │
  └──────────┬─────────┘   └──────────┬─────────┘   └──────────┬─────────┘
             │                        │                        │
             └────────────────────────┼────────────────────────┘
                                      ▼
  ┌────────────────────┐   ┌────────────────────┐   ┌────────────────────┐
  │   Emotion System   │   │  Curiosity Engine  │   │  Cerebellum/Motor  │
  │(Neuromodulators)   │   │ (Intrinsic Reward) │   │ (Action Selection) │
  └──────────┬─────────┘   └──────────┬─────────┘   └──────────┬─────────┘
             │                        │                        │
             └────────────────────────┼────────────────────────┘
                                      ▼
                          ┌────────────────────────┐
                          │  Sleep Consolidation   │
                          │(Synaptic Weight Replay)│
                          └────────────────────────┘
```

### 1.1 Prefrontal Cortex (`prefrontal.go`)
Acts as the central executive coordinator. It manages active goals, delegates tasks to other regions, and implements gatekeepers to suppress hyper-active neural loops (analogous to the biological thalamocortical gating system).

### 1.2 Wernicke's Area (`wernicke.go`)
Performs semantic decoding. It processes input sparse vectors and extracts semantic meaning, activating overlapping clusters of neurons representing related concepts.

### 1.3 Broca's Area (`broca.go`)
Handles motor-speech and output synthesis. It translates internal sparse semantic concepts back into sequence plans and actions.

### 1.4 Hippocampus (`hippocampus.go`)
The short-term episodic memory buffer. It temporarily records rapid sequences of experiences using high-speed associative indexes. It prevents catastrophic forgetting by storing active neural paths before they are consolidated during sleep.

### 1.5 Emotion System (`emotion.go`)
Models neurotransmitter levels—specifically **Dopamine, Serotonin, and Norepinephrine**. These variables dynamically scale synaptic plasticity (learning rates) and excitability thresholds across the network:
*   **Dopamine**: Drives plasticity in response to reward prediction errors.
*   **Serotonin**: Stabilizes background noise and prevents runaway excitation.
*   **Norepinephrine**: Increases focus (sparsity thresholds) during unexpected inputs.

### 1.6 Curiosity Engine (`curiosity.go`)
Generates intrinsic motivation signals. When an input SDR is highly novel (low overlap with existing memory pathways), the Curiosity Engine spikes an exploration signal, boosting dopamine and forcing the prefrontal cortex to prioritize the new pattern.

### 1.7 Cerebellum (`cerebellum.go`)
Computes fine-grained motor and action-selection sequences. It handles timing and feedback calibration loops for reinforcement actions.

### 1.8 Sleep Consolidation (`sleep_consolidation.go`)
Periodically halts real-time sensory inputs to perform weight replay. It fetches stored episodic memory paths from the Hippocampus and "replays" them backwards and forwards through the cortical sheets, adjusting slow-plasticity structural synapses (transferring short-term memory to long-term cortex).

---

## 2. Sparse Distributed Representations (SDR) & Sparsity

SDRs are the canonical language of Ilaria. Unlike dense vectors (where every index has a floating-point value), an SDR is a large vector (e.g., 2048 or 4096 dimensions) where only a tiny fraction (typically 1.5% to 2.0%) of indices are active (`1`), and the rest are inactive (`0`):

1.  **High Overlap Robustness**: Because representations are sparse, multiple concepts can be superimposed on the same vector with near-zero collision probability.
2.  **Ternary Synaptic Weights**: Synaptic links use ternary values `{-1, 0, +1}`:
    *   `+1`: Excitatory connection.
    *   `0`: No connection (structural sparsity).
    *   `-1`: Inhibitory connection.
3.  **Active Dendrites**: Neurons possess multiple independent dendritic branches. A neuron only fires if a specific branch receives a threshold of co-active inputs, mimicking the non-linear summation seen in biological pyramidal neurons.

---

## 3. Thousand Brains Theory Implementation

Inspired by Jeff Hawkins and Numenta's research, Ilaria organizes cortical layers into parallel **sensory-motor columns** (`thousand_brains.go`). 

Each column receives:
1.  **Sensory Input**: The active features of the object.
2.  **Location Input**: A reference grid coordinate representing the sensor's location relative to the object.

By combining *what* is sensed with *where* it is sensed, each column independently builds a complete model of the object. Columns then vote via lateral connections (`attention.go`) to achieve a rapid, unified consensus of the object's identity. This allows the system to identify complex structures even when some sensory inputs are blocked or corrupted.

---

## 4. Custom CUDA Kernel & Neural Radio Cortex

For high-throughput experiments, we implemented a GPU-accelerated **Neural Radio Cortex** (`neuro_radio_cortex.go` and `cuda/radio_cuda.cu`). 

Standard deep learning frameworks represent sparse structures as dense tensors, wasting GPU threads. Our custom CUDA kernels optimize this via:
*   **Active-Only Processing**: Bypassing multiplication for all `0` weights.
*   **Shared Memory Cooperative Voting**: Sensory columns cooperate on-chip inside GPU shared memory, reducing global memory bandwidth.
*   **Ternary Accumulators**: Utilizing bit-shift operations and integer math rather than costly FP32/FP16 arithmetic, speeding up training on local consumer hardware.

---

## 5. Architectural Trade-Offs & Decisions

### 5.1 Why Go for the CPU Runtime?
We chose **Go** for the primary runtime over Python/C++ due to:
*   **Memory Control**: Go's garbage collector and struct layout support let us pre-allocate large pools of sparse arrays. We achieve zero runtime allocations during the core cognitive loop.
*   **Concurrency**: Go's goroutines make simulating parallel brain regions and sensory columns highly straightforward and readable.

### 5.2 CPU Sparse vs. Dense GPU Compute
Standard dense matrix compute performs massive operations continuously. Ilaria uses a sparse, pointer-chasing approach:
*   **Advantage**: Runs at low power on standard laptops. Takes up very little storage due to 1-bit/ternary weights.
*   **Trade-off**: Harder to scale using off-the-shelf deep learning hardware (like Tensor Cores), which is why we built custom, dedicated CUDA kernels.
