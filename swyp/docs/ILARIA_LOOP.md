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

## Limits

- Six tasks is a demo, not a benchmark. The contracts are small finite
  domains; `exhaustive` is complete execution over them, not an SMT proof.
- The model does not repair logic from a counterexample yet (`absolute`).
  Verified replies from this loop are the natural fine-tuning data for that.
