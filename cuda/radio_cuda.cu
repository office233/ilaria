// ═══════════════════════════════════════════════════════════════════
// ILARIA — RadioCortex CUDA Kernels
// ═══════════════════════════════════════════════════════════════════
//
// Compile: nvcc -shared -o radio_cuda.dll radio_cuda.cu -O3 -arch=sm_75
//          (sm_75 = GTX 1660 Ti, Compute 7.5)

#include "radio_cuda.h"
#include <stdio.h>
#include <stdlib.h>

// ─────────────────────────────────────────────────────────────────
// Neuron bit layout (same as Go RadioNeuron uint32):
//   R (bits 24-31) = Frequency
//   G (bits 16-23) = Phase
//   B (bits  8-15) = Amplitude
//   A (bits  0- 7) = EmitFreq(6bit) | Inhibitory(1) | Alive(1)
// ─────────────────────────────────────────────────────────────────

#define FREQ(n)      ((uint8_t)((n) >> 24))
#define PHASE(n)     ((uint8_t)((n) >> 16))
#define AMP(n)       ((uint8_t)((n) >> 8))
#define EMIT_FREQ(n) ((uint8_t)(((n) & 0xFC) >> 2))
#define IS_ALIVE(n)  ((n) & 0x01)
#define IS_INHIB(n)  (((n) >> 1) & 0x01)

#define SET_PHASE(n, p)  ((n) = ((n) & 0xFF00FFFF) | ((uint32_t)(p) << 16))
#define SET_AMP(n, a)    ((n) = ((n) & 0xFFFF00FF) | ((uint32_t)(a) << 8))
#define SET_ALIVE(n, v)  ((n) = ((v) ? ((n) | 0x01) : ((n) & ~0x01)))
#define SET_FREQ(n, f)   ((n) = ((n) & 0x00FFFFFF) | ((uint32_t)(f) << 24))

#define BUS_CHANNELS 256
#define BLOCK_SIZE 256

// ─────────────────────────────────────────────────────────────────
// GPU Memory
// ─────────────────────────────────────────────────────────────────

static uint32_t* d_neurons = NULL;    // GPU neuron array
static int32_t*  d_bus = NULL;        // GPU bus [256]
static int32_t*  d_emit_bus = NULL;   // GPU emit buffer [256]
static int32_t*  d_fired = NULL;      // GPU fired flags [num_neurons]
static int       g_num_neurons = 0;
static int       g_initialized = 0;

// ─────────────────────────────────────────────────────────────────
// KERNEL 1: Radio Step — One thread per neuron
// ─────────────────────────────────────────────────────────────────
__global__ void kernel_radio_step(
    uint32_t* neurons,
    const int32_t* bus,
    int32_t* emit_bus,
    int32_t* fired,
    int num_neurons,
    int fire_threshold,
    int phase_window
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_neurons) return;

    uint32_t n = neurons[idx];
    fired[idx] = 0;

    // Skip dead neurons
    if (!IS_ALIVE(n)) return;

    // Read frequency and get bus signal
    uint8_t freq = FREQ(n);
    int32_t signal = bus[freq];

    // Advance phase: phase += freq (wraps at 256)
    uint8_t phase = PHASE(n);
    uint8_t new_phase = phase + freq;
    SET_PHASE(n, new_phase);

    // Check if signal exceeds fire threshold
    int32_t abs_signal = signal > 0 ? signal : -signal;
    if (abs_signal < fire_threshold) {
        neurons[idx] = n;
        return;
    }

    // Phase match: check if neuron's phase aligns with bus activity
    // Active = phase in upper half (>= 128)
    if (new_phase < 128) {
        neurons[idx] = n;
        return;
    }

    // FIRE! Emit on emit frequency
    uint8_t emit_freq = EMIT_FREQ(n);
    uint8_t amp = AMP(n);
    int16_t emission = (int16_t)amp;
    if (IS_INHIB(n)) {
        emission = -emission;
    }

    // Atomic add to emit bus (multiple neurons may emit on same freq)
    atomicAdd(&emit_bus[emit_freq], (int32_t)emission);
    fired[idx] = 1;

    // Write back neuron with updated phase
    neurons[idx] = n;
}

// ─────────────────────────────────────────────────────────────────
// KERNEL 2: Bus Reduce — Merge emit_bus into bus, then clear emit
// ─────────────────────────────────────────────────────────────────
__global__ void kernel_bus_reduce(int32_t* bus, int32_t* emit_bus) {
    int ch = threadIdx.x;  // 0-255
    if (ch >= BUS_CHANNELS) return;

    bus[ch] = emit_bus[ch];
    emit_bus[ch] = 0;
}

