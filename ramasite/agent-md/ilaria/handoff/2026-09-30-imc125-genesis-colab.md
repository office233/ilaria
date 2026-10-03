# HANDOFF COMPLET — ILARIA / IMC-125M GENESIS ENGLISH-FIRST / COLAB

Data snapshot: 2026-09-30, ~00:40 Europe/Stockholm
Workspace canonic: E:\nexus
Proiect: E:\nexus\ilaria
Branch observat prin Bridge workspace registry: agent/nexus-clean-swyp-fast
Worktree: extrem de dirty, ~1033 changed files la ultimul snapshot.
Plan canonic: E:\nexus\ilaria\docs\plans\MASTER_PLAN.md
Runbook GPU: E:\nexus\ilaria\docs\runbooks\IMC_125M_GPU_TRAINING.md

## 0. REGULI CRITICE PENTRU RELUARE

- NU rula git reset --hard.
- NU rula git clean -fd / -fdx.
- NU face checkout/revert in masa.
- NU presupune ca HEAD-ul Git reprezinta starea live: repo-ul este foarte dirty si au lucrat agenti concurenti.
- Inspecteaza live fisierele inainte de orice patch.
- Nu modifica arhitectura IMC doar pentru a face training-ul mai usor.
- Nu declara "Genesis trained" pana cand checkpoint-ul real arata tokens_seen >= targetul rezolvat.
- Nu marca surse juridic APPROVED doar pentru a debloca training-ul.
- Nu salva sau copia tokenuri OAuth, coduri 2FA sau credentiale in repo.
- Google 2FA/OAuth trebuie refacut interactiv daca sesiunea CLI nu a ramas autorizata.

## 1. MODELUL CANONIC

Familie unica: IMC — Ilaria MicroCortex.
Model proprietary, random init, trained from scratch.
Nu reintroduce GPT/GPT2/DistilGPT, Llama, Qwen, Gemma, BitNet ca familie paralela, LoRA ca baza, Cortex/Broca/FractalCortex/RadioCortex legacy.

Primul run serios:
- preset: imc-125m
- exact parameter count: 125,882,112
- vocab: 65,536
- EOS ID: 61,440
- d_model: 768
- layers: 12
- heads: 12
- KV heads: 4
- FFN: 2,048
- max_seq_len: 2,048
- ternary path: da
- full precision control: da
- RMSNorm / RoPE / GQA / SwiGLU / tied embeddings

Scale ladder:
- 125M: 125,882,112
- 250M: 247,559,168
- 500M: 503,457,280
- 1B: 1,000,555,520

## 2. DECIZIA NOUA: GENESIS V1 ESTE ENGLISH-FIRST

Userul a decis explicit sa NU antrenam Genesis v1 pe Romanian.

Curriculumul canonic actual:
- general_knowledge: 300,000,000 tokens
- code: 220,000,000
- mathematics: 145,000,000
- science_technical_reasoning: 105,000,000
- os_hardware_drivers_standards: 100,000,000
- agent_tool_trajectories: 80,000,000
- world_device_trajectories: 50,000,000
- romanian_multilingual: 0

TOTAL = 1,000,000,000 target tokens.

Curriculum identity canonic (logical/content identity, ultima verificare):
3ac9c6e0a36e85151e543dfbff09c8ea319b1566b6dd77d981cab8c8f34a4432

Raw file SHA256 snapshot:
forge/config/imc_125m_curriculum.json
b51e5fcddcb08317c3b0bced28185427ae54817b5860c6391d1e03538b9b1a4e

Raw file SHA256 recipe:
forge/config/imc_125m_recipe.json
c68e6b220a3f184fdb43ced1f0f0b843768a1e94b97ccca80f409f1d231fa32d

Trainer recipe:
- target_tokens: 1,000,000,000
- global batch tokens: 262,144
- expected ceil optimizer horizon: 3,815 steps
- actual exposure at 3,815 full batches: 1,000,079,360 tokens

Romanian:
- dedicated pretraining quota = 0
- general_romanian removed from mandatory corpus strategy
- Romanian removed from required Genesis promotion evaluations
- tokenizer remains byte/Unicode capable

