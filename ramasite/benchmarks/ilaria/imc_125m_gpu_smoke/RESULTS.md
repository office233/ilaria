# IMC-125M Colab GPU smoke

Date: 2026-09-30

Purpose: validate the actual IMC-125M CUDA and trainer paths without bypassing
the production dataset / tokenizer gates.

## Environment

- Google Colab CLI: **0.7.4**
- accelerator: **NVIDIA L4**
- GPU memory: **23,659,151,360 bytes**
- CUDA: **12.8**
- PyTorch: **2.11.0+cu128**
- Colab compute balance before smoke: **2303.37**
- Colab compute balance after session release: **2303.28**
- active assignments after verification: **0**

## Model-level smoke

The exact canonical IMC-125M preset was instantiated:

- parameters: **125,882,112**
- vocabulary: **65,536**
- context configuration: **2,048**
- full-precision forward/backward loss: **11.703143**
- ternary forward/backward loss: **11.602856**
- both losses finite: **yes**
- peak allocated CUDA memory in the micro-smoke: about **1.43 GB**

The first-call timing numbers are deliberately not treated as a benchmark
because CUDA warm-up/kernel initialization distorted the comparison.

## Trainer-level smoke

The development tokenizer encoded one verified-trajectory shard:

- documents: **10,000**
- tokens: **1,169,450**
- stream SHA-256:
  `4fd13f3063d72a6d968ad59aeb3cf0c81ff46d2a673d46ebc4e2224d1ac400e5`

The actual `forge/train_ilaria.py` entrypoint then ran with:

- `--preset imc-125m`
- `--ternary`
- `--ctx 128`
- batch 1, accumulation 1
- 2 optimizer steps
- BF16 autocast
- gradient checkpointing
- chunked loss
- AdamW
- internal validation split
- `--allow-unmanifested-data` explicitly, therefore smoke-only

Observed output:

- train stream: **1,157,756 tokens**
- validation stream: **11,694 tokens**
- step 0 loss: **11.7169**
- gradient norm: **43.46** before clipping
- step 2 validation loss: **11.1240**
- validation perplexity: **67,779.8**
- IMC export occurred successfully
- trainer return code: **0**

The Colab VM was released after the smoke; the ephemeral smoke checkpoint was
not promoted or retained as a production model.

## Regression found and fixed

The first trainer attempt correctly failed because token streams emitted by
`forge/hf_tokenizer.py encode` lacked the mandatory `stream_sha256` field
required by `train_ilaria.py::load_stream`.

The encoder now hashes the emitted binary stream and writes
`stream_sha256` into metadata. A regression assertion was added to
`forge/test_hf_tokenizer.py`.

This is a real pipeline compatibility fix, not a relaxation of the trainer
gate.
