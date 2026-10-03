# Production corpus strategy alignment

State: STOP/FROZEN — VERIFIED, READY FOR SELECTIVE INTEGRATION.

Branch: codex/production-strategy-alignment-20261002
Worktree: E:\nexus-worktrees\production-strategy-alignment-20261002

Exclusive claims:
- ilaria/forge/config/corpus_strategy.json
- ilaria/forge/test_corpus_strategy.py
- this handoff

All other seeded files in the worktree are read-only snapshots of current Main used
only to exercise the present production source plan and rights contracts.

## Change

The strategy config had drifted behind the content-addressed production source plan:
it still preferred Zephyr for code and first_party_math for math/science, while the
actual production plan selects opencode_reasoning_split0 and
openmath_reasoning_cot.

The alignment changes only policy metadata:

- general_english preferred wiki_en -> ELIGIBLE
- code preferred source becomes opencode_reasoning_split0 -> ELIGIBLE
- Zephyr becomes code supplement; still ELIGIBLE under approved rights evidence
- math_science preferred source becomes openmath_reasoning_cot -> ELIGIBLE
- first_party_math becomes not_default and keeps OWNERSHIP_ATTESTATION_REQUIRED
- openscience_reasoning_2 supplement -> ELIGIBLE
- preferred/supplement OS sources that are already rights-approved become ELIGIBLE
- first_party_contracts and first_party_trajectories retain ownership-attestation
  semantics unchanged

No first_party_math ownership flag, attestation, rights registry, source plan,
production_readiness implementation, tokenizer pipeline or dataset artifact is
changed.

## Evidence

Rights registry/evidence for every newly ELIGIBLE strategy source is already:
- status=APPROVED
- commercial_use_approved=true
- unresolved_obligations=[] in the evidence packet

Direct alignment proof:
E:\nexus-training\evidence\production-strategy-alignment-20261002\alignment-proof.json

The proof reports:
- strategy_ready=true
- strategy_blockers=[]
- production_plan_ready=true
- production_plan_blockers=[]
- preferred code=opencode_reasoning_split0
- preferred math_science=openmath_reasoning_cot
- first_party_math_is_preferred=false
- first_party_math_required_by_source_plan=false

## Verification

- corpus strategy + production source plan: 12/12 pytest PASS
- production_source_plan.py direct validator: ready=true, blockers=[]
- py_compile corpus_strategy.py + production_source_plan.py: PASS
- LSP/Pyright on changed Python test: 0 diagnostics
- GOWORK=off go test -count=1 -timeout 180s ./...: PASS
- go vet ./...: PASS
- git diff --check on the two claims: PASS

No cloud/GPU job, training, data acquisition, secret read, Bridge/config mutation,
stage, commit, push or deploy occurred.
