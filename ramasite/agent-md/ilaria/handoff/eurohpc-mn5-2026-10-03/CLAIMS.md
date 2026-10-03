# EuroHPC MN5 preparation claims — 2026-10-03

Status: HANDOFF_PREPARED_ONLY. No implementation, GPU proof, remote operation,
account change, job submission, OpenCode dispatch, stage, commit or push occurred.

Baseline: `3790d965826a9273017e5eca67e7f5d4727c4edb`.
Dedicated attached worktree: `C:\Users\abel\.codex\worktrees\ilaria-eurohpc-mn5\nexus`.
Its tracked status was empty; no Main overlay was copied. The requested branch
`codex/ilaria-eurohpc-mn5` could not be created: the effective shell permissions
refused the Git ref lock. The worktree remains detached. Do not bypass this
restriction or implement on Main. These three coordination records are the only
new files written, in the explicitly authorized Main record directory.

## Approved implementation boundary

New files may be claimed under `ilaria/forge/eurohpc/`: `__init__.py`,
`contract.py`, `prepare.py`, `runtime.py`, `node.py`, `hardware.py`,
`mn5.example.json`; tests in `ilaria/forge/test_eurohpc.py`; documentation in
`ramasite/docs/ilaria/runbooks/EUROHPC_MN5_IMC.md`. This is a maximum file set,
not a requirement to create seven modules. Prefer a smaller complete preparation
adapter if runtime work would duplicate infrastructure. Send revised claims before
touching any other path. Plans/handoffs belong under `ramasite/agent-md/ilaria/`.

Nonoverlap: do not edit architecture, model, trainer, tokenizer, freeze, recipe,
existing qualification/hardware/containment/package contracts, Colab controllers,
RELOCATIONS, merge/conflicts, site, OS, commerce or any other product.

## Resources and operational gaps

- User-declared award: EHPC-AIF-2026FL01-1157, **12,000 GPUh**, MN5 ACC H100.
- User-declared Leonardo application: **64,000 GPUh**, **under evaluation**.
- Neither declaration verifies account activation, login, project association,
  accessible partition/QoS, billing conversion, storage persistence or environment.
- Azure/AWS credit declarations and historic Brev limits do not change the
  authorized API budget or permit cloud spend. No secrets, profiles, credentials,
  private onboarding, corpus payloads or weights were inspected.
- Current generic CUDA gate is configurable. The historic NCCL bootstrap expects
  eight H200 GPUs on one host; the newer hardware gate still assumes an eight-GPU
  host/topology. They cannot certify a four-GPU MN5 node or two nodes merely by
  relabeling configuration. The clean-v2 supervisor uses one-node `--standalone`.
  Keep incompatible execution explicitly blocked; do not fork their logic.
- Qualification metadata is not independent replay or production admission.
  Old contamination remains a blocker until the new version has independently
  qualified dataset/tokenizer/heldout/evaluation separation.

## Official evidence checked at 2026-10-03 08:17:45 UTC

The [BSC MN5 overview](https://www.bsc.es/supportkc/docs/MareNostrum5/overview/)
describes four H100 GPUs and 80 CPU cores per ACC node and lists GPU memory as
64GB. This is documentation, not an observation of allocated hardware; record
runtime bytes and do not force a guessed 64/80GB qualification threshold.

The [BSC Slurm guide](https://www.bsc.es/supportkc/docs/MareNostrum5/slurm/)
requires an account and QoS. `bsc_project list` and `bsc_queues` are the documented
inventory commands. The guide specifies 1–4 GPUs per node and 20 CPU cores per GPU,
and says multi-node allocations are exclusive; GPU accounting is expressed in
CPU hours. Select account/QoS/partition only from authorized nonsecret evidence,
and distinguish GPUh estimates from the provider's actual charging unit.

The [BSC login guide](https://www.bsc.es/supportkc/docs/MareNostrum5/logins/)
documents personal SSH access through public ACC login nodes and local-side
transfers through transfer nodes. This handoff did not authenticate or transfer.
The BSC filesystem/software pages were unavailable to this lookup; do not infer
an active shared storage path, installed module version or runtime environment.

The planned one-`torchrun`-agent-per-node pattern is an adapter design, not a BSC
guarantee of PyTorch qualification. BSC's NVIDIA HPC SDK MPI launcher exception
must not be confused with PyTorch NCCL, which needs its own runtime qualification.

## Acceptance and stop boundary

Local tests must prove refusal and command/config semantics, not claim GPU proof.
Cover accounting, injection/unsafe config, Slurm syntax, rank/rendezvous mapping,
single/multi-node plans, canonical dispatch and stale/missing/FAIL evidence.
Use affected tests and `git diff --check`; no general suites or downloaded runtime.

OpenCode may receive this prompt only after the supervising coordinator reports
guardian READY with live MCP, fresh cost evidence, the 500/400/30 limits and at most
one job. No handle exists in this handoff and no dispatch is claimed. Actual
`sbatch`/allocation/training is outside this lot. STOP after handoff.
