# Ilaria text adapter comparison — 27 September 2026

The 50-step pilot is the best text-tool candidate in this small comparison.
Keep Claude's multimodal checkpoint intact. No production promotion or larger
training run was performed as part of this evaluation.

| Measure | Frozen base | Claude Stage 2, step 6000 | Text pilot, step 50 |
|---|---:|---:|---:|
| Tasks passing transcript review | 27/35 | 28/35 | 30/35 |
| Template holdouts passing review | 20/23 | 23/23 | 23/23 |
| New challenges passing review | 7/12 | 5/12 | 7/12 |
| Expected tool selected | 27/29 | 28/29 | 29/29 |
| Expected tool executed without error | 26/29 | 27/29 | 28/29 |
| Unnecessary calls on six no-tool tasks | 4/6 | 3/6 | 4/6 |
| Runtime inference errors | 0/35 | 0/35 | 0/35 |

One of the 29 expected-tool tasks intentionally divides by zero, so 28/29
successful executions is the correct maximum. All variants reported that failure
honestly. Tool selection alone does not imply correct final meaning.

## Method and limits

All variants used the same local BitNet NXTF base, tokenizer, Go CUDA runner,
system prompt, calculator/time/conversion tools, three-call limit and 128-token
budget per generation segment. Each task starts with a fresh conversation.
Actual tool execution is recorded separately from model-generated text.

The 35 prompts were fixed before inference: 23 reserved pilot test examples and
12 new challenges. None exactly matches a prompt in the pilot train/validation
sets. The 23 reserved examples share synthetic templates with training. Claude's
earlier training-set overlap is unknown. This is one small English text run,
not a general reasoning, multilingual, vision, or statistical superiority claim.
No vision projector was tested. Manual transcript review was not blinded.

The existing CLI's substring metric is retained in raw output but is not used
as the semantic score: commas in numbers and expanded unit names can fail its
literal match, while a correct number with an incorrect meaning can pass.
The explicit review rubric and per-task decisions are in
`forge/colab/review_pilot_eval.py` and `results/ilaria-comparison-v1/review.json`.

## Findings

- Pilot: all 28 numerical tasks have valid tool calls and correct final answers.
  It still fails both clarification tasks, attempts nonexistent delete/email
  tools, and mistranslates “water” into Romanian.
- Claude: on the email task, it says “The email to Alex has been sent” after
  an unknown-tool error. It returns fabricated tool-looking text and 256 for
  `(37 + 19) * 8 - 63` (correct: 385). On the change problem it computes 67
  but incorrectly describes it as the cost of the tickets.
- Base: also fabricates tool-looking text on two conversions, and changes the
  correct calculator value 2.347826087 into an incorrect approximation 2.37.

The pilot's training validation loss fell from 1.44085 to 0.17342, but its five
behavioral failures demonstrate why that loss is not a product-readiness score.

## Next training stage

Use the pilot as the provisional text-tool candidate, while keeping Claude as
a separate multimodal candidate. Build a separate training set emphasizing
clarification, tool availability, error handling, and correct interpretation of
tool results. Use different scenarios and parameters from this frozen test set.
Reserve a new final holdout: this set is now a development regression suite.

Before scaling, investigate the Transformers tokenizer-regex warning against
the Go tokenizer; do not blindly change tokenization and invalidate parity.
Before product rollout, require correct behavior on unavailable tools and
missing inputs, plus broader independent tests. Do not rent eight H200s based
on this small test.

## Artifacts and reproduction

- `results/ilaria-comparison-v1/tasks.jsonl`: frozen prompts and expectations.
- `base.txt`, `claude.txt`, `pilot.txt`: original evaluator tables.
- `*-transcripts.txt`: complete engine transcripts and tool execution records.
- `*-answers.json`: extracted generated turns; fake tool text remains visible.
- `manifest.json`: SHA-256 hashes of base, tokenizer, tasks and adapter weights.
- `review.json`: review outcomes and specific failure reasons.

Run `go run -tags gpu ./cmd/ilaria-chat -cuda` with the model and tokenizer paths
in the manifest, `-eval results/ilaria-comparison-v1/tasks.jsonl -max-tokens 128
-max-calls 3 -show-transcript`. Omit `-adapter` for base; use the appropriate
export prefix for each adapter. Downloaded pilot hashes match the verified Drive
artifacts. No model files were modified.

Validation: `go vet ./...` and `go test -count=1 -timeout 180s ./...` passed.
