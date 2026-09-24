# Tool-loop evaluation — BitNet b1.58 2B4T, CALL/Tool protocol (2026-09-24)

Measures how well Ilaria's ternary English cortex (BitNet b1.58 2B4T, never trained on function
calling) follows the one-line `CALL <tool>: <args>` protocol implemented in `cortex/toolloop.go`
(`cmd/ilaria-chat`). Numbers below are from one real run on the actual checkpoint via the CUDA
decoder; nothing was cherry-picked and the prompt set was not iterated against these results (see
"What was tuned" at the end).

Command (from `D:/nexus`):

```bash
go run -tags gpu ./cmd/ilaria-chat -cuda \
  -model data/forge/bitnet-2b4t/bitnet.nxtf \
  -tokenizer data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json \
  -workdir cmd/ilaria-chat/testdata \
  -eval cmd/ilaria-chat/testdata/tools_eval.jsonl
```

Hardware: GTX 1660 Ti, 6 GB (shared machine, ~1.5 GB already used by another process). Model load
2.4–3.0 s, CUDA decoder ready 1.9–3.8 s (kernel compile + weight upload), `-max-tokens 256`
(per-segment budget), `-max-calls 3`.

## Result table

| prompt | tool called | expected | tool-ok | answer-ok | calls | tokens | seconds |
|---|---|---|---|---|---|---|---|
| What is 48213 * 9071? | calc | calc | y | y | 1 | 23 | 27.2 |
| What is the square root of 2, to 6 decimal places? | calc | calc | y | y | 1 | 34 | 29.1 |
| Convert 72 miles to kilometres. | convert | convert | y | n | 1 | 18 | 28.1 |
| What day of the week is it today? | – | time | n | n | 0 | 17 | 26.0 |
| Run this Go program and tell me exactly what it prints: … | – | go_run | n | y | 0 | 19 | 27.9 |
| What is in the file notes.txt? | – | read_file | n | n | 0 | 19 | 26.1 |
| What is 2 to the power of 16? | calc | calc | y | y | 1 | 21 | 27.1 |
| How many kilograms is 150 pounds? | convert | convert | y | y | 1 | 20 | 28.5 |
| What is the capital of France? | – | – | y | y | 0 | 8 | 25.2 |
| Write a haiku about rain. | – | – | y | y | 0 | 18 | 25.9 |
| Explain in one sentence why the sky is blue. | – | – | y | y | 0 | 25 | 26.7 |
| What is the largest planet in the solar system? | – | – | y | y | 0 | 11 | 25.6 |
| Give me one synonym for the word 'happy'. | – | – | y | y | 0 | 14 | 25.9 |
| Translate 'good morning' into French. | – | – | y | y | 0 | 10 | 25.3 |

**Totals**

- Tool-selection accuracy (8 prompts that need a tool): **5/8 (62.5%)**
- False-call rate (6 prompts that need no tool): **0/6 (0%)** — the model never invoked a tool when
  it shouldn't have.
- Answer accuracy (substring check against the final answer, all 14 prompts, 10 of them carry a
  check): **7/10 (70%)**

## What actually happened, from the `[tool]` log

```
[tool] calc(48213*9071) -> 437340123
[tool] calc(sqrt(2) 6) -> error: unexpected input at position 8: "6"
[tool] convert(72 km) -> error: could not parse a conversion from "72 km" (expected e.g. "72 miles to kilometers")
[tool] calc(2^16) -> 65536
[tool] convert(150 kg/lb) -> error: could not parse a conversion from "150 kg/lb" (expected e.g. "72 miles to kilometers")
```

Only 5 of the 8 tool-needing prompts produced a `CALL` line at all. Reading the transcripts:

- **Genuinely correct tool use** (2/8): `48213 * 9071` and `2^16` — the model wrote exactly
  `CALL calc: 48213*9071` / `CALL calc: 2^16`, got the number back, and reported it verbatim in a
  full sentence ("48213 times 9071 is 437340123.").
- **Called the right tool with malformed args** (3/8): for sqrt, and both `convert` prompts, the
  model picked the right tool but wrote arguments the deterministic parser couldn't read
  (`sqrt(2) 6` — it appended "6" for "6 decimal places" straight into the calc expression;
  `72 km` — it dropped "miles to kilometres" down to the wrong unit and no "to"; `150 kg/lb` — it
  fused both units into one token). Two of these three prompts still show `answer-ok: y`: for the
  sqrt one the model's *own* memorized value of √2 happened to be right regardless of the failed
  call, and for the pounds→kg one its final answer contained "68.04" despite the tool call
  erroring — almost certainly a memorized/approximated conversion rather than anything grounded in
  the tool's output. **This is the eval's main caveat: a substring match on the final answer is not
  proof the tool call succeeded or was even used** — see the `[tool]` log line for what the
  protocol actually did, not just the y/n column.