English-first regression after this change:
52/52 PASS.

## 3. ILARIALEX-65K

Contract:
- IDs 0..61,439 learned byte-level BPE
- IDs 61,440..65,535 protocol reserved
- protocol reserve = 4,096
- total vocab = 65,536
- EOS = <|ilaria:eos|>
- EOS ID = 61,440

English-first production coverage required:
- english
- code
- math_science
- os_drivers
- hardware
- tools_protocol

Romanian coverage is NOT required for Genesis v1.

IMPORTANT:
Production tokenizer is NOT yet trained/frozen on the final 1B-token corpus/sample.
Code and freeze infrastructure exist; final artifact still needs to be produced.

## 4. PCE / MYRIAD

PCE Transfer v2 is already PASS.
Canonical gate metrics from last verified run:
- seeds: 7, 11, 19, 23
- mean top1 advantage: +27.08 pp
- mean NLL advantage: +1.4159
- positive NLL: 4/4
- positive top1: 3/4
- known anchor retention: 4/4
- early stopping: 4/4

Canonical result hashes:
- seed7 f9894d2739c0c46c55d844893d7159e67b9d5fc21203d14b8983689ca53e418e
- seed11 0566806841c1817a61a90f94026bbcf9742fe8666408b62b658acc0d0245ef92
- seed19 64b7e5b4d97126c01dadfd013b316d2d9b8c2e8cbc15068a33b6f7c13bb6bce4
- seed23 baa07f16b06b9e0df01f8ec092cd3c5dda8041772951cbdaafaaebcd4a69e114

Signed-PCE -> Forge replay ingestion is implemented and fail-closed.
Do not destabilize PCE v2 just to refactor.

## 5. RIGHTS / CORPUS PIPELINE

Canonical flow:
raw source manifests
-> rights gate
-> deterministic dedup
-> benchmark contamination exclusion
-> deterministic train/validation split
-> curated shard hashes
-> audit
-> IlariaLex encoding
-> token stream hashes
-> curriculum stream
-> immutable dataset manifest

Do NOT create a parallel production data pipeline.

Current preferred strategy:
- general English: wiki_en candidate
- code: Zephyr preferred
- OS/drivers/hardware: Zephyr preferred
- supplements: FreeRTOS, FreeBSD, Rust, Go, CPython after appropriate classifiers
- tools/protocol: first-party contracts, but ownership/provenance attestation still required
- math/science: needs enough clean large English sources; do not fake quota by repetition

Known useful large research candidates considered:
- NVIDIA OpenMathReasoning for math/reasoning (verify exact current dataset license/card before ingest)
- large open-license code corpora such as Common Pile Stack / Stack-style open-license sources (again verify current card/license before ingest)
- world-class repositories for high-quality anchor data

Never use fame as license evidence.
Always pin revisions / dataset snapshots and preserve provenance.

## 6. GIT SOURCE LOCKS

Current exact pinned commits added:
- golang/go:
  f91ce18c4db84c9f0fe271d1832f9cee91b58aa9
- python/cpython:
  115c297fdcc7d0fab41ed0e5c08f1b9cbec35976
- rust-lang/rust:
  ea6bb45b74c24a026dab4187b1550e97b6985c8a
- FreeRTOS/FreeRTOS-Kernel:
  8be86d4a24fd4091f8f4192018423ab590f408db
- freebsd/freebsd-src:
  52b2056849e4f77581594b9ca21ac3feb60429c3
- Zephyr remains present in lock from prior work.

git_sources.lock logical identity after expansion:
f643020c68764eda809c3f316cf7027ee23bc60aad847eacad54e0dacbb7996f

Raw file SHA256 snapshot:
forge/config/git_sources.lock.json
8572496c89e95c4de401f2bca760288c75cec6fb5dd80ffdf491b04ba2453a6f

## 7. SPDX / LICENSE FILTERING HARDENING

forge/licensed_tree_source.py was hardened:
- preserves full SPDX expression
- supports conservative AND/OR expressions
- every branch must be allowlisted
- WITH exceptions are rejected until explicitly modeled
- multiple conflicting SPDX lines rejected
- symlinks rejected
- disallowed license rejected
- secret markers rejected
- path escape rejected
- file hash/SPDX drift rejected on validation

