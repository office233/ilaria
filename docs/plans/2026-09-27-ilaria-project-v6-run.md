# Ilaria project v6 English pilot

## Final outcome

Training completed and exports downloaded with matching SHA256. **Keep v6 experimental; do not replace v5 by default.** Final Go review: new project tasks improved from 6/16 to 10/16, while the previous English suite regressed from 57/58 to 54/58. Numerical tool tasks remain 31/31 correct. One unnecessary conversion call occurred (1/39 no-tool cases across the combined 74 tasks); expected tools were selected 35/35, including four intentional errors. No inference errors.

All four v6 Swyp programs compile and pass 24 unseen-input checks. Three satisfy the full instruction; the fourth uses `negative` instead of the required `predict`. v5 compiled none of the four. The new missing-unit, replacement-email and subject-line regressions prevent promotion even though the earlier invented meeting date is fixed. Some project evidence answers remain incorrect or irrelevant. Manual per-case review: `results/ilaria-project-v6/manual-review.json`.

Final validation assistant loss: 0.304825 → 0.144969. Training loop: 327.51 seconds; peak allocated GPU memory: 11.49 GB. 420 finite tensors, encoding version and parent identity verified. This loss reduction does not override the behavioral regressions.

Hashes: weights `13daee41cfedc30e04e75b9c5828a5cc2b4483f6a34012cac35aef22ff53368a`; metadata `1b9843e1bd0bdc4cc12b766eae80fb05a005ab21184f0285bd0279be6ba828a8`; checkpoint `2b0b6c0eb281bbb113f78837dd78dd95f016d60ef4d7667c8221db874d243450`.

The final regression ceiling was 256 tokens versus the earlier v5 suite's 128, a comparison limitation. Python and Go prose generations differ on some cases; final scores above use Go. No further training was performed after inspecting these results.

## Scope

Authorized continuation from verified drafting v5, focused on English SwypikOS/Swyp Lang project tasks. No Romanian training added. No external corpus download, repository dump, Swyp tool registration or deployment.

## Data and checks

- 1,081 training rows and 256 validation rows: v5 replay plus 172/35 new project, code and grounded-drafting examples.
- New project examples include evidence in the user message; they teach answering from evidence rather than assuming planned capabilities exist.
- 25 authored scalar Swyp programs passed the actual compiler and 100 interpreter checks before inclusion. Affine coefficients are disjoint between train and validation. This is a narrow code family, not broad programming competence.
- 16 new project tasks frozen before this training: 8 project concepts, 4 grounded-writing tasks, 4 Swyp programs. Concepts overlap with instruction data; this is a development set. Existing final transfer prompts were excluded from training.
- 1,337 total trajectories passed tokenization preflight, maximum 381 tokens, with no truncation.
- Source hashes, dataset hashes, compiler-check inputs and limitations are recorded in `forge/colab/project-examples-v6/manifest.json`.
- Go serving prompt matches the dataset prompt after normalizing Windows line endings.

## Baseline and training

v5 was evaluated in the real Go CUDA runner on all 16 new tasks, maximum 256 generated tokens and 3 calls. No inference errors or unnecessary calls. All four code answers failed the actual Swyp checker, emitting other languages or invalid syntax. Answers are preserved in `results/ilaria-project-v6/before-answers.json`; no substring quality score is claimed.

Training settings: 200 steps, learning rate 0.00005, LoRA rank 16/alpha 32, batch 1, accumulation 8, maximum sequence 2048, gradient checkpointing, seed inherited from trainer default 42. Parent weights SHA256: `1a275f6a5541da2cc942d25c6bd7530fcfbb74c17c501cf0e49a1efbca4e8446`. Corrected encoding contract: `assistant-header-split-v2`.

Actual Colab GPU: NVIDIA RTX PRO 6000 Blackwell Server Edition. Historical H100 notebook name does not identify current hardware. Drive output: `MyDrive/ilaria/swypikos-en/runs/project-v6-200steps`. Output is separate and refuses overwrite.

The first preflight encountered a stale in-memory Python import from an earlier notebook cell. Reloading `forge.tool_data` resolved it after on-disk trainer hashes matched. Training runs in a fresh subprocess. No failed preflight checkpoint was created.

## Evaluation procedure

Post-training verification checks 420 finite adapter tensors, the v5 parent hash and encoding contract. The queued Python evaluation uses the same 16 questions, prompt and 256-token limit, greedy decoding; its results must be identified as Python results until the exported adapter is evaluated in Go. It does not execute model-proposed tool calls. Actual Swyp code output is then checked locally and run on six held-out inputs using the bounded interpreter (10,000 steps, timeout).

Weights are copied to `/content/ilaria-project-v6.json` and `.safetensors` for download. Original Drive checkpoints remain preserved. Final Go project/regression evaluation requires downloading both files and verifying hashes. Do not report a Go gain from Python-only results.

## Reproduction and verification

- Dataset builder: `forge/colab/build_project_v6.py` (new-directory guard).
- Exact Colab cells: `project-v6-run.py`, `project-v6-verify.py`.
- Standalone notebook: `forge/colab/Ilaria_Project_V6.ipynb` (requires v5 parent in Drive).
- Evaluation extraction: `forge/colab/extract_project_v6.py`.
- Executable code scoring: `forge/colab/check_project_code_v6.py`.
- `go vet ./...` and `go test -count=1 -timeout 180s ./...` passed in Nexus during preparation. Colab cell syntax was validated locally.

This adapter is experimental. Scientific knowledge, broad repository competence, live OS actions, and general coding ability are not established by this pilot.