// ─────────────────────────────────────────────────────────────────
// KERNEL 3: Bus Clear
// ─────────────────────────────────────────────────────────────────
__global__ void kernel_bus_clear(int32_t* bus) {
    int ch = threadIdx.x;
    if (ch >= BUS_CHANNELS) return;
    bus[ch] = 0;
}

// ─────────────────────────────────────────────────────────────────
// KERNEL 4: Inject signals into bus
// ─────────────────────────────────────────────────────────────────
__global__ void kernel_inject(
    int32_t* bus,
    const uint8_t* freqs,
    const int16_t* amplitudes,
    int count
) {
    int idx = threadIdx.x;
    if (idx >= count) return;
    atomicAdd(&bus[freqs[idx]], (int32_t)amplitudes[idx]);
}

// ─────────────────────────────────────────────────────────────────
// KERNEL 5: Hebbian Learning — Confirm/Contradict based on target
// ─────────────────────────────────────────────────────────────────
__global__ void kernel_hebbian(
    uint32_t* neurons,
    const int32_t* fired,
    const int32_t* target_mask,
    int num_neurons
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_neurons) return;
    if (!fired[idx]) return;  // only adjust neurons that fired

    uint32_t n = neurons[idx];
    if (!IS_ALIVE(n)) return;

    uint8_t emit_freq = EMIT_FREQ(n);
    uint8_t amp = AMP(n);

    if (target_mask[emit_freq] > 0) {
        // CONFIRM: this neuron emitted on a target frequency — strengthen
        if (amp < 255) {
            SET_AMP(n, amp + 1);
        }
    } else {
        // CONTRADICT: this neuron emitted on wrong frequency — weaken
        if (amp > 0) {
            amp--;
            SET_AMP(n, amp);
        }
        // If very weak, drift frequency (try to find a better one)
        if (amp < 32) {
            uint8_t freq = FREQ(n);
            // Simple drift: freq += 1 (wraps at 256)
            freq = freq + 1;
            SET_FREQ(n, freq);
        }
        // Kill if amplitude reaches 0
        if (amp == 0) {
            SET_ALIVE(n, 0);
        }
    }

    neurons[idx] = n;
}

// ─────────────────────────────────────────────────────────────────
// KERNEL 6: Decode Token — Find best matching token from bus
// ─────────────────────────────────────────────────────────────────
__global__ void kernel_decode_scores(
    const int32_t* bus,
    const uint8_t* vocab_spectrum,  // [vocab_size × freqs_per_token]
    int32_t* scores,                // [vocab_size] output
    int vocab_size,
    int freqs_per_token
) {
    int token_id = blockIdx.x * blockDim.x + threadIdx.x;
    if (token_id >= vocab_size) return;

    int32_t score = 0;
    const uint8_t* freqs = &vocab_spectrum[token_id * freqs_per_token];

    for (int i = 0; i < freqs_per_token; i++) {
        int32_t val = bus[freqs[i]];
        score += (val > 0) ? val : -val;  // abs sum
    }

    scores[token_id] = score;
}

// ─────────────────────────────────────────────────────────────────
// KERNEL 7: Stats — Count alive, sum amplitude
// ─────────────────────────────────────────────────────────────────
__global__ void kernel_stats(
    const uint32_t* neurons,
    int num_neurons,
    int32_t* out  // [0]=alive, [1]=fired_count, [2]=total_amp
) {
    __shared__ int32_t s_alive[BLOCK_SIZE];
    __shared__ int32_t s_amp[BLOCK_SIZE];

    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int tid = threadIdx.x;

    s_alive[tid] = 0;
    s_amp[tid] = 0;

    if (idx < num_neurons) {
        uint32_t n = neurons[idx];
        if (IS_ALIVE(n)) {
            s_alive[tid] = 1;
            s_amp[tid] = AMP(n);
        }
    }

    __syncthreads();

    // Block-level reduction
    for (int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) {
            s_alive[tid] += s_alive[tid + s];
            s_amp[tid] += s_amp[tid + s];
        }
        __syncthreads();
    }

    if (tid == 0) {
        atomicAdd(&out[0], s_alive[0]);
        atomicAdd(&out[2], s_amp[0]);
    }
}

// ═══════════════════════════════════════════════════════════════════
// C API Implementation
// ═══════════════════════════════════════════════════════════════════

