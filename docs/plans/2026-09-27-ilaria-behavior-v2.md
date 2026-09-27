# Ilaria behavior v2 training result

Completed 100 additional optimizer steps on the Colab G4/Blackwell GPU from
the verified step-50 pilot adapter, using a fresh optimizer and a separate run.
No Claude or pilot artifacts were overwritten. Not deployed to production.

- Data: 321 training and 65 validation trajectories; 112/40 new behavior examples
  plus the original pilot train/validation replay. New action families are split
  together; the 35 development comparison prompts were excluded from training.
- LoRA rank 16, alpha 32; batch 1, accumulation 8, learning rate 0.00005.
- Checkpoints at steps 25, 50, 75, 100; loop time 162 seconds; peak allocation
  11.454 GB. Validation loss on this dataset: 1.90476 -> 1.15107.
- Drive: `MyDrive/ilaria/swypikos-en/runs/behavior-v2-100steps`.
- All 420 exported tensors finite; checkpoint and export hashes saved in Drive.
- Downloaded weights SHA-256:
  `4dd69c47fa74122b9423b67b235278dfd2de7fe2b167cfabdae566e08bfd637e`.

## Executed Go regression comparison

Same 35 tasks, Go CUDA engine, 128 tokens per segment, three-call limit and
system prompt as the prior comparison. No further training after inspecting
these results. Transcript review uses the same strict task/protocol rubric.

| Measure | Pilot | Behavior v2 |
|---|---:|---:|
| Reviewed tasks passed | 30/35 | 31/35 |
| Template numeric holdouts | 23/23 | 23/23 |
| New challenges | 7/12 | 8/12 |
| All numeric tasks with correct execution and answer | 28/28 | 28/28 |
| Unnecessary calls on six no-tool tasks | 4/6 | 2/6 |
| Runtime errors | 0/35 | 0/35 |

Improvements: requests order information instead of calling time; refuses the
file-deletion request instead of inventing a delete tool. Numeric performance
is preserved on this set.

Remaining failures: missing source unit still triggers invalid conversion;
email still triggers an unavailable tool; Romanian translation remains wrong.
Regression: the divide-by-zero prompt explicitly requests calculator execution,
but v2 claims it failed without calling it. The mathematical explanation is
correct, but the execution claim is unsupported, so this case fails the rubric.

This is a small previously inspected development regression suite; a one-task
gain does not establish broad generalization. No multilingual or multimodal
capability is established. Keep both adapters; v2 is an experimental candidate,
not an unconditional replacement. Next data should teach grounded tool-error
reporting and tool availability across varied contexts, with a new independent
holdout before scaling or deployment. Do not train on these exact test cases.

## Reproduction and checks

`forge/colab/Ilaria_Behavior_V2.ipynb` embeds the setup and exact run. The data
generator is `forge/colab/build_behavior_data.py`. `--init-adapter` validates
export kind, LoRA configuration, tensor keys/shapes/finiteness and records
source hashes; it initializes weights only, retaining exact `--resume`
semantics for interrupted runs. Prior checkpoints without initialization remain
compatible. Source base identity must still be matched by the caller.

Local trainer tests passed (3), Colab suite passed (6), `go vet ./...` and
`go test -count=1 -timeout 180s ./...` passed. Evaluation transcripts, extracted
answers, per-case review and hashes are in `results/ilaria-comparison-v1/` with
the `behavior-v2` prefix. The tokenizer-regex warning remains a documented
compatibility investigation; tokenization was not changed in this stage.
