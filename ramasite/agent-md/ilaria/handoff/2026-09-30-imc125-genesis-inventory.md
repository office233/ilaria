# IMC-125M Genesis (English-first) — gate & data inventory, 2026-09-30

Continues `2026-09-30-imc125-genesis-colab.md`. Facts only; nothing below is PASS
unless stated with evidence.

## Status

**Production training has NOT started. No real run exists.** Every gate that
precedes GPU allocation is red on human-only decisions and on data volume.

## Files changed this session

- `docs/runbooks/IMC_125M_GPU_TRAINING.md` — required-evaluation list aligned
  with the locked English-first recipe (Romanian removed as a promotion eval).
- `docs/handoff/2026-09-30-imc125-genesis-inventory.md` — this file.

No code, config, rights or lock files were modified.

## Verified identities (recomputed from the live worktree)

| Item | Value |
|---|---|
| Curriculum identity (`load_curriculum`) | `3ac9c6e0a36e85151e543dfbff09c8ea319b1566b6dd77d981cab8c8f34a4432` — matches recipe pin |
| Recipe file SHA256 | `c68e6b220a3f184fdb43ced1f0f0b843768a1e94b97ccca80f409f1d231fa32d` |
| Rights evidence identity | `402e38f56c25af1dbb0c4fdc74993f766215d630be71074876f32c559056391e` |
| Corpus source lock identity | `c7a7305dc9cc72958b1cf787a234f68a64df746ac2f63e19c29b392743ae3e5f` |
| Git source lock identity | `f643020c68764eda809c3f316cf7027ee23bc60aad847eacad54e0dacbb7996f` |
| Lane budget | 300M / 220M / 145M / 105M / 100M / 80M / 50M / Romanian 0 = 1,000,000,000 |
| Horizon | ceil(1e9 / 262,144) = 3,815 steps → 1,000,079,360 tokens |

## Tests

`python -m pytest -q forge/` → **202 passed** (34 s, CPU host, torch 2.14.0+cpu).

## Gate status

`python forge/production_readiness.py` → `ready: false`. Blockers:

- `rights:wiki_en:status=REVIEW_REQUIRED`, `rights:zephyr:status=REVIEW_REQUIRED`
  (every other registry source is also `REVIEW_REQUIRED`; `approved_sources: []`)
- corpus strategy: zephyr (code/os_drivers/hardware) `MANUAL_SOURCE_REQUIRED`,
  wiki_en (general/math_science) `REVIEW_REQUIRED`,
  first_party_contracts `OWNERSHIP_ATTESTATION_REQUIRED`
- `first_party_attestation: first-party ownership is not attested`
- missing artifacts: coverage manifest, sample manifest, `ilarialex.json`,
  `ilarialex.freeze.json`, `dataset.manifest.json`

IMC-125M preflight and GPU preflight were not run: they require the missing
freeze/dataset artifacts and a GPU host respectively.

## Data inventory (actual bytes on disk, exact-normalized dedup via `data_audit.document_sha256`)

Token counts are **estimates** (bytes ÷ 4.0 to ÷ 3.2); a real count requires the
frozen IlariaLex, which does not exist yet.

| Source | Revision | Rights | Docs | Docs after dedup | Bytes | Est. tokens | Shard manifest |
|---|---|---|---|---|---|---|---|
| zephyr (SPDX-filtered, `E:\nexus-sources\staging\zephyr-corpus`) | `f0bdf59a0b7d1b4dadbec339662d764cba78138a` | REVIEW_REQUIRED | 13,417 | 13,417 | 104,931,325 | 26.2M–32.8M | shards `3b2bd1d3…`, `a865a9ff…`; tree manifest `48bd68f7…` |
| freertos_kernel (`data/candidate-corpus/freertos_kernel`) | `8be86d4a24fd4091f8f4192018423ab590f408db` | REVIEW_REQUIRED | 636 | 636 | 14,197,769 | 3.5M–4.4M | shard `5f4f91e5…`; tree manifest `bde0e1a1…` |
| wiki_en (`wikimedia/wikipedia` 20231101.en) | `b04c8d1ceb2f5cd4588862100d08de323dccfbaa` | REVIEW_REQUIRED | not acquired | — | — | — | — |
| golang_go / python_cpython / rust_lang / freebsd | pinned in git lock | REVIEW_REQUIRED | not acquired; Go/CPython/Rust classifiers not implemented | — | — | — | — |
| agent/tool, world/device trajectories | — | first-party attestation missing | none exist | — | — | — | — |

### Per-lane position against quota (best case: all candidates approved)

| Lane | Quota | Available (approved) | Candidate, est. | Deficit |
|---|---|---|---|---|
| general_knowledge | 300M | 0 | 0 (wiki_en not acquired) | 300M |
| code | 220M | 0 | ≤~37M shared with OS lane (Zephyr+FreeRTOS) | ≥183M |
| mathematics | 145M | 0 | 0 | 145M |
| science_technical_reasoning | 105M | 0 | 0 | 105M |
| os_hardware_drivers_standards | 100M | 0 | shares the ~37M above | ≥63M (after code split) |
| agent_tool_trajectories | 80M | 0 | 0 | 80M |
| world_device_trajectories | 50M | 0 | 0 | 50M |
| romanian_multilingual | 0 | — | — | — |

