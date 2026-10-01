# IMC-125M G4 target status

Date: 2026-09-30

## Colab entitlements

Direct backend account response reports these eligible GPUs:

- **H100**
- **G4**
- **A100**
- **L4**
- **T4**

H100 is eligible but was not allocated in the current availability probe.
G4 allocates successfully when requested **without** `--high-mem`.

## Verified G4 runtime

Allocated runtime:

- accelerator class: **G4**
- GPU: **NVIDIA RTX PRO 6000 Blackwell Server Edition**
- total VRAM: **101,974,081,536 bytes** (~94.97 GiB)
- compute capability: **12.0**
- native BF16: **true**

## IMC-125M exact-context batch probe

Probe conditions:

- model: IMC-125M
- parameters: **125,882,112**
- ternary path
- context: **2048**
- locked global batch: **262,144 tokens**
- BF16
- gradient checkpointing
- AdamW optimizer step
- VRAM headroom policy: peak allocated <= 85% total VRAM

Results:

| Micro-batch | Accumulation | Peak allocated | Result |
|---:|---:|---:|---|
| 4 | 32 | 7.43 GB | PASS |
| 8 | 16 | 8.03 GB | PASS |
| 16 | 8 | 8.79 GB | PASS |
| 32 | 4 | 10.37 GB | PASS |

Recommended production starting point:

- **micro-batch 32**
- **accumulation 4**
- 262,144 tokens / optimizer step
- 3,815 optimizer steps for the 1B-token horizon
- 1,000,079,360 actual exposed tokens

The probe output is preserved at:

`bench/imc_125m_g4_probe/g4-batch-probe.json`

## Colab code bundle

Fresh deterministic bundle:

- files: 137
- ZIP SHA-256:
  `06721499ff9369e1c4932d002659c6d43f6387be35330d4a6b26edd3f8a32511`
- manifest SHA-256:
  `f4e3c2ac009d28596f7a7cc2a2bab2f36edd788adf64298c274f710133c4b203`

## Session hygiene

The G4 probe session was stopped after calibration.

Current state after release:

- balance: **2303.03 CU**
- usage rate: **0.00 CU/hour**
- active assignments: **0**
- active sessions: **0**