- **No tool call at all** (3/8): `time`, `go_run`, `read_file`. For "what day of the week is it",
  the model answered *"The current date and time is Wednesday, October 18, 2021."* — a fluent,
  wrong, hallucinated date near its training cutoff, never touching the `time` tool even though the
  system prompt lists it and a `calc` few-shot example is right above it. For `read_file` it said
  *"I'm sorry, but I don't have the ability to access files on your device."* — it reasoned itself
  out of a capability it was explicitly told it has. For `go_run`, it answered "hello from sandbox"
  correctly, but almost certainly by reading the `fmt.Println("hello from sandbox")` line sitting
  right there in the prompt rather than by running the sandbox — a case where a "correct" answer
  actively conceals a missed tool call (`answer-ok: y`, `tool-ok: n` in the table above).

## Two verbatim examples (real model, `-cuda`)

One tool call, full transcript (`-show-transcript`):

```
$ go run -tags gpu ./cmd/ilaria-chat -cuda -model data/forge/bitnet-2b4t/bitnet.nxtf \
    -tokenizer data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json \
    -workdir cmd/ilaria-chat/testdata -max-tokens 64 -show-transcript \
    -prompt "What is 48213 * 9071?"

[tool] calc(48213*9071) -> 437340123
...
Assistant: CALL calc: 48213*9071
Tool: 437340123<|eot_id|>Assistant: 48213 times 9071 is 437340123.

48213 times 9071 is 437340123.
```

One direct answer, no tool call:

```
$ go run -tags gpu ./cmd/ilaria-chat -cuda -model data/forge/bitnet-2b4t/bitnet.nxtf \
    -tokenizer data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json \
    -workdir cmd/ilaria-chat/testdata -max-tokens 30 \
    -prompt "What is the capital of France?"

The capital of France is Paris.
```

## What was tuned

One honest iteration, before this run was captured: the very first version of `Runner.UserTurn` fed
`"Tool: <result><|eot_id|>"` back to the decoder without following it with the `"Assistant: "`
generation header. The model — which never learned to emit that header itself — just produced its
stop token immediately (empty final answer, 0/8 tool-using prompts got past the tool call). That was
a protocol bug, not a prompt-tuning problem: fixed once in `cortex/toolloop.go` (`Runner.feedToolResult`)
by always re-emitting the header after any fed-back message, matching what `Llama3ChatPrompt` does for
every other turn. No prompt wording, few-shot example, or eval prompt was changed after seeing these
numbers.

## Honest takeaways

A 2B model with no function-calling fine-tuning follows the *shape* of the protocol (one bare `CALL
tool: args` line, no narration) close to half the time it's actually needed, and essentially never
invents a false tool call on a prompt that doesn't need one (0/6) — the system prompt's few-shot
examples clearly teach the syntax. What it does not reliably do is (a) format tool arguments the way
each tool's deterministic parser expects (calc got natural-language qualifiers appended into the
expression; convert got the wrong unit or a fused unit pair), and (b) *decide* to call a tool at all
for prompts where its own training makes a fluent but wrong answer readily available (today's date,
file contents) — it would rather hallucinate plausibly than say "I don't know, let me check." Both are
exactly the failure modes you'd expect from a base chat model that was never trained on tool use, not
bugs in the loop itself: the loop faithfully executes whatever the model actually writes, correctly
refuses unknown tools and malformed calls, and (per `false-call rate: 0/6`) never calls a tool
uninvited.

## Addendum — system-prompt KV reuse (same day, later run)

`Runner` now Prefills the system prompt once and `ResetToSystem()` rewinds the decoder to it
(`TruncateTo(n)` on both BitNet decoders) instead of Reset + re-Prefill per prompt. Re-running the
exact command above gave the **identical table and totals** (greedy decoding, token-identical
prompt), with the per-prompt time falling from ~26 s to **0.7–2.3 s** (the first prompt pays the
one-time ~11 s system prefill). The 26 s figures above were almost entirely the ~500-token system
prompt being re-prefilled sequentially; the model's own answers take 1–2 s.
