# Ilaria / SwypikOS integration and English-first training

## Verified scope

Ilaria contains an actual local BitNet inference engine, Python LoRA training code,
multimodal projectors and an executable tool loop. SwypikOS is a Windows desktop
shell. Its previous canned chat responses have been replaced by a local HTTP
client for Ilaria. The separate code-generation helper still uses templates.
The E: Swypik application and MultiERP integrations have not been changed.

This change adds Go CPU and CUDA LoRA application, a loopback inference service,
bounded conversation history, explicit backend failures, and English-first tool
SFT with checkpoint resume and DDP. The CLI's host Go execution tool requires
explicit `-allow-host-go`; the HTTP service never registers it. The existing
SwypikOS command API is separate and is not an OS sandbox.

The federated inner update now requires caller-supplied gradients instead of
manufacturing gradients from a scalar loss. Wiring the distributed coordinator
to actual model training is still outstanding.

## Start local inference

From `D:\ilaria`, in PowerShell:

```powershell
go run -tags gpu ./cmd/ilaria-serve -cuda -model D:/ilaria/data/forge/bitnet-2b4t/bitnet.nxtf -tokenizer D:/ilaria/data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json -port 8091 -max-tokens 128
```

For CPU, omit both `-tags gpu` and `-cuda`. From `D:\swypik-os`, in another terminal:

```powershell
go run ./cmd/swypik-os -ilaria-url http://127.0.0.1:8091
```

The service exposes `GET /health` and `POST /v1/chat`. Requests contain `prompt`
and optional alternating user/assistant `history`. Replies include `reply`,
`tokens`, and instrumented `calls` with a success flag. Access is loopback-only;
browser-origin requests are rejected. Inference is serialized, queue waits are
cancellable, and old complete turns are trimmed to fit the model context.
Optional `-workdir` registers a bounded, rooted read-only file tool.

An exported adapter is loaded before creating the decoder with
`-adapter PATH/adapter-step100` (without extension). The loader requires the
offline base format, matching projection shapes and finite weights. It does
not cryptographically identify the base checkpoint: keep the matching base,
tokenizer and adapter together. Random smoke-test adapters are rejected.

## What was observed on this machine

- Actual GTX 1660 Ti inference with the existing BitNet checkpoint returned
  `437340123` for `48213 * 9071`, using a successful `calc` call.
- A separate request recalled `SwypikOS` from supplied conversation history.
- The SwypikOS Go client passed a live request against that service and received
  the project-name recall from the real model.
- CPU/CUDA LoRA parity passed on the GPU using a small synthetic adapter.
- Tiny CPU SFT changed LoRA weights; interrupted/resumed training matched an
  uninterrupted run exactly. Two-process CPU DDP also passed.
- These checks are integration evidence, not a language-quality benchmark.
  Eight-GPU training has not been tested.
- The inspected files included a trained vision Stage 1 projector (step 2000).
  No trained Stage 2 LoRA export was found in the local directories at that time. The inspected audio projector
  metadata did not establish a training step. Real inference above used the
  base language model, without a newly trained SwypikOS adapter.

Existing model artifacts were only read for verification. No production model
training was started and no model artifacts were modified.

Final verification: `go vet ./...` and the full uncached Go test suite passed
in both projects. Ilaria cortex tests completed in 40.482 seconds. All 21 Python
holdout, tool-data, trainer, distributed, LoRA and Stage 2 tests passed. The
temporary model service was stopped after live verification to release VRAM.
The symlink-escape test was skipped because this Windows account lacks symlink
creation privilege; the other file-root tests passed.

## Curate English tool trajectories first

### Follow-up Drive audit

The authenticated Drive audit subsequently found `ilaria/stage2_instruct/`
with `checkpoint.pt` and `stage2_export.{json,safetensors}`. The export metadata
reports step 6000, offline BitNet base, rank 16, alpha 32, and 210 LoRA modules.
This corrects the local-only inventory above; it does not establish held-out
quality. The old Colab notebook `ilaria_phase1_v5.ipynb` also records completion
of vision Stage 1 at step 2000, earlier dtype/evaluation failures, a missing
`langdetect` dependency during IFEval, and Drive disconnects during tokenization.

The self-contained `forge/colab/Ilaria_SwypikOS_H100_Pilot.ipynb` embeds the current
reviewed trainer sources without requiring a Git push. It includes a baseline,
gradient checkpointing, timing/memory reporting and a soft time budget. Training
is gated on curated data and an explicit notebook switch. Existing multimodal
artifacts must be evaluated and preserved before selecting the next starting
point. Eight-H200 resources have not been activated.

The downloaded Stage 2 export loaded successfully through `LoadBitNetLoRA` and
CUDA inference. It returned correct executed `calc` and `convert` results for
`48213 * 9071` and `10 km to mi`; these are smoke checks, not a quality benchmark.
The Drive copies were not modified. The local verification service was stopped.