Licensed-tree regression after this work:
15/15 PASS.

Git checkout acquisition was added:
forge/git_source_checkout.py

Properties:
- exact locked commit
- verifies remote
- no implicit submodule init
- nonempty destination refused
- partial checkout removed on failure
- commit mismatch fail-closed

Git checkout + SPDX stack:
20/20 PASS.

## 8. FREERTOS REAL END-TO-END PROOF

Checked out exact commit:
8be86d4a24fd4091f8f4192018423ab590f408db

Local cache:
E:\nexus\ilaria\data\source-cache\freertos_kernel

Licensed manifest:
E:\nexus\ilaria\data\source-cache\freertos_kernel.licensed.json

Accepted:
- 636 files
- ~14.48 MB
- 620 MIT
- 9 MIT AND BSD-3-Clause
- 6 Apache-2.0
- 1 BSD-3-Clause

Rejected:
- 79 no SPDX
- 0 disallowed SPDX
- 0 ambiguous
- 0 secret marker
- 0 symlink

Candidate corpus:
E:\nexus\ilaria\data\candidate-corpus\freertos_kernel

Curation attempt was intentionally rejected because freertos_kernel remains REVIEW_REQUIRED.
This proves:
exact commit -> SPDX allowlist -> content-addressed manifest -> raw corpus -> rights gate fail-closed.

## 9. FIRST-PARTY OWNERSHIP ATTESTATION

Added:
forge/first_party_attestation.py
forge/test_first_party_attestation.py

Template generated:
forge/config/first_party_tools_protocol.attestation.json

Last known template identity:
e70c709bced17a5a7da0fd07f3636e66a02df06041968a8a433fe0e49531f6ad

It is deliberately UNSIGNED / ownership_attested=false.
Do not fabricate ownership.
User/human must explicitly attest first-party provenance before production promotion.

## 10. PRODUCTION READINESS

forge/production_readiness.py now:
- distinguishes rights blockers vs corpus-strategy blockers
- can require only sources actually used by preferred English-first lanes
- integrates first-party attestation
- refuses source strategy if preferred lane source not ELIGIBLE
- no Romanian blocker remains

At last live English-first readiness:
- Romanian sources no longer required
- remaining blockers are real source/review/attestation/artifact blockers
- production tokenizer freeze does not exist yet
- production dataset manifest does not exist yet

Raw SHA256 snapshots:
- forge/config/data_rights.json:
  0c1020c4c49ffd1e90e6e844ff635e66750351f14871557b7ea9cc5676c8771c
- forge/config/data_rights_evidence.json:
  74dd08a17b198d48153c727967f3af5bcdd4e26ee97a5301541f701480e82535
- forge/config/corpus_strategy.json:
  60e487f5aba317e41535bc7e23e4a0184b54de33174293caef49550bc2ab56a0

## 11. IMC-125M PREFLIGHT / LAUNCHER

Added/extended:
- forge/imc_125m_preflight.py
- forge/imc_125m_launch.py
- forge/gpu_preflight.py
- docs/runbooks/IMC_125M_GPU_TRAINING.md

IMC preflight validates:
- tokenizer freeze
- dataset manifest
- rights identity
- EOS/protocol IDs
- exact parameter count 125,882,112
- token budget
- curriculum identity

GPU preflight validates:
- CUDA
- GPU count
- VRAM threshold
- compute capability
- optional BF16 native

Launcher supports:
- initial run
- ternary_candidate / full_precision_control
- locked seed
- world_size
- micro-batch -> accumulation resolution
- content-addressed launch manifest
- --stop-after pause without changing 1B-token horizon
- --resume checkpoint path
- checkpoint SHA256 pinned in resume manifest
- --sample-tokens 0 for smoke/CI

Launcher tests after resume work:
8/8 PASS.
GPU preflight + launcher:
14/14 PASS.

## 12. REAL IMC-125M SMOKE ALREADY EXECUTED

This was REAL forward/backward/checkpoint mechanics but NOT real Genesis data.

