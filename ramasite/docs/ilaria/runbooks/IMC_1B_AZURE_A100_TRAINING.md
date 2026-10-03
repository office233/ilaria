# IMC-1B Azure A100 training preparation

Date: 2026-10-01. Status: `PREPARATION_ONLY`, `launch_ready: false`.
Worktree: `codex/imc1b-azure-a100`. This preparation allocated no Azure training resources;
no real eight-A100/NCCL test has been performed. A100 40GB versus 80GB hardware
has not been selected. The user chose to keep the separate G4 IMC-125M pilot
running; its training/evaluation feedback should inform this study before
committing the full 20B-token compute budget.

The preparation contract is `forge/config/imc_1b_azure_plan.json`, validated by
`forge/imc_1b_azure_plan.py`. Its plan status is `PLANNED_NOT_READY`; validating
or printing a command template does not produce a launch approval or start
training. Missing data, hardware, distributed-resume and persistence evidence
remain explicit blockers.

Default `plan_sha256`:
`4b7302574dedbdaad8b470c50dc919358f5ce3eda73ddcf8e50293a9b7e6ebfe`.
Plan identity hashes canonical content excluding `plan_sha256`, rather than
serialized file bytes. Report/study identities also bind model/trainer sources.

From `ilaria/`, generate a report without allocating or training:

```powershell
python forge/imc_1b_azure_plan.py --profile a100-40gb-2k
```

Select `a100-80gb-2k` for the other baseline; `--out PATH` saves the report.
Report format is `imc-1b-azure-preparation-v1`; its command template contains
required production-path placeholders. Production-path flags are all-or-none
and only annotate the report. Every profile reports `launch_ready: false`
and `execution_authorized: false`.

The separate control plan is
`E:/nexus/ilaria/data/imc1b-azure-preparation/full-precision-control.plan.json`,
with `plan_sha256` `506040dd40538f30289fe63fdab3771a01df9be1bfa19c58756566d4577b2bfb`.
To reproduce it, copy the candidate plan, set `model.weight_mode=full_precision`
and `experiment={name:full_precision_control,ternary:false,seed:7}`, then
recompute `plan_sha256` with `plan_identity` and validate the new plan.

```powershell
python forge/imc_1b_azure_plan.py --profile a100-40gb-2k --plan E:/nexus/ilaria/data/imc1b-azure-preparation/full-precision-control.plan.json
```

Eight saved reports reside in `E:/nexus/ilaria/data/imc1b-azure-preparation/reports/`:
`<profile>.json` for candidate and `<profile>.control.json` for control, each
remaining preparation-only. The planner does not read production data or weights.

## Baseline and study identity

Train canonical **IMC-1B = 1,000,555,520 parameters** from random initialization
using `forge/imc_model.py` / `forge/train_ilaria.py`. IlariaLex has 65,536 IDs,
with EOS/protocol start 61,440. The 125M checkpoint provides pilot evidence;
it is not an IMC-1B initialization or exact-resume source.

| Draft baseline | Value |
| --- | --- |
| Processed training target | 20,000,000,000 tokens |
| Eligible train-corpus target | At least 20,000,000,000 tokens |
| Held-out validation target | At least 20,000,000 tokens |
| World size / context | 8 ranks / 2,048 tokens |
| Global batch | 524,288 tokens per optimizer step |
| Resolved horizon / exposure | 38,147 steps / 20,000,014,336 tokens |
| AdamW | LR 3e-4, minimum LR 3e-5, cosine, warmup 1,000 steps |
| AdamW / clipping | Betas 0.9 / 0.95, weight decay 0.1, grad clip 1.0 |
| Compute / memory policy | BF16, gradient checkpointing, chunked cross-entropy |
| Draft validation cadence | Every 250 steps, 64 iterations; benchmark before freeze |

At 2k context, 64 validation micro-batches sample 262,144 tokens on the 40GB
profile versus 1,048,576 on the 80GB profile; freeze the evaluation budget.

