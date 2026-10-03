# IMC-125M first-party trajectory milestone — 2026-09-30

## Scope completed

The Genesis data path now has a deterministic, verifier-backed first-party
source for the two previously empty curriculum lanes:

- `agent_tool_trajectories`
- `world_device_trajectories`

The source name is `first_party_trajectories`. Candidate generation is allowed
with an unsigned provenance template, but inventory keeps it out of approved
counts and curation refuses it until ownership is explicitly attested.

## Generator and quality gate

Canonical implementation/config:

- `forge/verified_trajectory_corpus.py`
- `forge/config/imc_125m_trajectory_generation.json`
- `forge/config/first_party_trajectories.attestation.json`

The generator uses deterministic content-addressed task IDs, verifier evidence
hashes, resumable hashed shards, reserved IlariaLex protocol tokens and
first-party attestation scope binding.

Current family coverage:

- 12 agent/tool task families
- 10 world/device task families

Canonical quality evidence:

- `bench/imc_125m_trajectory_quality/RESULTS.json`
- quality SHA-256:
  `acd5ffdfabf9d386ee6edf29d8331c60ae736177add6f1a447d2844a1c56fb70`
- 10,000 sampled documents per lane
- agent/tool unique text: 999,800 ppm
- world/device unique text: 998,300 ppm
- maximum family share: 86,500 ppm agent/tool, 106,600 ppm world/device
- production maximum family share policy: 125,000 ppm
- minimum unique text/evidence policy: 995,000 ppm

Quality can be recomputed without producing the large corpus:

```powershell
python forge/verified_trajectory_corpus.py `
  --quality-only `
  --quality-out bench/imc_125m_trajectory_quality/RESULTS.json
```

## Rights/provenance path

`forge/first_party_attestation.py` now separates:

1. content-addressed packet validation;
2. pinned workspace-file verification;
3. explicit ownership approval;
4. raw-source-manifest binding.

This distinction allows deterministic candidate data to exist before a human
ownership decision without ever treating that data as production eligible.

The same eligibility evaluator is used by:

- `forge/corpus_inventory.py`
- `forge/curate_corpus.py`
- `forge/dataset_manifest.py`

Therefore a first-party source cannot be approved by inventory while being
interpreted differently by curation or the immutable dataset manifest.

The canonical trajectory attestation is intentionally unsigned. Current
template identity:

`6114b514c626f8c79a31998265d277737ecf680f891901c0b99fd05e3cd53365`

Do not set `ownership_attested=true`, `attested_by`, or `review_ref`
automatically. Those fields are a human/legal provenance decision.

## Strategy and production readiness

`forge/config/corpus_strategy.json` now explicitly models
`agent_tool_trajectories` and `world_device_trajectories`, both preferring
`first_party_trajectories` and requiring ownership attestation.

`forge/production_readiness.py` independently checks:

- `first_party_contracts` attestation;
- `first_party_trajectories` attestation;
- recomputation of the canonical trajectory quality report.

The current production readiness result remains `ready=false`, correctly. The
trajectory quality gate is valid, while both first-party attestations are still
unsigned, external preferred sources still need manual rights review, and the
production tokenizer/dataset artifacts do not yet exist.

## Candidate volume target

The canonical generation config currently asks for:

- 320,000,000 text bytes for agent/tool trajectories;
- 200,000,000 text bytes for world/device trajectories.

This is a candidate-volume target intended to conservatively cover the 80M and
50M token curriculum allocations before exact IlariaLex token counting. Exact
lane token quotas must still be enforced by the frozen-tokenizer curriculum
stream builder; byte estimates are not a substitute for exact token counts.

Full candidate generation command:

```powershell
python forge/verified_trajectory_corpus.py `
  --out-dir data/candidate-corpus/first_party_trajectories
```

Do not run the large generation job while the cleanup agent is saturating the
host. Candidate output is gitignored and resumable.

## Next engineering steps

1. Run the full first-party trajectory candidate generation when local CPU/disk
   contention drops.
2. Re-run `corpus_inventory.py` with the trajectory source manifest and the
   `first_party_trajectories` attestation mapping.
3. Continue acquisition for the still-deficient code, math, science and
   OS/hardware lanes.
4. After explicit rights/ownership closure, curate all approved sources,
   freeze IlariaLex, build exact curriculum token streams and create the
   immutable dataset manifest.
5. Only after production readiness passes should the IMC-125M seed-7 training
   job be launched.