Evidence:
bench/imc_125m_smoke/RESULTS.md
bench/imc_125m_smoke/result.json

Synthetic stream:
- 8,192 synthetic uint16 IDs
- ctx=4
- batch=1
- accum=1

Ternary:
step 1:
- train_loss 11.014261245727539
- val_loss 11.312065124511719
- tokens_seen 4

Pause/checkpoint then exact resume.

step 2:
- train_loss 11.467453956604004
- val_loss 11.583840370178223
- tokens_seen 8

Validation regressed, so best export correctly stayed step 1.

Ternary best export SHA256:
31236600884b81b0311cc796100086490590d374dd34ba66883cc4e1227ab916

Ternary final checkpoint SHA256:
52cfb8942239fb46069c187e118096b946811480f7a14f5d2c234be07efc903c

Full precision control:
- train_loss 11.708881378173828
- val_loss 11.550189018249512
- tokens_seen 4

FP export SHA256:
7d50bfdbf9e231eb849d09436d3e7c350e7e49029a9ba8b6896cf2449dc90b3c

FP checkpoint SHA256:
9c0407db03e9be17017aa25f360fb427edd8fc4adef6cd7eeec6c5f422c82337

Smoke is explicitly NON_PROMOTABLE_SMOKE_ONLY.

## 13. TRAINER CHANGE

forge/train_ilaria.py gained:
--sample-tokens

Default 30.
Use --sample-tokens 0 for smoke/CI/long unattended runs to avoid wasteful post-run greedy generation.

Exact resume/checkpoint mechanics were verified on full 125M model.

## 14. COLAB WORK DONE TONIGHT

Notebook created in user's Google Colab:
Name:
Ilaria_IMC125_Genesis_English.ipynb

Drive notebook URL / ID:
https://colab.research.google.com/drive/1xQhoaHlUcrm0VcxnyzehApPNZajEZwY6

Account status observed:
- Colab Pro+
- available compute units around 2307 at the time of setup
- G4 usage rate shown around 8.9 compute units/hour

Requested accelerator:
H100 High-RAM

H100 was NOT available at allocation time.
Colab automatically fell back to:
G4 High-RAM

Actual GPU verified inside notebook:
NVIDIA RTX PRO 6000 Blackwell Server Edition

Observed:
- VRAM: 94.97 GiB (UI ~95.6 GB)
- system RAM: ~176.9 GB
- compute capability: 12.0
- BF16 native: true
- Torch in Colab: 2.11.0+cu128
- CUDA runtime: 12.8

This hardware is more than sufficient for IMC-125M.

IMPORTANT:
Browser Bridge is shared with other concurrent tasks and repeatedly navigated/reset the Playwright browser.
This affected UI automation only, NOT the Google Drive notebook or Colab account state.

## 15. LIVE TRAINING CODE BUNDLE FOR COLAB

Built locally:
E:\nexus\ilaria\data\colab\ilaria-live-training-bundle.zip

Manifest:
E:\nexus\ilaria\data\colab\ilaria-live-training-bundle.manifest.json

Bundle:
- 100 files
- ~187,878 bytes compressed

ZIP SHA256:
483d30799a858a7cc18ef6ee9c85d58de1ee4ca1691a1841e5a2776787fbeab9

Manifest SHA256:
296c8b9c554faa04068907f183b27fe4260f0f0e9deb951f1bdb3ccd0a7e81f4

The bundle was uploaded to Colab session storage.
Inside Colab it was verified:
bundle_sha256 ... match True
files 100

It was extracted to:
/content/ilaria

This proves the remote runtime used the live dirty-worktree training code bundle, not a stale Git clone.

Do not blindly git clone origin on Colab and replace this bundle.

## 16. COLAB CLI WORK

Created local isolated venv:
E:\nexus\ilaria\.colab-cli-venv

Installed official package:
google-colab-cli==0.7.4

Native Windows package installed, but official CLI imports POSIX termios/tty at startup.
A minimal compatibility patch was applied ONLY inside the isolated venv:

E:\nexus\ilaria\.colab-cli-venv\Lib\site-packages\colab_cli\console.py

