# IMC-125M CPU smoke — 2026-09-29

Status: **PASS — NON-PROMOTABLE SMOKE ONLY**.

This run validates execution mechanics only. It uses a deterministic synthetic
token stream and only 4–8 optimizer-visible tokens. It is **not** Genesis,
pretraining evidence, a quality comparison, or a scaling result.

## What was exercised

- exact canonical IMC-125M parameter shape: **125,882,112 parameters**;
- vocabulary 65,536 and EOS ID 61,440;
- 12 layers, d_model 768, 12 attention heads / 4 KV heads, FFN 2048;
- native ternary weight + int8 activation path;
- full-precision control path;
- chunked cross-entropy;
- gradient checkpointing;
- atomic best export and checkpoint publication;
- schema-v3 checkpoint load;
- pause at step 1 and exact-resume entry at step 1;
- best-checkpoint retention when resumed validation regressed;
- checkpoint/export SHA256 agreement.

Runtime was CPU-only (`torch 2.14.0+cpu`); CUDA was unavailable on this host.
The smoke used `ctx=4`, `batch=1`, `accum=1`, while the model configuration kept
`max_seq_len=2048`.

## Ternary candidate

| Step | Train loss | Validation loss | Tokens seen |
|---:|---:|---:|---:|
| 1 | 11.014261 | 11.312065 | 4 |
| 2 (resumed) | 11.467454 | 11.583840 | 8 |

The resumed validation was worse, so the exported best model correctly remained
the step-1 model.

- best export SHA256: `31236600884b81b0311cc796100086490590d374dd34ba66883cc4e1227ab916`
- final checkpoint SHA256: `52cfb8942239fb46069c187e118096b946811480f7a14f5d2c234be07efc903c`
- checkpoint: schema 3, step 2, tokens_seen 8
- checkpoint `best_export_sha256` matched the actual `imc.pt` SHA256 exactly.

## Full-precision control

| Step | Train loss | Validation loss | Tokens seen |
|---:|---:|---:|---:|
| 1 | 11.708881 | 11.550189 | 4 |

- best export SHA256: `7d50bfdbf9e231eb849d09436d3e7c350e7e49029a9ba8b6896cf2449dc90b3c`
- checkpoint SHA256: `9c0407db03e9be17017aa25f360fb427edd8fc4adef6cd7eeec6c5f422c82337`

No quality conclusion is drawn from ternary vs full precision at this scale.

## Frozen smoke input

- stream tokens: 8,192 synthetic uint16 IDs
- stream SHA256: `b59fe6b37479bfeda9254bfa11eb3163929f6237f6f0a336b5575ee5e7de6773`
- smoke tokenizer SHA256: `cc1dc074b955c4be91b9fb9f88d46d73a1565912795f6e0c51ecf42cb762c19f`

The next real training milestone remains the rights-approved, frozen IlariaLex
tokenizer plus immutable ~1B-token IMC-125M dataset manifest and production
preflight PASS.
