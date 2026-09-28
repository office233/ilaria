#ifndef RADIO_CUDA_H
#define RADIO_CUDA_H

#include <stdint.h>

#ifdef _WIN32
#define RADIO_API __declspec(dllexport)
#else
#define RADIO_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

// ═══════════════════════════════════════════════════════════════
// ILARIA — RadioCortex CUDA Acceleration
// ═══════════════════════════════════════════════════════════════

RADIO_API int radio_cuda_init(int num_neurons);
RADIO_API void radio_cuda_cleanup(void);
RADIO_API void radio_cuda_upload_neurons(const uint32_t* neurons, int count);
RADIO_API void radio_cuda_download_neurons(uint32_t* neurons, int count);
RADIO_API void radio_cuda_upload_bus(const int32_t* bus);
RADIO_API void radio_cuda_download_bus(int32_t* bus);
RADIO_API void radio_cuda_step(int fire_threshold, int phase_window);
RADIO_API void radio_cuda_step_n(int n_ticks, int fire_threshold, int phase_window);
RADIO_API void radio_cuda_inject(const uint8_t* freqs, const int16_t* amplitudes, int count);
RADIO_API void radio_cuda_clear_bus(void);
RADIO_API void radio_cuda_stats(int32_t* out_stats);
RADIO_API void radio_cuda_hebbian(const int32_t* target_mask);
RADIO_API int radio_cuda_decode_token(const uint8_t* vocab_spectrum, int vocab_size, int freqs_per_token);
RADIO_API void radio_cuda_decode_top_k(const uint8_t* vocab_spectrum, int vocab_size, int freqs_per_token, int k, int32_t* out_token_ids, int32_t* out_scores);

#ifdef __cplusplus
}
#endif

#endif // RADIO_CUDA_H