Patch semantics:
- termios/tty import is optional on Windows
- interactive raw TTY console remains explicitly unsupported
- non-interactive commands can load:
  version / sessions / usage / new / run / exec / upload / download / status etc.

Verified:
colab version -> Version: 0.7.4

Do NOT commit the venv.
Do NOT treat this compatibility patch as product code.

## 17. COLAB CLI OAUTH — CURRENT HUMAN BLOCKER

Command:
.\.colab-cli-venv\Scripts\colab.exe sessions

starts official OAuth and requires Google identity verification.

The OAuth request includes:
- profile/email
- cloud-platform
- colaboratory
- drive.file

Google required 2FA on the user's phone.

The number shown at the latest request was 82.
IMPORTANT: THIS NUMBER IS EPHEMERAL AND WILL EXPIRE.
DO NOT REUSE IT TOMORROW.
Simply rerun 'colab sessions' and complete whatever fresh Google 2FA challenge appears.

No OAuth authorization code, refresh token or secret has been written into this handoff.

Once Google 2FA is approved, Google displays an authorization code.
Feed that code to the waiting CLI process.
Then immediately verify:
- colab sessions
- colab usage
- colab status -s <session if known>

If the existing browser-created G4 session is still active, CLI should list it.

## 18. WHAT IS NOT DONE YET

This is critical.

We have NOT trained the real English-first Genesis on 1B real tokens yet.

Missing before defensible production Genesis:
1. Build sufficient unique data for every non-zero lane.
2. Rights/eligibility decisions for actual production sources.
3. First-party ownership attestation.
4. Train/freeze final English-first IlariaLex-65K.
5. Encode all lane streams with frozen tokenizer.
6. Build exact 1B curriculum stream.
7. Build immutable train/validation dataset manifest.
8. Production readiness PASS.
9. IMC-125M preflight PASS.
10. GPU preflight PASS on actual target.
11. Generate launch manifest.
12. Run ternary seed 7 to full horizon.
13. Evaluate.
14. Run matched FP seed 7 control.
15. Only then continue seeds 11/19 if useful and compute entitlement remains.

Current local data/production directory did NOT exist at the last check.
Current actual corpus material locally was mainly:
- FreeRTOS candidate corpus
- source cache/manifest
- smoke synthetic data

So DO NOT pretend there is a complete 1B production dataset already.

## 19. RECOMMENDED DATA STRATEGY FOR TOMORROW

Goal: real 1B-token English-first research/Genesis candidate without low-quality repetition.

Lane quotas:
- 300M general English
- 220M code
- 145M math
- 105M science/technical
- 100M OS/hardware/drivers
- 80M agent/tool
- 50M world/device

Principles:
- no fake volume by repeating FreeRTOS/Zephyr
- no tiny datasets duplicated to meet quota
- content-address all large sources
- dedup globally where possible
- hold out benchmark/eval material
- file-level license/provenance for code
- explicit source inventory with token counts per lane

Code:
- high-quality pinned repos as anchor set
- add large open-license code corpus only after license/provenance verification
- Zephyr/FreeRTOS/FreeBSD/Rust/Go/CPython handled according to their license models

Math:
- prefer large clean math/reasoning corpora with current verified permissive license
- NVIDIA OpenMathReasoning was identified as a candidate; verify current official dataset card/license before use

General/science:
- wiki_en candidate
- curated science/technical subsets
- potentially other explicitly licensed educational corpora

Agent/tool/world:
- forge/tool_data.py exists and validates English trajectories
- currently no large trajectory JSONL files were found
- need real/verifier-backed generation pipeline rather than random LLM chatter
- PCE/WorldEvent/tool traces can seed this lane

## 20. TEST STATUS

Important suites verified during this work:
- production source pipeline earlier: 92/92 PASS
- post-smoke IMC regression: 56/56 PASS
- English-first curriculum/readiness/launch/tokenizer regression: 52/52 PASS
- final training-focused regression: 70/70 PASS
- Git/strategy subsets and other targeted suites also PASS as noted above
- git diff --check -- ilaria repeatedly exit 0, only CRLF warnings where present

Because the worktree is highly concurrent, rerun relevant tests tomorrow before launch.

