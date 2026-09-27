# Ilaria: grounding and training-prefix repair

Date: 2026-09-27. Branch: `agent/review-claude-swypik`. Experimental adapters; no production promotion.

## Confirmed correction

Training encoded `Assistant: ` and the answer together. Inference encodes the complete header before sampling, so BPE could merge the header's trailing space into the answer's first token during training. The observed header ends in token 220 at inference, while merged training used token 3639 for the space plus `What`. This is a real conditioning mismatch.

`forge/tool_data.py` now encodes and masks the complete assistant header separately, then supervises answer tokens. `forge/train_tools.py` includes `assistant-header-split-v2` in the checkpoint contract. Old exact resumes are incompatible; deliberate continuation uses `--init-adapter` and a fresh optimizer/output directory. A merging-tokenizer regression test covers the boundary. The soft-deadline test now uses a deterministic mocked clock instead of a fragile wall-clock threshold.

## Completed runs

All ran on the actual Colab NVIDIA RTX PRO 6000 Blackwell Server Edition (G4), not H100 despite the historical notebook name. Base revision: `04c3b9ad9361b824064a1f25ea60a8be9599b127`. Rank 16, alpha 32, batch 1, accumulation 8, maximum length 2048, gradient checkpointing. Parent adapters preserved.

| Run | Data train/validation | Steps | Validation assistant loss, start → end | Status |
|---|---:|---:|---|---|
| Grounding v3 | 781/189 | 250 | 1.32579 → 0.25165 | Go evaluated |
| Aligned v4 | 781/189 | 150 | 0.29196 → 0.17984 | Go evaluated |
| Drafting v5 | 909/221 | 150 | 0.29150 → 0.15551 | Go evaluated: 57/59 |

Loss values across different encodings/datasets are not directly comparable. v5 used learning rate 0.00005; its 150-step loop took 244 seconds and peaked at approximately 11.47 GB allocated GPU memory.

The v3 data include actual Go calculator/converter observations, clarification and unavailable-action examples, and replay. Source inputs and paraphrases stay within their split. v5 adds fictional drafting examples, excluding the postponed-meeting test topic. Templates overlap between train and validation; this is a small development exercise, not a broad independent benchmark.

## Reviewed Go behavior

Same original system prompt, CUDA Go engine, 128 generated tokens and maximum 3 calls. Manual semantic review of actual transcripts, not the CLI's permissive substring metric:

| Adapter | Original 35 | Additional 16 | Total |
|---|---:|---:|---:|
| Behavior v2 | 31/35 | 11/16 | 42/51 |
| Grounding v3 | 33/35 | 13/16 | 46/51 |
| Aligned v4 | 34/35 | 15/16 | 49/51 |

v4: all 31 numerical tasks correct; expected tools selected 34/34. Three tool errors were intentional and honestly reported. Unnecessary calls: 0/17. Remaining failures: Romanian translation of `water` (`Aguan`) and refusal to draft a two-sentence postponed-meeting email because the model confuses drafting with sending.

Pass criteria: actual requested tool execution plus correct numerical meaning; genuine tool error acknowledgement; relevant missing-input clarification rather than guessing; no fabricated unavailable actions; requested drafting content/format; correct Romanian translation. Formatting variants such as comma separators do not fail numerical answers. Review was not blinded.

An expanded-prompt experiment worsened unnecessary calls from 1/17 to 5/17 and was reverted. The original system prompt was verified restored. A Python/Go probe on two cases with the experimental prompt produced matching initial generations; this is limited evidence, not exhaustive parity proof.

Eight additional transfer tasks were frozen after v5 data creation and must not be used for further tuning in this experiment. v4 baseline: 5/8 by manual review. Failures: replacement-email body absent, notes-to-message refused, invented support email address in subject line. v5 passed 8/8 on these transfer tasks. It scored 49/51 on the earlier suite and 57/59 overall, compared with v4 at 54/59. All 31 valid numerical tasks passed, all 35 expected tools were selected, four intentional errors were honestly acknowledged, unnecessary calls were 0/24, and inference errors were 0/59. The two failures are Romanian translation and an invented rescheduling date (next week) in the meeting draft. The draft refusal improved, but that case remains a failure. The replacement draft has unnecessary advice to send; the upload-honesty answer is awkward but explicitly denies acting. Full per-case review is in final-manual-review.json. No further tuning used the final eight tasks.

## Artifacts and resolved transfer

Drive: `MyDrive/ilaria/swypikos-en/runs/drafting-v5-150steps`.

Colab verified 420 finite tensors, corrected encoding version and v4 parent lineage. SHA256:

- v4 weights: `b368303a7bf659a6bc76e4e5ec8a1b5f5c728d80f4f9bfea62de31dd6f81c966`
- v5 checkpoint.pt: `57fc2680ea35c0f9f6fb70b0f2e0854640d0a6fa28fcad75483b49483bf0f5db`
- v5 adapter-step150.json: `914a4411bbe34c78d606531ca8475e28ee92b3712464371960ac0a4f76fa2876`
- v5 adapter-step150.safetensors: `1a275f6a5541da2cc942d25c6bd7530fcfbb74c17c501cf0e49a1efbca4e8446`

The Colab runtime also has `/content/ilaria-drafting-v5.json` and `.safetensors` copies for uniquely named downloads. Programmatic downloads and the file-menu download did not produce local files; the browser download event timed out. Training itself completed successfully. Do not overwrite the existing local v4 `adapter-step150` files or claim v5 passes the evaluation.

After retrieving both v5 files and verifying hashes, run:

The guarded runner `python forge/colab/evaluate_drafting_v5.py` verifies both known SHA256 hashes, refuses to overwrite existing final results, runs the command below, and extracts answers. `--check-only` only validates the downloaded pair. The user subsequently supplied both downloads; the guarded runner completed all 59 tasks and extraction.

```powershell
go run -tags gpu ./cmd/ilaria-chat -cuda -model data/forge/bitnet-2b4t/bitnet.nxtf -tokenizer data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json -adapter C:/Users/Pos5/Downloads/ilaria-drafting-v5 -eval results/ilaria-grounding-v3/final-tasks.jsonl -max-tokens 128 -max-calls 3 -show-transcript > results/ilaria-grounding-v3/final.txt 2> results/ilaria-grounding-v3/final-transcripts.txt
python forge/colab/extract_grounding_eval.py
```

Then manually review all 59 outputs, retaining all failures and comparing the final eight against v4 separately. Do not infer broad multilingual capability or frontier-model superiority from these small tests.

## Verification completed

- `go vet ./...`: passed.
- `go test -count=1 -timeout 180s ./...`: passed after reverting the prompt experiment.
- Seven Python trainer/data tests: passed after the deterministic clock fix.
- Colab tensor/metadata/lineage checks: passed for v3, v4 and v5.

Detailed transcripts, tasks and token-boundary diagnostic: `results/ilaria-grounding-v3/`. Colab run sources and captured output: `forge/colab/`. Earlier workspace changes were preserved. No deployment or Git push was performed.

## Next experiment

Keep v4/v5 as reproducible experimental baselines. Before further training, create a broader independently reviewed English corpus for drafting grounded strictly in supplied facts (dates, recipients, amounts and commitments), and freeze a new evaluation set. Romanian and other languages need separate curated data and language-specific evaluations; fixing a single translation is not multilingual capability. Do not train on the final eight transfer prompts or promote this adapter on the strength of a 59-case suite.
