# Ilaria IMC roadmap (agreed 2026-09-29)

Ilaria gets her own language cortex, IMC (Ilaria MicroCortex), trained from
zero at 1.58 bits, English only. BitNet 2B4T and Ilaria-130M are kept as test
models in `data/modele de test/`. Every stage has a gate that is measured
before the next one starts; large GPU spends are quoted to the founder first.

## Where we are (2026-09-29)

- Ternary training from zero works: IMC-125M ternary val ppl 27.0 vs bf16 28.2
  (same 1B tokens; ternary used the BitNet learning rate 1.5e-3 vs 6e-4).
- 9.1B English tokens (DCLM, FineWeb-Edu, OpenCoder code, Nemotron-CC-Math,
  FineMath), 65,536-token tokenizer, on Drive `ilaria/imc/data`.
- IMC-250M ternary training on Colab G4 at ~121k tokens/s, ~5B tokens.
- NVIDIA Nemotron-CC web/code access requested (math granted).
- Compute: 8x H200 on brev.nvidia.com ($38/h), ~2,300 Colab units.

## Stage 1: the brain recipe
1. Finish and evaluate IMC-250M.
2. Trainer: chunked cross-entropy (no full logits in memory), multi-GPU
   (torchrun/DDP), optional FP8 after an A/B check.
3. Build the rest of the 1B data (~20B tokens) on a CPU runtime.
Gate: IMC-250M clearly better than IMC-125M.

## Stage 2: IMC-1B base
IMC-1B ternary (~981M params) on ~20B tokens, final annealing on the best data.
8x H200: ~11-12 h, ~$450. Gate: clearly better than IMC-250M, near public 1B
models on standard benchmarks.

## Stage 3: hands (autonomous operator)
Action tokens (`<action:bash>`, `<obs:stderr>`, ...), SFT on verified data only:
ToolACE, xLAM, APIGen-MT, execution-filtered code, and our own repair
trajectories validated by `swyp judge` / `go test`. Gate: repair after an
error goes from 0 to measured, repeatable gains on held-out tasks.

## Stage 4: Myriad
Specialists (code, math, tools, general) branched from IMC-1B plus a router
(Thalamus). Gate from the spec: N specialists beat one model of equal total
size at equal compute; otherwise fix the architecture before scaling.

## Stage 5: organism and devices
Packed ternary export (TritPack20 storage, RGBA32 compute) in the Go engine,
hippocampus wired to IMC, running inside SwypikOS.

## Stage 6: Swarm / ISX
"Carousel" distribution (teletext idea: signed fixed-size pages, fountain
codes, peer re-broadcast), then DiLoCo training on real nodes. Only public
weights, data shards and weight deltas travel; personal memory never does.

## Rules
- Measure before claiming; nothing is done without its gate.
- Training data enters only if verified (compiler, tests, known answers).
- Quote GPU cost before any large run.