extern "C" {

int radio_cuda_init(int num_neurons) {
    if (g_initialized) {
        radio_cuda_cleanup();
    }

    g_num_neurons = num_neurons;

    cudaError_t err;
    err = cudaMalloc(&d_neurons, num_neurons * sizeof(uint32_t));
    if (err != cudaSuccess) {
        fprintf(stderr, "[CUDA] Failed to allocate neurons: %s\n", cudaGetErrorString(err));
        return -1;
    }

    err = cudaMalloc(&d_bus, BUS_CHANNELS * sizeof(int32_t));
    if (err != cudaSuccess) { cudaFree(d_neurons); return -1; }

    err = cudaMalloc(&d_emit_bus, BUS_CHANNELS * sizeof(int32_t));
    if (err != cudaSuccess) { cudaFree(d_neurons); cudaFree(d_bus); return -1; }

    err = cudaMalloc(&d_fired, num_neurons * sizeof(int32_t));
    if (err != cudaSuccess) { cudaFree(d_neurons); cudaFree(d_bus); cudaFree(d_emit_bus); return -1; }

    // Clear all buffers
    cudaMemset(d_bus, 0, BUS_CHANNELS * sizeof(int32_t));
    cudaMemset(d_emit_bus, 0, BUS_CHANNELS * sizeof(int32_t));
    cudaMemset(d_fired, 0, num_neurons * sizeof(int32_t));

    g_initialized = 1;

    printf("[CUDA] Initialized: %d neurons (%.1f KB on GPU), GTX 1660 Ti ready.\n",
           num_neurons, (float)(num_neurons * 4) / 1024.0f);
    return 0;
}

void radio_cuda_cleanup(void) {
    if (d_neurons) cudaFree(d_neurons);
    if (d_bus) cudaFree(d_bus);
    if (d_emit_bus) cudaFree(d_emit_bus);
    if (d_fired) cudaFree(d_fired);
    d_neurons = NULL;
    d_bus = NULL;
    d_emit_bus = NULL;
    d_fired = NULL;
    g_initialized = 0;
    g_num_neurons = 0;
}

void radio_cuda_upload_neurons(const uint32_t* neurons, int count) {
    cudaMemcpy(d_neurons, neurons, count * sizeof(uint32_t), cudaMemcpyHostToDevice);
}

void radio_cuda_download_neurons(uint32_t* neurons, int count) {
    cudaMemcpy(neurons, d_neurons, count * sizeof(uint32_t), cudaMemcpyDeviceToHost);
}

void radio_cuda_upload_bus(const int32_t* bus) {
    cudaMemcpy(d_bus, bus, BUS_CHANNELS * sizeof(int32_t), cudaMemcpyHostToDevice);
}

void radio_cuda_download_bus(int32_t* bus) {
    cudaMemcpy(bus, d_bus, BUS_CHANNELS * sizeof(int32_t), cudaMemcpyDeviceToHost);
}

void radio_cuda_step(int fire_threshold, int phase_window) {
    int blocks = (g_num_neurons + BLOCK_SIZE - 1) / BLOCK_SIZE;

    // Step: each neuron reads bus, decides, emits
    kernel_radio_step<<<blocks, BLOCK_SIZE>>>(
        d_neurons, d_bus, d_emit_bus, d_fired,
        g_num_neurons, fire_threshold, phase_window
    );

    // Reduce: merge emit_bus into bus
    kernel_bus_reduce<<<1, BUS_CHANNELS>>>(d_bus, d_emit_bus);
}

void radio_cuda_step_n(int n_ticks, int fire_threshold, int phase_window) {
    int blocks = (g_num_neurons + BLOCK_SIZE - 1) / BLOCK_SIZE;

    for (int t = 0; t < n_ticks; t++) {
        kernel_radio_step<<<blocks, BLOCK_SIZE>>>(
            d_neurons, d_bus, d_emit_bus, d_fired,
            g_num_neurons, fire_threshold, phase_window
        );
        kernel_bus_reduce<<<1, BUS_CHANNELS>>>(d_bus, d_emit_bus);
    }

    // Sync only at the end — all ticks run on GPU without CPU involvement
    cudaDeviceSynchronize();
}

void radio_cuda_inject(const uint8_t* freqs, const int16_t* amplitudes, int count) {
    uint8_t* d_freqs;
    int16_t* d_amps;
    cudaMalloc(&d_freqs, count * sizeof(uint8_t));
    cudaMalloc(&d_amps, count * sizeof(int16_t));
    cudaMemcpy(d_freqs, freqs, count * sizeof(uint8_t), cudaMemcpyHostToDevice);
    cudaMemcpy(d_amps, amplitudes, count * sizeof(int16_t), cudaMemcpyHostToDevice);

    kernel_inject<<<1, count>>>(d_bus, d_freqs, d_amps, count);

    cudaFree(d_freqs);
    cudaFree(d_amps);
}

void radio_cuda_clear_bus(void) {
    kernel_bus_clear<<<1, BUS_CHANNELS>>>(d_bus);
}

void radio_cuda_stats(int32_t* out_stats) {
    int32_t* d_stats;
    cudaMalloc(&d_stats, 3 * sizeof(int32_t));
    cudaMemset(d_stats, 0, 3 * sizeof(int32_t));

    int blocks = (g_num_neurons + BLOCK_SIZE - 1) / BLOCK_SIZE;
    kernel_stats<<<blocks, BLOCK_SIZE>>>(d_neurons, g_num_neurons, d_stats);
    cudaDeviceSynchronize();

    cudaMemcpy(out_stats, d_stats, 3 * sizeof(int32_t), cudaMemcpyDeviceToHost);
    cudaFree(d_stats);

    // Compute average amplitude
    if (out_stats[0] > 0) {
        out_stats[2] = out_stats[2] / out_stats[0];
    }
}

void radio_cuda_hebbian(const int32_t* target_mask) {
    int32_t* d_target;
    cudaMalloc(&d_target, BUS_CHANNELS * sizeof(int32_t));
    cudaMemcpy(d_target, target_mask, BUS_CHANNELS * sizeof(int32_t), cudaMemcpyHostToDevice);

    int blocks = (g_num_neurons + BLOCK_SIZE - 1) / BLOCK_SIZE;
    kernel_hebbian<<<blocks, BLOCK_SIZE>>>(d_neurons, d_fired, d_target, g_num_neurons);
    cudaDeviceSynchronize();

    cudaFree(d_target);
}

int radio_cuda_decode_token(
    const uint8_t* vocab_spectrum,
    int vocab_size,
    int freqs_per_token
) {
    uint8_t* d_vocab;
    int32_t* d_scores;

    cudaMalloc(&d_vocab, vocab_size * freqs_per_token * sizeof(uint8_t));
    cudaMalloc(&d_scores, vocab_size * sizeof(int32_t));

    cudaMemcpy(d_vocab, vocab_spectrum, vocab_size * freqs_per_token * sizeof(uint8_t), cudaMemcpyHostToDevice);
    cudaMemset(d_scores, 0, vocab_size * sizeof(int32_t));

    int blocks = (vocab_size + BLOCK_SIZE - 1) / BLOCK_SIZE;
    kernel_decode_scores<<<blocks, BLOCK_SIZE>>>(d_bus, d_vocab, d_scores, vocab_size, freqs_per_token);
    cudaDeviceSynchronize();

    // Download scores and find max on CPU (vocab_size is small)
    int32_t* scores = (int32_t*)malloc(vocab_size * sizeof(int32_t));
    cudaMemcpy(scores, d_scores, vocab_size * sizeof(int32_t), cudaMemcpyDeviceToHost);

    int best_id = 0;
    int32_t best_score = scores[0];
    for (int i = 1; i < vocab_size; i++) {
        if (scores[i] > best_score) {
            best_score = scores[i];
            best_id = i;
        }
    }

    free(scores);
    cudaFree(d_vocab);
    cudaFree(d_scores);

    return best_id;
}

void radio_cuda_decode_top_k(
    const uint8_t* vocab_spectrum,
    int vocab_size,
    int freqs_per_token,
    int k,
    int32_t* out_token_ids,
    int32_t* out_scores
) {
    uint8_t* d_vocab;
    int32_t* d_scores_gpu;

    cudaMalloc(&d_vocab, vocab_size * freqs_per_token * sizeof(uint8_t));
    cudaMalloc(&d_scores_gpu, vocab_size * sizeof(int32_t));

    cudaMemcpy(d_vocab, vocab_spectrum, vocab_size * freqs_per_token * sizeof(uint8_t), cudaMemcpyHostToDevice);
    cudaMemset(d_scores_gpu, 0, vocab_size * sizeof(int32_t));

    int blocks = (vocab_size + BLOCK_SIZE - 1) / BLOCK_SIZE;
    kernel_decode_scores<<<blocks, BLOCK_SIZE>>>(d_bus, d_vocab, d_scores_gpu, vocab_size, freqs_per_token);
    cudaDeviceSynchronize();

    int32_t* scores = (int32_t*)malloc(vocab_size * sizeof(int32_t));
    cudaMemcpy(scores, d_scores_gpu, vocab_size * sizeof(int32_t), cudaMemcpyDeviceToHost);

    // Simple top-K selection (vocab is small, CPU is fine)
    for (int i = 0; i < k; i++) {
        int best_idx = 0;
        int32_t best_val = -1;
        for (int j = 0; j < vocab_size; j++) {
            if (scores[j] > best_val) {
                best_val = scores[j];
                best_idx = j;
            }
        }
        out_token_ids[i] = best_idx;
        out_scores[i] = best_val;
        scores[best_idx] = -1;  // exclude from next iteration
    }

    free(scores);
    cudaFree(d_vocab);
    cudaFree(d_scores_gpu);
}

} // extern "C"