## Colab

- CLI `google-colab-cli 0.7.4` in `ilaria\.colab-cli-venv` (Windows shim, see prior handoff); `colab version` works.
- **No OAuth credential exists** in `%USERPROFILE%\.config\colab-cli`; `colab usage/sessions` would start interactive Google OAuth + phone 2FA. Not attempted.
- WSL: not installed (Windows optional feature `Disabled`).
- The prior handoff records a browser-created **G4 (RTX PRO 6000 Blackwell)** session at ~8.9 CU/h. Its current state is **unverified**; it may be an orphan billable session.
- No session was created, no compute used, `colab pay` never called.

## Blockers (human-only)

1. Rights review decisions (`ilaria-rights-review-decision-v1`) for every source to be used — at minimum wiki_en and zephyr — with all pinned obligations resolved and a real `review_ref`.
2. First-party ownership/provenance attestation for the tools/protocol contract set (`forge/config/first_party_tools_protocol.attestation.json`).
3. Google OAuth + 2FA for the Colab CLI (run in the user's own terminal).
4. Confirm/stop the possibly-active G4 Colab session.

## Blockers (engineering, large)

5. Acquire wiki_en at the pinned revision; build provenance-preserving topic filters for math/science subsets. Wikipedia alone is unlikely to supply 145M math tokens — a second math source needs selection and rights review.
6. Go, CPython and Rust exception-aware licence classifiers are now implemented and their pinned repositories have been scanned into candidate corpora. The code lane still needs materially more unique data: current candidate capacity is only ~82.4M–103.0M tokens against 220M.
7. 130M tokens of verifier-backed agent/tool and world/device trajectories: no generator/simulator pipeline exists at this scale.

## Next action

User decisions on blockers 1–4 and on data acquisition scope (see chat report).
Nothing further should be allocated on Colab until the dataset manifest exists.

## Continuation — 2026-09-30 09:26 +03:00

The manual shared-pool estimate above has now been replaced by an executable,
content-addressed candidate inventory:

- added `forge/corpus_inventory.py`;
- added `forge/config/imc_125m_inventory_lanes.json`;
- added `forge/test_corpus_inventory.py`;
- generated
  `bench/imc_125m_data_inventory/candidate-inventory.json`;
- reproducibility record:
  `bench/imc_125m_data_inventory/RESULTS.md`;
- inventory identity:
  `0c109f85d209c09acfc36a4f6e47217501347ce5a316b2b8e2af6327fb5e49d6`.

The inventory verifies source/shard hashes, performs global normalized-document
dedup, assigns every document to exactly one curriculum lane, keeps rights
status separate from candidate capacity, and supports exact IlariaLex counting
later through `--tokenizer`.

Current exclusive allocation for the two staged candidates:

| Lane | Candidate estimate | Best-case deficit |
|---|---:|---:|
| code | 0.163M–0.204M | 219.796M |
| OS/hardware/drivers/standards | 29.633M–37.038M | 62.962M |

Total staged candidate capacity is 29.796M–37.242M tokens across 14,053
documents / 119,129,094 text bytes. No normalized duplicates were observed
between Zephyr and FreeRTOS Kernel.

This is stricter than the earlier ~37M shared-pool estimate: the same bytes are
no longer counted simultaneously toward both code and OS/hardware lanes.

Rights remain unchanged: both sources are still `REVIEW_REQUIRED`, so approved
production capacity remains zero.

## Continuation — 2026-09-30 10:29 +03:00

The candidate inventory now includes all three already-staged language/runtime
trees at their locked revisions:

- Go `f91ce18c4db84c9f0fe271d1832f9cee91b58aa9`;
- CPython `115c297fdcc7d0fab41ed0e5c08f1b9cbec35976`;
- Rust `ea6bb45b74c24a026dab4187b1550e97b6985c8a`.

Their local repository remotes and HEADs were rechecked against
`forge/config/git_sources.lock.json` before inventorying. The regenerated
content-addressed inventory has identity
`da52a2e61856387f75ba934d2fab0fca3a323516bc7016b46e556cf7a343c73f`.

Updated candidate-only capacity (rights remain fail-closed):

| Lane | Documents | Text bytes | Estimated tokens | Best-case deficit |
|---|---:|---:|---:|---:|
| code | 56,305 | 329,481,830 | 82.427M–103.019M | 116.981M |
| OS/hardware/drivers/standards | 13,998 | 118,476,223 | 29.633M–37.038M | 62.962M |
| all current candidate data | 70,303 | 447,958,053 | 112.060M–140.057M | — |

No normalized duplicates were observed across the five inputs. Approved
production capacity is still zero because every source remains
`REVIEW_REQUIRED`; this update measures capacity only and grants no rights.

Fresh verification:

- `python -m pytest -q forge/test_corpus_inventory.py` -> 5 passed;
- `python -m pytest -q forge/` -> 207 passed;
- `python forge/production_readiness.py` -> `ready: false`, with the expected
  rights, ownership-attestation and missing production-artifact blockers.

Engineering priority is now unambiguous: acquire materially larger unique code,
general, math/science and trajectory sources with pinned provenance, while the
human rights/ownership decisions remain fail-closed. Do not allocate Colab
training compute before those artifacts exist.