The pilot notebook was uploaded and saved at
https://colab.research.google.com/drive/1hDz-7F1egm8U7KcUfHw3pmQev8TcAoG4
with H100/High-RAM selected. No Colab runtime was connected and no cloud training
cell was executed in this setup pass. Dataset curation and a held-out executed
benchmark remain prerequisites to the actual pilot. Notebook syntax and isolated
source-bundle imports passed; checkpointed tiny-model resume, deadline saving
and two-process DDP tests passed. The full Go suite and vet also passed.

Use separate JSONL files, one conversation per line:

```json
{"language":"en","task_id":"arithmetic-001","messages":[{"role":"system","content":"REPLACE WITH EXACT SERVING SYSTEM PROMPT"},{"role":"user","content":"What is 17 times 23? Use the calculator."},{"role":"assistant","content":"CALL calc: 17*23"},{"role":"tool","content":"391"},{"role":"assistant","content":"17 times 23 is 391."}]}
```

Get the exact serving prompt with `go run ./cmd/ilaria-serve -print-system-prompt`.
Use the same enabled tools when curating and serving. Tool observations must
come from actual executions. Include direct answers, successful calls, failed
calls with recovery, unavailable capabilities, and multi-turn clarification.
Do not claim that a file or application was changed when no tool confirmed it.

Assign stable task IDs before splitting. Keep paraphrases, translations and
variants of each task in the same partition. The validator catches shared task
IDs and exact normalized first prompts; it cannot detect every paraphrase.
Maintain an additional untouched execution benchmark to measure tool selection,
successful execution, final answer correctness and unsupported success claims.
Assistant-token validation loss alone is not an execution benchmark.

## Validate, then train

The new trainer uses the existing forge Python environment (PyTorch,
Transformers, safetensors and the dependencies of the offline BitNet loader).
All model files must already be local. The paths below are placeholders for
curated datasets and a new run directory; these datasets have not been created.

```powershell
python -m forge.train_tools --train TRAIN.jsonl --validation VALIDATION.jsonl --llm-dir D:/ilaria/data/pretrained/bitnet-b1.58-2B-4T --out RUN_DIR --validate-only
python -m forge.train_tools --train TRAIN.jsonl --validation VALIDATION.jsonl --llm-dir D:/ilaria/data/pretrained/bitnet-b1.58-2B-4T --out RUN_DIR --languages en --steps 1000 --rank 16 --alpha 32 --batch 1 --accum 8
```

Choose resources after measuring memory on a short real-model pilot; the local
6 GB GPU inference result does not imply the full trainer fits in 6 GB. Start
with a short run and compare the exported adapter to the base on held-out
executed tasks before increasing the training budget.

For Linux multi-GPU text/tool SFT, use `torchrun --standalone --nproc_per_node=N
forge/train_tools.py` with the same flags. This trains replicated model copies
with DDP, not model sharding. Each GPU must fit a full replica. Effective batch
size is `batch * accum * N`. Resume with the same command and `--resume`;
dataset hashes, run settings and world size must match. Windows PyTorch builds
without libuv need an appropriate rendezvous configuration; the automated
Windows DDP test uses direct workers with `USE_LIBUV=0`.

The trainer exports immutable step-named `.safetensors` / `.json` pairs and an
optimizer/RNG checkpoint. `--smoke` uses a tiny random CPU model and tests the
pipeline only. Never interpret smoke loss as Ilaria capability.

The separate multimodal Stage 2 trainer now uses deterministic image/prompt
holdouts, discards mixed-partition image sets, and rejects legacy training
resume without this split contract. It remains single-process. Export old
checkpoints for inference if needed, but start a fresh run to establish held-out
evaluation. Content hashing does not eliminate semantic near-duplicates;
dataset-level curation remains necessary.

## Expand languages after the English baseline

Pass explicit language codes, for example `--languages en,ro`, only when both
training and held-out evaluation cover them. Keep task IDs shared across
translations to prevent leakage. Report quality and execution results per
language, including low-resource languages. Adding language codes does not
automatically teach a language. Support for all world languages is a long-term
objective, not a capability established by this change.

## Verification commands

```powershell
go vet ./...
go test -count=1 -timeout 180s ./...
go test -tags gpu ./cortex -run '^TestBitNetLoRACUDA$' -count=1 -v
python -m unittest forge.test_holdout forge.test_tool_data forge.test_train_tools forge.test_distributed_tools
```

Run Go vet and tests separately in SwypikOS as well. With the service running,
set `SWYPIK_ILARIA_TEST_URL=http://127.0.0.1:8091` and run
`go test ./core/ilaria -run TestLiveIlariaBackend -count=1 -v` there. Ordinary test
runs skip this live-model check. Lightweight organism tests disable the unrelated
large fractal subsystem; fractal-specific tests still exercise it at a small size.
