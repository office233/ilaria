# Ilaria Colab continuation: observed state and prepared pilot

Date: 2026-09-28. Checkout: `D:/nexus`.

## Observed prior work

HEAD was `5c1afaa` (2026-09-27), integrating the pilot/grounding/project-v6
Colab workflows. The checkout already contained uncommitted headless-service,
host-execution safety, configuration, dense-trainer and checkpoint changes on
`agent/headless-safety-fixes`. Their authorship was not independently established.
Those files were preserved. This task switched to
`agent/colab-training-preflight-20260928`; no commit, push or deployment occurred.

The latest recorded production-base training is project v6, not an untrained
model. Source: `docs/plans/2026-09-27-ilaria-project-v6-run.md`.
Historical Go development results: project tasks 6/16 -> 10/16; earlier English
suite 57/58 -> 54/58; numerical tasks remain 31/31. Four generated Swyp programs
compiled and passed 24 unseen-input checks, but only three obeyed the complete
instruction. The v5/v6 generation ceilings differed in the earlier English
comparison. These are historical small-development-set results, not new runs.
**Retain drafting v5 as baseline; v6 is experimental, not promoted.**

The active continuation is English BitNet LoRA, distinct from the older dense
Ilaria-130M scratch-pretraining workflow in `forge/COLAB_GUIDE.md`.

## Files added in this task

- `forge/colab/pilot_preflight.py`: parent/dataset/source/prompt checks, no-truncation
  preflight, isolated output guard, raw Python before/after generation helpers.
- `forge/colab/build_project_pilot_v7.py`: reproducible standalone notebook builder
  with an explicit 11-file source allowlist and the current Go serving prompt.
- `forge/test_colab_pilot.py`: 14 tests plus four run-name subtests.
- `forge/colab/Ilaria_Project_V7_Pilot.ipynb`: 10 cells, 125786 bytes.

Notebook SHA256:
`87074daffb1779c7eff29073b31607950791b9bc3d9b6b1a812384fe50837a66`.

No existing trainer, model export, dataset, old notebook, UI or deployment script
was edited. No local `data/`, weights, credentials or repository dump was embedded.

## Pilot definition (prepared, NOT executed on Colab)

The notebook uses the verified v5 parent and existing reviewed v6 English corpus
(1081 training / 256 validation rows). It does not claim to have created a better
corpus or corrected the v6 failures. It is an isolated conservative hyperparameter
experiment: 50 steps, learning rate 2e-5, rank 16 / alpha 32, batch 1 / accumulation
8, maximum sequence length 2048, seed 42, gradient checkpointing, exports every
10 steps. A soft 15-minute training-loop cap excludes download, setup, evaluation
and saving. Actual saved steps are checked; a partial run is never called complete.

Base revision is pinned to `04c3b9ad9361b824064a1f25ea60a8be9599b127` for
`microsoft/bitnet-b1.58-2B-4T`. The notebook retains the historical Python API pins
without replacing Colab's CUDA/PyTorch. GPU allocation and those packages in a
fresh Colab session have not been validated by this task.

Required Drive paths relative to `MyDrive/ilaria/swypikos-en`:

- `runs/drafting-v5-150steps/adapter-step150.json` and `.safetensors`.
- `datasets/project-v6/train.jsonl`, `validation.jsonl`, `manifest.json`.
- If present, `base_revision.txt` must match the pinned base.

New outputs: `runs/project-v7-pilot-20260928-50steps` and
`reviews/project-v7-pilot-20260928-50steps`. Existing output/report directories
are protected. A restart requires a new run name or separately reviewed,
contract-matching trainer resume; the notebook does not silently resume old runs.

Twelve frozen English development probes are checked against all dataset user
turns. The actual v5 baseline must be generated before training. The candidate is
then evaluated with identical Python greedy settings (256 generated-token limit).
These probes share conceptual families with earlier development work and are not
an independent broad benchmark. They do not execute tools or score generated code.
Actual Go English/tool regressions and Swyp compiler/runtime checks are mandatory
before any promotion. Status records always keep `promoted: false`.

## Verification executed on this checkout

- `go vet ./...`: exit 0.
- `go test -count=1 -timeout 180s ./...`: exit 0; full standard Go suite passed.
- `python -m pytest -q forge/test_colab_pilot.py forge/test_tool_data.py forge/test_train_tools.py forge/test_distributed_tools.py forge/test_audit_regressions.py forge/test_remediation.py`:
  84 passed, four subtests passed, two SWIG deprecation warnings.
- Generated notebook: `nbformat.validate` passed; every code cell parsed with AST.
- Existing LoRA tests include tiny CPU training, warm-start export checks and exact
  interrupted/resumed continuity. This is not production GPU training validation.

The requested LSP checks were attempted after every new code file and notebook.
They could not run: VS Code Insiders bridge at `127.0.0.1:3005` was unavailable.
The successful verification above used the actual test runner/compiler instead.
No CUDA-tagged Go, full GPU inference, race/fuzz campaign or live Colab run is claimed.

## Execution blocker

Two Chrome tab-list attempts reported the Antigravity extension disconnected from
`ws://localhost:3001`. The alternate browser opened Colab but showed `Sign in`.
No authenticated Colab session or Drive was accessed; no new GPU training,
subscription purchase or compute-unit charge was initiated by this task.

Next operator action: enable/reconnect the Antigravity Chrome extension in the
Chrome session authenticated to Colab, then open the prepared notebook. Run cells
in order and explicitly authorize Drive when Colab requests it. The training cell
starts the bounded pilot only after prerequisite checks and baseline generation.

## Follow-up: real Chrome connection and bootstrap correction

The real-session extension subsequently connected. `chrome_list_tabs` and a
semantic snapshot confirmed an authenticated Colab tab named `Untitled5.ipynb`.
This was an existing notebook, not the prepared v7 pilot. No old cells were run
or modified. Opening its File menu timed out; subsequent tab-list and snapshot
calls reported the extension disconnected again. The separate Playwright browser
still showed Sign in and was not used to access the user's Drive. The pilot has
NOT started, and GPU allocation has not been verified.

A runtime bug missed by AST-only notebook validation was found in the generated
bootstrap: its `Path.write_text` newline argument was a literal backslash+n,
which is not a valid newline parameter. The builder now emits `newline=chr(10)`.
A new regression test executes the generated write call against a temporary file
and checks the exact UTF-8 bytes. No model or dataset settings were changed.

The original notebook was preserved as
`forge/colab/Ilaria_Project_V7_Pilot.pre-bootstrap-fix.ipynb` for comparison;
DO NOT execute that superseded copy. The corrected launch notebook remains
`forge/colab/Ilaria_Project_V7_Pilot.ipynb`, with SHA256
`ec6631b70811ac84b7f06c255b6762e861b8180cdd245da2199d43e76a04d88f`.
This supersedes the notebook hash and test counts above.

Fresh checks after the correction:
- Python suite: 85 passed, four subtests passed, two SWIG deprecation warnings.
- Builder reproduced the corrected notebook exactly; nbformat validation passed.
- `go vet ./...` and `go test -count=1 -timeout 180s ./...`: exit 0.
- `git diff --check`: exit 0.
- LSP was attempted after each code/notebook change but port 3005 remained unavailable.

The next required UI state is the corrected v7 notebook open in authenticated
Colab with the real-session extension connected. Preserve the existing notebook,
v5/v6 adapters, dataset and all unrelated worktree edits. No commit, push,
deployment, subscription purchase or model promotion occurred.
