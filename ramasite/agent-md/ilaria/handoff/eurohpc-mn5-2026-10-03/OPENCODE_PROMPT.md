Implement one complete, local, reviewable EuroHPC MN5 preparation adapter for
Ilaria's existing random-init IMC trainer. No remote job/submission or GPU proof.

Work only in `C:\Users\abel\.codex\worktrees\ilaria-eurohpc-mn5\nexus` at
baseline `3790d965826a9273017e5eca67e7f5d4727c4edb`, without Main's overlay.
Read its root/nested Ilaria AGENTS and `ramasite/RELOCATIONS.json`; verify the source
hashes in the adjacent `BASELINE.json` and the approved `CLAIMS.md`. The worktree
is detached: branch creation was permission-denied. This dedicated worktree meets
the branch/worktree isolation rule; source writes have not been tested or claimed
blocked. Do not retry branch creation, alter Git HEAD/index/history, bypass the
refusal or write implementation on Main. Edit only claimed regular files in this
worktree. If OpenCode receives an actual source-write refusal, report it and stop
without a workaround.

Dispatch prerequisite: the coordinator must supply guardian READY, a live OpenCode
MCP session, fresh cost evidence, budget gates 500/400/30, max one job and a returned
handle. Do not pretend dispatch/READY based on this prompt. Do not spawn agents.

Claims: only new files in `ilaria/forge/eurohpc/` (`__init__.py`, `contract.py`,
`prepare.py`, `runtime.py`, `node.py`, `hardware.py`, `mn5.example.json`),
`ilaria/forge/test_eurohpc.py`, and
`ramasite/docs/ilaria/runbooks/EUROHPC_MN5_IMC.md`. Prefer fewer adapter modules;
avoid another hardware/supervision/package framework. Do not touch the existing
model/trainer/tokenizer/freeze/recipe/contracts/Colab controller or other products.

Use these canonical interfaces, verified at the baseline:

- `imc_125m_preflight.validate_imc_125m_readiness` and
  `imc_125m_launch.build_launch_manifest` / `validate_launch_manifest` for the
  existing 125M scale-validation recipe and hash-bound trainer arguments.
- `gpu_preflight.probe_torch_cuda` / `assess_gpu_report` for actual CUDA inventory.
- `training_launch_gate.assess_launch` for the matching production/pilot metadata
  scope, with the reviewed qualification, decision, assignment, validation receipt,
  rights/evidence/lock, readiness and curriculum. It does not authorize allocation.
- `qualified_tokenizer_contract.admit_contract`,
  `qualified_pilot_v2.validate_artifacts` / `admit_metadata` /
  `supervise_canonical` only where the approved scope/topology fits. Never use the
  pilot contract to qualify production. Preserve independent replay requirements.
- Existing `imc_nccl_bootstrap.probe.source_closure` / `verify_sources`,
  `Limits` / `Supervisor` / containment, and
  `imc_nccl_hardware_gate.gate.HardwareContract` / `validate_identity` /
  `execute_gate` only where their contracts fit. Existing bootstrap is eight H200
  per host; hardware gate is eight GPUs per host; clean-v2 supervisor is one node.
  Report their incompatibility with MN5 four-GPU nodes, keep execute refused,
  and do not clone or silently weaken these contracts.
- Canonical persistent `training_state` checkpoint/resume, atomic IMC export and
  `imc_125m_promotion_evidence` evaluation binding. Promotion requires the locked
  ternary/control × seeds 7/11/19 matrix, not successful job exit.
- Independent contamination verifier:
  `ramasite/benchmarks/ilaria/production_contamination_clearance/verify.py`.

Deliverables for this lot:

1. Strict versioned, explicit config and pinned environment/source/staging manifest.
   Unknown account/QoS/partition/shared storage/software versions are required input,
   not invented defaults. Example values must be visibly unresolved and refuse use.
   Reject unknown keys, duplicate/nonfinite JSON, control characters, unsafe paths,
   shell injection, links/escapes and invalid numeric/rank geometry. Use argv arrays,
   never interpolated shell commands. Staging hashes file bytes only from explicit
   approved inputs; no traversal of private/ignored data and no network downloads.
2. A default dry-run plan separating CPU admission, actual H100 inventory and NCCL
   qualification. Generate reviewable `sbatch` content and `srun`/`torchrun` argv:
   one agent per node, 1–4 GPU ranks per node, proper world/node/local rank mapping,
   explicit stable rendezvous endpoint/id and no multi-node `--standalone`. Reuse
   canonical launch arguments; no second training loop. Never execute `sbatch`.
3. Configurable per-job GPUh ceiling, remaining/reserved GPUh and explicit cost
   framework; account conservatively for multi-node/full-node exclusivity and CPUh
   conversion. User-declared 12,000 GPUh is an award size, not a spend command or a
   verified remaining balance. Leonardo's 64,000 GPUh is under evaluation, unusable.
   Existing Brev 100USD is not the current resource total; API budget does not expand.
4. Persistent checkpoints/resume/export instructions, hashes and run identity,
   bounded logs and SIGTERM/grace semantics with limits accurately stated. Existing
   trainer does not guarantee a new SIGTERM checkpoint; periodic atomic checkpoints
   plus graceful stop-after preserve earlier state. Do not add checkpoint/training
   logic or modify the trainer. If existing canonical supervisor cannot support the
   planned scope, stop at preparation and clearly refuse execute rather than invent
   a replacement. Never hide failed/missing qualification behind booleans.
5. Execute is refused if any dataset/tokenizer/rights/independent evaluation replay
   is absent, stale, mismatched, pending or FAIL. Preserve old contamination blockers
   until version-specific independent clearance qualifies the replacement. No
   allow-unmanifested-data, fake qualified=true, pretrained LLM or launch bypass.

Official sources reviewed 2026-10-03 08:17:45 UTC; cite exact URLs in the runbook:
https://www.bsc.es/supportkc/docs/MareNostrum5/overview/
https://www.bsc.es/supportkc/docs/MareNostrum5/slurm/
https://www.bsc.es/supportkc/docs/MareNostrum5/logins/
Overview lists four H100/node and 64GB; runtime inventory, not documentation, must
determine actual memory without guessed 64/80GB thresholds. Slurm requires account
and QoS (`bsc_project list`, `bsc_queues`), <=4 GPUs/node, 20 CPU/GPU and explicit
`srun --cpus-per-task`; multi-node is exclusive and accounting is CPUh-based.
Public ACC login is personal SSH and transfers originate locally; do not access
or alter credentials. Filesystem/software docs were unavailable: storage/modules
remain unresolved. This torchrun design is not proof of MN5 NCCL qualification.

Test only affected, necessary behavior: GPUh/CPUh/budget boundaries; unsafe configs
and injection; generated Slurm syntax (use a shell parser only if available, else
record unverified syntax); single/multi-node rank/rendezvous/env geometry; dispatch
to canonical trainer; missing/FAIL/stale/contaminated evidence refusal; timeout,
bounded log and stop behavior only where canonical supervision is actually reused.
Never describe mocked/local tests as H100/NCCL execution proof. Run affected tests
and `git diff --check`; report any skipped runtime validation honestly.

No secrets/profiles/private onboarding/corpus/weights, Bridge, Git stage/commit/push,
cloud allocation/spend, downloads, publication, crypto or deployments. Finish with
changed paths, test results, evidence limitations, explicit execution blockers and
one next concrete step. STOP after the local reviewable lot.
