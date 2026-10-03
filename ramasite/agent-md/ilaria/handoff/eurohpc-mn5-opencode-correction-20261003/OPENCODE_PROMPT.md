Correct exactly two current-trainer compatibility gaps in the existing local MN5
preparation adapter. Work only in
`E:\nexus-worktrees\ilaria-eurohpc-mn5-correction-20261003`, dedicated detached
baseline `25b7c65d39955ae221f9e9e368458038103fcd27`. Read root/Ilaria AGENTS,
RELOCATIONS and the adjacent BASELINE.json/CLAIMS.json before edits. Verify all
24 current canonical pins, seven copied candidate hashes and three frozen hashes.
History is separated under this coordination directory; it is evidence, not the
current worktree or trainer baseline. No Main overlay or old-worktree rebase.

Exclusive editing claims: `ilaria/forge/eurohpc/contract.py`,
`ilaria/forge/eurohpc/prepare.py`, `ilaria/forge/test_eurohpc.py`, and
`ramasite/docs/ilaria/runbooks/EUROHPC_MN5_IMC.md`. Freeze `__init__.py`, `node.py`
and `mn5.example.json`; do not create runtime.py/hardware.py or edit any canonical
source, model/trainer/tokenizer/freeze/recipe, global launcher, other product or
Main file. Handoff only under
`ramasite/agent-md/ilaria/handoff/eurohpc-mn5-opencode-correction-20261003/`.
Actual source-write refusal means report and stop without a workaround.

Independent final review of the initial lot: 111 tests passed, preparation-only
refusal before config, no allocation, inert sbatch exit78, 14 inputs and historical
baseline stable. Its verdict was BLOCKED for current Main compatibility, not a
production/admission PASS. Receipt SHA256:
`61368a3e7d9d79c7006aa60e908c33c653da54c0bd672e5beeebb795639cc658`.
Findings: contract.py lines262-271 cannot express first-party attestation/root;
prepare.py lines126-142 retain old trainer argv and omit required resume SHA256.

Current canonical trainer SHA256 is
`f5e748bb3e5676f747bc8fcbd5cb2e0853e0b9e5406d76e69c89364b957afbdc`.
Its actual CLI uses repeatable `--first-party-attestation SOURCE=PATH` and
`--first-party-root` (not an invented attestation-root flag).
`parse_first_party_attestations` rejects malformed/duplicate SOURCE mappings;
attestations require the root. Production resume with --dataset-manifest requires
`--resume PATH --resume-sha256 <lowercase 64-hex>`, and SHA without resume is refused.
Verify these public source interfaces locally; never open attested corpus trees,
checkpoint/weight files or private inputs to prove argument transport.

Extend strict config/reference transport for these real flags. Validate unsafe,
missing, duplicate, conflicting or mismatched values and bind references/hashes
to deterministic review output/run identity. Keep first-party entries in stable
source order and reject duplicate flag injection. Reuse current canonical
imc_125m_preflight/launch functions and canonical trainer parsing/validation where
appropriate; preserve the validated base launch and clearly bind any adapter CLI
extension. Do not silently reinterpret old launch identity, weaken a validator,
manufacture qualification, or introduce a second training/manifest pipeline.
If current interfaces cannot support this within four claims, retain refusal and
return the exact scope blocker; do not edit the global launcher or trainer.

Maintain unconditional execute refusal in both entry points, inert Slurm script,
all missing/stale/FAIL evidence and contamination blockers, independent replay,
scope separation, rank/rendezvous geometry, accounting and existing safeguards.
GPUh/CPUh/budget accounting must remain unchanged. No MN5 allocation, submission,
GPU/NCCL execution, authentication, downloads or training. Existing incompatible
eight-GPU qualification and one-node supervision remain blocking. No pretrained
model, bypass flag, fabricated ready bit or code-only-to-production promotion.

Add meaningful affected tests: exact first-party/root argv and source order,
attestation/root absence/mismatch, duplicate/unsafe mappings and paths, known-key
schema handling, exact resume path+SHA flag and identity binding, missing/malformed/
mismatched SHA, no resume flags when absent, deterministic repeated plans, current
CLI compatibility and preservation of unconditional refusal/accounting. Use only
synthetic approved public fixtures and mocks; no payload, weight or remote access.
Run necessary affected suites, Bash syntax parsing only if usable, git diff --check
and claimed-new-file checks without staging. Recheck all current canonical and
frozen source hashes. Update the runbook's compatibility/version limits honestly.

This is one local corrective OpenCode job. No native subagents, additional paid
prompts/jobs or self-dispatch. The coordinator alone owns the live guardian/cost
loop: USD500 monthly, USD400 stop, USD30 lot, maximum one model job, absolute
deadline <=30 minutes. The task may be sent only after live owned guardian READY,
fresh finite local cost, actual prior API0 jobs, current pins/no Main collision and
existing Azure GPT6.1 session model have been verified. Do not invent those facts.
Do not inspect model/provider settings, keys, profiles, Bridge or credentials.
No Git stage/commit/reset/clean/push/ref/index/history changes, deployments,
publication, other LLM downloads or cloud operations. STOP after a local reviewable
handoff with changed paths/hashes, tests, exact current baseline and limitations.
