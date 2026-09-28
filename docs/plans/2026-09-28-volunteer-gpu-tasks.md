# Volunteer GPU work for Ilaria (SwypikOS stage 7) — task specification v0

Date: 2026-09-28. Status: design, nothing implemented. Complements
`D:\swypik-os\docs\OS_PLAN.md` ("Contribuția GPU"): SwypikOS owns the client,
Nexus (this repo) owns task definitions, validation and model updates.

## Goal and non-goals

Users of SwypikOS may lend idle GPU time to improve Ilaria. The goal is useful,
verified work — not a claim that volunteer machines form one supercomputer.

- **In scope first:** evaluation runs, synthetic-data generation with automatic
  checks, and federated LoRA fine-tuning rounds on PCs with a capable GPU.
- **Later, only if measurements justify it:** low-communication data-parallel
  training (DiLoCo-style: many local steps, rare averaged updates) for models
  that fit entirely in one volunteer's VRAM.
- **Not planned:** pre-training on phones (iOS/Android background limits, heat,
  battery); tensor/pipeline parallelism over the internet; training on users'
  personal files or conversations.

## Device classes

| Class | Typical hardware | Allowed task types |
|---|---|---|
| A | desktop GPU ≥ 12 GB VRAM, mains power | eval, synth-data, lora-round |
| B | GPU 6–12 GB | eval, synth-data (small models) |
| C | laptop/phone, no discrete GPU | none (local inference only) |

The client reports measured capabilities; the coordinator never trusts a
self-declared class without a benchmark probe.

## Task lifecycle

1. **Opt-in.** The user enables contribution and sets limits: idle-only, on mains
   power, max temperature, max power, VRAM cap, daily traffic, disk. Stop is
   immediate and always available.
2. **Lease.** The coordinator (Azure, stage 6) leases a task to an authenticated
   device: `task_id`, `type`, versioned `manifest` (model/adapter hashes, data
   shard hashes, code version, limits, deadline), signed by Nexus.
3. **Verify inputs.** The client checks the signature and every artifact hash
   before running anything.
4. **Execute isolated.** Fixed task runner, no arbitrary code from the network,
   resource limits enforced, checkpoints for resumption.
5. **Submit.** Result + hashes + measured GPU seconds. Idempotent by `task_id`;
   duplicates are ignored, expired leases are re-issued.
6. **Validate.** Nexus accepts work only after checks (below). Nothing enters the
   model directly from a device.
7. **Account.** Report measured GPU seconds and accepted work separately from
   estimates. Any reward formula is decided after measuring real useful work.

## Task types

| Type | Input | Output | Validation |
|---|---|---|---|
| `eval` | model/adapter + frozen benchmark shard | replies + scores | same shard re-run on a trusted node for a random sample; scores must match |
| `synth-data` | generator adapter + seed prompts | candidate examples | automatic checks (calc/convert/compile/tests), dedup, PII scan, human sample review |
| `lora-round` | base + current adapter + public data shard | adapter delta | norm/NaN checks, held-out loss must not regress, robust aggregation (e.g. trimmed mean) across several devices on the same shard |

Replication (same task to 2–3 devices) is the default defence against faulty
or malicious results until a cheaper verification is proven.

## Data rules

- Training data is public-licensed or first-party data with a documented basis.
- User files, chats and store data are never collected by the worker. Any
  first-party dataset is curated centrally, PII-scrubbed (`forge/prepare_corpus.py`
  `scrub_pii`) and consented where required (GDPR).
- Every shard has a manifest with source, licence and hash.

## Measurements before scaling

Before promising any capacity: number of opted-in devices by class, median
contributed GPU-hours per device per day, task completion and rejection rates,
and quality gain per accepted GPU-hour compared with the same work on one rented
GPU. Scale only the task types whose gain is positive.

## First milestone

`eval` tasks only, on the frozen `bench/swypik-v1` benchmark, with 2–3 internal
machines acting as volunteers: signed manifest, lease/submit/retry, replicated
validation. Exit criterion: identical scores from a trusted re-run on 100% of a
sampled subset, and correct recovery after killing a worker mid-task.
