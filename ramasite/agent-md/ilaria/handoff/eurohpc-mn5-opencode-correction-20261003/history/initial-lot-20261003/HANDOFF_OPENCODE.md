# OpenCode local MN5 adapter handoff — 2026-10-03

## Outcome

Implemented one preparation-only adapter in the accepted dedicated detached
`E:\nexus-worktrees\ilaria-eurohpc-mn5-20261003` worktree. Baseline HEAD remains
`3790d965826a9273017e5eca67e7f5d4727c4edb`. No Main overlay was used.
Read root/Ilaria instructions, RELOCATIONS, immutable BASELINE and approved CLAIMS.
All 24 BASELINE source byte hashes and lengths matched initially and after edits.
Historical C: worktree/dispatch metadata was not treated as current authorization.

Actual source writes succeeded. No source-write permission refusal occurred.
No branch retry, ref/history/index operation, staging, commit, reset, clean or push.
No native subagents, additional model job, cloud allocation/spend, authentication,
downloads, SSH/transfer, submission, GPU execution, publication or external message.
Existing model/trainer/tokenizer/freeze/recipe/gates/controllers/products are unchanged.

## Changed paths

- `ilaria/forge/eurohpc/__init__.py`
- `ilaria/forge/eurohpc/contract.py`
- `ilaria/forge/eurohpc/prepare.py`
- `ilaria/forge/eurohpc/node.py`
- `ilaria/forge/eurohpc/mn5.example.json`
- `ilaria/forge/test_eurohpc.py`
- `ramasite/docs/ilaria/runbooks/EUROHPC_MN5_IMC.md`
- This authorized coordination handoff only; BASELINE/CLAIMS are untouched.

## What is reviewable

Strict versioned config, deliberately unresolved example, individually approved
nonignored text-byte staging hashes, canonical source-pin manifest shape,
conservative GPUh/CPUh estimates and remaining/reserved/per-job boundaries.
One-node/multi-node Slurm and static-rendezvous torchrun argv reuse the canonical
125M launcher trainer suffix; no second training loop. Scope-matching canonical
metadata admission reports are preserved, not converted into allocation authority.

Preparation output is bounded. Generated sbatch content is inert (`exit 78`,
comment-only srun); both `--execute` entry points refuse before file reads.
Prior preflight/launch reports are reference-only, never independent replay.
Optional CUDA inventory implementation calls the canonical probe, but was not run
on hardware. Requested runtime log/stop limits are explicitly UNAVAILABLE because
the incompatible canonical supervisor is not reused. Checkpoint/export/resume and
promotion instructions retain canonical signatures/hashes and the locked matrix.

## Validation

Final affected command, from `ilaria/`:

```powershell
python -B -m pytest -q -ra -p no:cacheprovider forge/test_eurohpc.py forge/test_imc_125m_launch.py --basetemp 'C:/Users/abel/AppData/Local/Temp/2/opencode/mn5-adapter-tests-accepted-20261003'
```

**111 passed in 3.60s; no skipped tests.** Bash parser validation of generated
script syntax passed. Synthetic reports/mocks test inventory dispatch and refusal,
not H100/NCCL execution. Temporary synthetic test files stayed in the approved
OpenCode temporary location. No corpus/checkpoint/weight bytes were inspected.

`git diff --check` passed. Claimed untracked files were additionally checked with
`git diff --no-index --check -- /dev/null <path>` without staging them. Source pins
and HEAD were rechecked. General model/Go suites were not run: their sources are
untouched and this lot explicitly requested only affected necessary tests.

## Remaining execution blockers / evidence limits

- No resolved/verified account, QoS, partition, shared storage/persistence,
  environment/module/NCCL/driver versions or billing conversion/live balance.
- Text staging does not copy data or verify corpus/tokenizer/checkpoint/export
  payload bytes; canonical source-closure replay remains mandatory.
- Dataset/tokenizer/rights admission, independent evaluation replay and
  version-specific contamination clearance are not established. Old contamination
  blockers are retained; caller PASS/qualified booleans do not qualify replacements.
- No actual H100 inventory or MN5 NCCL proof. Canonical bootstrap expects eight
  H200/host, hardware gate eight GPUs/host, and clean-v2 supervision one-node
  pilot-only standalone. None can qualify this four-H100/node production topology.
- No Slurm/site semantic validation, remote storage/link inspection, runtime
  timeout/log containment, TERM/teardown proof or guaranteed fresh TERM checkpoint.
- No allocation authority or promotion; 12,000 GPUh award is not a spend command
  or verified balance, Leonardo 64,000 GPUh under evaluation is unusable, and API
  budgets are independent of historic Brev/resource declarations.

## Coordinator-supplied dispatch evidence

The current prompt supplied session `ses_eff1d50daffeZIZF9K8o6UiRmi`, guardian
READY PID8460, deadline `2026-10-03T09:00:18.739Z`, monthly cost USD40.4284717,
actual active jobs 0 and model `azure/gpt-6.1-sol`. These are coordinator-supplied
facts, not independent guardian/API observations by this adapter. Coordinator owns
USD500 monthly / USD400 stop / USD30 batch / 30-minute / max-one-job enforcement.
No dispatch/READY was fabricated from historical handoff metadata.

## Next concrete step / stop

Coordinator reviews this local lot against resolved, independently evidenced MN5
site/storage/environment/balance inputs. Submission remains unauthorized; a later
separately scoped qualification/containment lot is required for execute capability.
STOP after this local reviewable lot.
