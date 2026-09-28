# Ilaria writes, Swyp proves

`cmd/ilaria-swyp` (Nexus root) runs a verified code-generation loop:

1. BitNet b1.58 2B4T (Ilaria) gets a task and the function signature derived
   from a Swyp contract.
2. The runtime extracts the function from the reply and runs `swyp judge`.
3. On a counterexample or compile error, the verdict — rendered as the rule
   that was broken — goes back to the model in a fresh, self-contained
   prompt, up to `-rounds` replies.

The model never needs to emit tool-call syntax, and its code only ever runs
inside Swyp's fuel-bounded core interpreter.

```bash
go run -tags gpu ./cmd/ilaria-swyp -cuda \
  -model data/forge/bitnet-2b4t/bitnet.nxtf \
  -tokenizer data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json \
  -swyp "D:\nexus\swyp\bin\swyp.exe" \
  -contract swyp/examples/swyp/contracts/sum_to.i64.json \
  -task "Return the sum 1 + 2 + ... + n (zero when n is 0)."
```

## Live results, 2026-09-28

GTX 1660 Ti, CUDA decoder, greedy decoding, no fine-tuning, 4 rounds max.

| Contract | Result | Model's accepted code | Evidence |
|---|---|---|---|
| `square` | verified, 1st reply | `x * x` | exhaustive, 201 inputs |
| `next-exact` | verified, 1st reply | `x + 1` | exhaustive, 8 inputs near 2^53 |
| `above` | verified, 1st reply (renamed `greater_than` → `above`) | `x + 1` | exhaustive, 41 inputs |
| `max2` | verified, 1st reply | `if a > b { return a; } else { return b; }` | exhaustive, 225 pairs |
| `sum_to` | verified, 1st reply | recursive `if n == 0 { 0 } else { sum_to(n - 1) + n }` | exhaustive, 41 inputs |
| `absolute` | **not verified** in 4 replies | model wrote `if x < 0 { x } else { -x }` | rejected: `absolute(x=-50) returned -50, but the contract requires result >= 0` |

5 of 6 verified. The failure is the point of the design: the model's wrong
`absolute` was caught every time and never accepted.

## What changed in Swyp to get here

Measured on the same model before and after each change:

- **Rust-style results (Semantic Core only).** A final bare expression, or a
  final `if/else` whose branches end in bare expressions, is the function's
  value. The model wrote this form in every run; it was previously a syntax
  error, so no valid program changed meaning. Before: `square` failed 4/4
  replies with `expected ";", got "}"`.
- **Readable counterexamples.** `violating ensures[0]` became
  `but the contract requires result >= 0`.
- **Repair hints** for other habits from Rust/Python/JS: compound assignment,
  `**`, methods, `break`/`continue`, missing built-ins, misplaced bare
  expressions.
- **Loop prompts.** A one-line syntax example (a longer grammar summary was
  copied verbatim into the answer), self-contained repair prompts with a
  fresh context (greedy decoding otherwise repeated the rejected reply), and
  renaming a sole function whose name differs from the contract entry.

One run hit the 10 s `swyp judge` deadline once while starting the process;
it did not reproduce in two reruns.

## Swyp Forge baseline, 2026-09-28

Task corpus: `examples/swyp/tasks/tasks.jsonl`, 60 tasks in five tiers, every
reference verified `exhaustive` (`cmd/swyp/tasks_test.go`), frozen split of
40 train / 20 held-out. Batch mode loads the model once:

```bash
go build -tags gpu -o ilaria-swyp.exe ./cmd/ilaria-swyp
ilaria-swyp.exe -cuda -model data/forge/bitnet-2b4t/bitnet.nxtf \
  -tokenizer data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json \
  -swyp "D:\nexus\swyp\bin\swyp.exe" -tasks swyp/examples/swyp/tasks/tasks.jsonl \
  -split heldout -rounds 4 -timeout 2h -report baseline-heldout.jsonl
```

Held-out, base BitNet b1.58 2B4T without adapter, greedy, GTX 1660 Ti:

| Tier | Tasks | pass@1 | repair@4 |
|---|---:|---:|---:|
| arithmetic | 4 | 4 | 4 |
| branches | 5 | 0 | 0 |
| loops | 5 | 1 | 1 |
| multi_input | 3 | 0 | 0 |
| recursion | 3 | 1 | 1 |
| **total** | **20** | **6** | **6** |

No task was repaired after a rejection (0 of 14). Of the 62 replies, 44 were
compile errors, 12 counterexamples and 6 exhaustive passes. The compile errors
are Rust/C habits: `return 0` without `;` inside if/else blocks (24), compound
assignment or `let mut` (16, each with a hint) and `else if`, which Semantic
Core does not parse (4). `absolute` shows the logic gap: the model swapped the branches,
got `absolute(x=-50) returned -50`, then "fixed" it to `x` in both branches.

20 tasks is a small sample; these are counts, not rates to generalize.

## Swyp Forge v1 adapter, 2026-09-28

LoRA r16/a32 trained from the base model for 105 steps (3 epochs) on Colab G4
with `forge/colab/Ilaria_SwypForge_V1.ipynb` over `forge/colab/swyp-forge-examples-v1`
(279 rows: 200 counterexample repairs, 64 compile-error repairs, 40 direct, 12
verified model replies; held-out tasks never used). Validation loss on 5
unseen train-split tasks: 0.0700 -> 0.0250. Adapter
`adapter-step105.safetensors` sha256 `4ceeaf8e...de731`, `.json` `c57fa189...59ec7`.

Held-out, same command plus `-adapter`:

| Tier | Tasks | pass@1 base | pass@1 adapter | repair@4 base | repair@4 adapter |
|---|---:|---:|---:|---:|---:|
| arithmetic | 4 | 4 | 4 | 4 | 4 |
| branches | 5 | 0 | 3 | 0 | 3 |
| loops | 5 | 1 | 1 | 1 | 1 |
| multi_input | 3 | 0 | 1 | 0 | 1 |
| recursion | 3 | 1 | 1 | 1 | 1 |
| **total** | **20** | **6** | **10** | **6** | **10** |

Replies: exhaustive 6 -> 10, compile errors 44 -> 32, counterexamples 12 -> 8.
Newly verified: clamp_0_50, distance_to_ten, flip_if_odd, digit_sum, safe_div.
Regressed: sum_squares (verified by the base model, not by the adapter).
Still unverified: absolute, grade, power_of_two, integer_sqrt, alternating_sum,
digital_root, binary_length, max3, abs_diff.

`cmd/ilaria-chat -eval cmd/ilaria-chat/testdata/tools_eval.jsonl` is identical
with and without the adapter: tool selection 5/8, executed 3/8, false calls
0/6, answers 7/10.

By the acceptance rule (held-out repair@4 up, tools_eval not down) the adapter
passes. Honest reading: every gain is a better **first** reply. The model still
repaired **zero** tasks after a rejection; repair from a counterexample remains
the open problem. 20 tasks; +4 is a small-sample result.

## Limits

- Six tasks is a demo, not a benchmark. The contracts are small finite
  domains; `exhaustive` is complete execution over them, not an SMT proof.
- The model does not repair logic from a counterexample yet (`absolute`).
  Verified replies from this loop are the natural fine-tuning data for that.