## 21. FIRST COMMANDS TOMORROW

From E:\nexus\ilaria:

1. Read:
   - AGENTS.md
   - docs/plans/MASTER_PLAN.md
   - docs/runbooks/IMC_125M_GPU_TRAINING.md
   - THIS HANDOFF

2. Verify workspace via Bridge list_workspaces.
   Expected branch:
   agent/nexus-clean-swyp-fast

3. Check Colab CLI:
   .\.colab-cli-venv\Scripts\colab.exe version

4. Re-authorize:
   .\.colab-cli-venv\Scripts\colab.exe sessions

5. Complete fresh Google 2FA on phone.
   Do not reuse old 82.

6. Then:
   .\.colab-cli-venv\Scripts\colab.exe usage
   .\.colab-cli-venv\Scripts\colab.exe sessions

7. If existing G4 session exists, inspect:
   colab status -s <session-name/id>

8. If not, provision new runtime through CLI:
   prefer H100; if unavailable, A100; if unavailable, G4 Blackwell is acceptable because observed G4 has ~95 GB VRAM and BF16.

9. Upload verified code bundle:
   data\colab\ilaria-live-training-bundle.zip
   and verify SHA256 483d30799a858a7cc18ef6ee9c85d58de1ee4ca1691a1841e5a2776787fbeab9.

10. Run remote:
   python forge/gpu_preflight.py --world-size 1 --min-vram-gib 24 --require-bf16

11. Run critical tests remotely.

12. Build dataset inventory BY LANE before any serious training.

## 22. CHECKPOINT PERSISTENCE PLAN

Do not leave the only checkpoint on ephemeral /content.

After CLI authorization, use:
- colab download
or
- approved Drive mount
to persist checkpoints.

Preferred local checkpoint mirror:
E:\nexus\ilaria\data\colab\checkpoints\

Every checkpoint copied locally must have SHA256 recorded.

Resume:
- build a new imc_125m_launch manifest with --resume
- launcher pins checkpoint SHA256
- do not manually edit checkpoint
- trainer validates schema/config/tokenizer/dataset/runtime signature

## 23. PROMOTION MATRIX

Do NOT launch six expensive runs blindly.

Order:
1. ternary_candidate seed 7 full 1B run
2. evaluate
3. full_precision_control seed 7 matched 1B run
4. compare
5. only if healthy: seeds 11 and 19 for ternary + FP

No claim of ternary superiority without matched evidence.

## 24. COLAB NOTEBOOK CLEANUP

Notebook currently contains:
- a first cell with an old indentation-error diagnostic history
- a second cell reused for GPU probe, bundle verification and preflight/test setup

Do not confuse the first-cell error with model/runtime failure.
The clean GPU probe successfully returned:
- NVIDIA RTX PRO 6000 Blackwell Server Edition
- 94.97 GiB VRAM
- compute capability 12.0
- BF16 true
- torch 2.11.0+cu128
- CUDA 12.8

Notebook can be cleaned later, but preserving the evidence is acceptable.

## 25. ABSOLUTELY DO NOT FORGET

- Real 1B dataset is NOT ready.
- Real 1B Genesis is NOT trained yet.
- GPU hardware IS ready.
- Trainer/model/checkpoint machinery IS ready.
- Colab Pro+ compute entitlement exists and is substantial.
- CLI is installed and works non-interactively after isolated venv compatibility shim.
- OAuth/2FA is the immediate operational blocker.
- Rights/ownership + 1B corpus construction are the immediate data blockers.
- English-first curriculum is canonical.
- Romanian = 0 for Genesis v1.
- Use world-class repos, but do not rely only on repos for all code volume.
- Do not repeat small corpora to manufacture token counts.
- Do not lose checkpoints on ephemeral storage.

## 26. NEXT MISSION IN ONE LINE

Tomorrow: authorize Colab CLI -> inventory/build the real English-first 1B-token dataset -> freeze IlariaLex -> pass production/preflight gates -> benchmark micro-batch on Blackwell -> launch IMC-125M ternary seed 7 with persistent hash-pinned checkpoints until the full token horizon is reached.