The 20B target is a bootstrap study. `MASTER_PLAN.md` permits later 100B+
continuation only with eligible data, time and measured quality gains; it is
not an immediate compute commitment. Chinchilla Table A3 estimates 20.0B tokens for
a 1B model under one fitting approach and 27.1B under another. Applying that
result to IMC is a planning heuristic, not a demonstrated optimum for this
architecture, tokenizer or curriculum. [Primary paper](https://arxiv.org/html/2203.15556v1)

Freeze plan/config identity, selected profile, model/trainer source SHAs,
dataset and tokenizer-freeze identities, first-party packets/source snapshot,
optimizer/evaluation settings and runtime versions together. Exact resume
also pins world size, rank topology and every rank's RNG state. Changing these
requires a new study identity rather than silently altering the running job.

## Provisional Azure profiles

Microsoft documents single-VM eight-GPU NVLink configurations for
`Standard_ND96asr_v4` (A100 40GB) and `Standard_ND96amsr_A100_v4` (A100 80GB).
Availability, quota, region and the actual assigned SKU remain to be checked.
[40GB specification](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/gpu-accelerated/ndasra100v4-series),
[80GB specification](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/gpu-accelerated/ndma100v4-series)

| Profile | Context | Per-rank micro-batch | Accumulation | Status |
| --- | --- | --- | --- | --- |
| `a100-40gb-2k` | 2,048 | 2 | 16 | `UNBENCHMARKED` |
| `a100-80gb-2k` | 2,048 | 8 | 4 | `UNBENCHMARKED` |
| `a100-40gb-4k-candidate` | 4,096 | 1 | 16 | Separate, unbenchmarked study |
| `a100-80gb-4k-candidate` | 4,096 | 4 | 4 | Separate, unbenchmarked study |

Each profile gives `8 × context × micro_batch × accumulation = 524,288`.
Micro-batch/accumulation are config-owned tuning choices: a changed, rehashed
plan must still realize this exact global batch and receives a new study identity.
The 4k candidate needs its own context/config identity, A100 memory/throughput
proof and validation study. It cannot replace a 2k job through exact resume.
No provisional micro-batch is a demonstrated memory-fit claim.

Accounting, before activations: FP32 parameters/gradients/Adam states total
about 14.909 GiB per rank; separate DDP gradient buckets add about 3.727 GiB,
and foreach AdamW temporaries may add another 3.727 GiB. Ternary STE training
still uses dense BF16 compute and full FP32 training state. The current
8,192-token × 65,536-vocabulary loss chunk implies 1 GiB BF16 logits plus
2 GiB FP32 logits before cross-entropy temporaries. These are planning
estimates; measure actual per-rank peak memory on both candidate profiles.

## Data expansion and held-out isolation

Preserve the existing English-first lane ppm and curriculum identity
`3ac9c6e0a36e85151e543dfbff09c8ea319b1566b6dd77d981cab8c8f34a4432`.
Current verified encoded inventory contains 1,346,605,848 train-side tokens
and 13,209,746 validation-side tokens. Materialized pilot streams are only
1B train / 2,097,152 validation. General-knowledge scarcity limits current
fixed-mix allocation to **1,088,819,235 train tokens**, despite larger totals.

| Lane | Ppm | Current eligible train | 20B target | Minimum additional train |
| --- | --- | --- | --- | --- |
| General knowledge | 300,000 | 326,645,770 | 6,000,000,000 | 5,673,354,230 |
| Code | 220,000 | 258,739,855 | 4,400,000,000 | 4,141,260,145 |
| Mathematics | 145,000 | 254,330,709 | 2,900,000,000 | 2,645,669,291 |
| Science / technical reasoning | 105,000 | 151,182,608 | 2,100,000,000 | 1,948,817,392 |
| OS / hardware / drivers | 100,000 | 181,919,399 | 2,000,000,000 | 1,818,080,601 |
| Agent / tool trajectories | 80,000 | 107,195,564 | 1,600,000,000 | 1,492,804,436 |
| World / device trajectories | 50,000 | 66,591,943 | 1,000,000,000 | 933,408,057 |
| Romanian / multilingual | 0 | 0 | 0 | 0 |
| Total | 1,000,000 | 1,346,605,848 | 20,000,000,000 | 18,653,394,152 |

The inventory deficit is a lower bound before stronger filtering. Relative
to the existing final 1B stream, materializing the 20B stream adds 19B tokens;
processing the same pilot stream repeatedly does not fill eligible-corpus
deficits. Add approved, pinned sources with file/source provenance and rebuild
audited manifests, coverage and final streams before asserting readiness.

| Validation lane | 20M target | Minimum additional held-out tokens |
| --- | --- | --- |
| General knowledge | 6,000,000 | 2,736,357 |
| Code | 4,400,000 | 1,793,322 |
| Mathematics | 2,900,000 | 387,587 |
| Science / technical reasoning | 2,100,000 | 572,267 |
| OS / hardware / drivers | 2,000,000 | 472,482 |
| Agent / tool trajectories | 1,600,000 | 497,592 |
| World / device trajectories | 1,000,000 | 330,647 |
| Total | 20,000,000 | 6,790,254 |

Current validation stock supports only 10,878,811 tokens at the fixed mix.
Preserve all existing holdouts and benchmark exclusions. The current audit
proves exact-normalized uniqueness and zero detected 12-word-shingle matches
against its frozen exclusion set; it does not prove task-family novelty or
absence of semantic near-duplicates. Cluster near-duplicates and isolate
repository/problem/scenario families across splits before accepting new data.
Verifiable trajectory outcomes and distinct evidence are required; many text
variants from the existing 12 agent and 10 world families are insufficient.

Inventory evidence: the pinned `training-gates-v1/encoded/encoded-lanes.manifest.json`,
`dataset.manifest.json` and `post-curation.audit.json` under
`E:/nexus/ilaria/data/production`. Do not publish held-out examples.
Original first-party attestations continue to cover their immutable approved
source snapshot; changed or additional sources need their own evidence.

## Eight-rank proof before freeze

Run one process per GPU with DDP/NCCL and verify independent rank sampling;
DDP does not partition inputs automatically. [PyTorch 2.11 DDP](https://docs.pytorch.org/docs/2.11/generated/torch.nn.parallel.DistributedDataParallel.html)

1. Record all eight A100s, VRAM, BF16 support, NVLink/NCCL topology and pinned
   Python/PyTorch/CUDA/NCCL/NumPy/driver versions. Confirm the assigned SKU.
2. Exercise full IMC-1B forward/backward/AdamW with the selected profile,
   gradient checkpointing and chunked loss. Record finite losses/gradients,
   per-rank peak VRAM, no OOM/deadlock and real steady-state throughput.
3. Demonstrate DDP synchronization, global 524,288-token accounting and
   validation/export barriers. Preserve rank-local RNG for all eight ranks.
   Audit all-visible-device CUDA RNG capture and measure each rank's VRAM.
4. Pause without shortening the 38,147-step horizon, publish a durable
   checkpoint/export receipt, terminate processes and resume all eight ranks.
   Verify source/data/runtime/signature hashes, rank RNG and optimizer progress.
   This proves state continuity; it does not promise bitwise equality across hardware/runtime changes.
5. Test rank/process failures and interruptions around export, checkpoint,
   receipt and remote-object publication. A prior complete generation must
   remain hash-valid and resumable, including its matching best export.

Existing CPU/Gloo two-rank resume tests and the 125M/G4 evidence are useful
mechanics checks; neither proves eight-A100/NCCL behavior. The trainer exposes
`torchrun`/DDP support. The existing Colab supervisor accepts one GPU only;
Azure launch/persistence orchestration still requires validation and freeze.
Local core compilation, 47 model tests (including two-rank CPU/Gloo resume),
`go test ./...`, `go vet ./...` and 61 planner tests passed. Planner tests cover
candidate/control argv through the actual trainer parser and argument validator,
stopping before production I/O. These checks provide no eight-A100/NCCL measurement.

## Durable publication and budget decision

Use persistent managed-disk storage and independently verified Blob backups.
Azure local temporary storage is suitable for replaceable caches, not the only
checkpoint copy. Rank 0 must publish atomic metadata after verifying complete
checkpoint, best-export and receipt generations; retain prior generations and
advance the committed pointer only after all hashes/upload checks pass.

The current trainer's files are individually atomic. A crash between replacing
a new best export and its checkpoint can invalidate the previous checkpoint's
adjacent best export. Complete-generation retention is therefore an unresolved
operational gate before a long Azure run. The immutable step-1750 G4 archive
is valid; this plan does not modify the running pilot's pinned code.

Measure aggregate A100 tokens/second, evaluation/save/upload overhead and restart
time on the chosen SKU. Estimate training hours as
`20,000,014,336 / (measured_tokens_per_second × 3,600)`, then add measured
overheads and a documented margin. Apply verified region/SKU pricing plus
storage/network costs and the user's deadline. Do not extrapolate G4 speed.
Review a bounded eight-rank study and pilot quality feedback before full spend.

Start fresh seed-7 ternary and matched full-precision-weight control with the
same BF16 compute, dataset, profile, exposure and evaluation policy. FP32
weights do not mean FP32 compute. Complete matched seeds 11/19 before promotion.
Freeze general/code/math/science, calibration, PCE and continual-regression
evaluations and stop/go criteria. Health/throughput and a single loss value
do not establish general capability; 20B completion alone is not promotion.
