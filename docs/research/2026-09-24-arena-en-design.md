# English arena: Ilaria-130M vs. published BitNet b1.58 2B4T numbers

**Owner**: this task. **New files**: `forge/eval/arena_en.py`, `forge/eval/arena_ilaria_adapter.py`,
`forge/colab/arena_en.sh`. **Harness**: `lm_eval` (lm-evaluation-harness) 0.4.11, installed and
verified locally (`pip show lm_eval`).

## Goal

A reproducible English benchmark run so Ilaria-130M's numbers land in the same table as numbers
already published for a real model, instead of floating on their own with no anchor. The anchor is
`microsoft/bitnet-b1.58-2B-4T` — chosen because it's the other ternary/1-bit model in this repo
(`forge/bitnet_reference.py` already loads it for Go-parity logit checks) and because its technical
report publishes exact per-task few-shot settings we can replicate instead of guessing.

## Task / few-shot settings, replicated from the report

Source: **BitNet b1.58 2B4T Technical Report**, Shuming Ma et al., Microsoft Research —
<https://arxiv.org/abs/2504.12285> (read via the HTML rendering, `arxiv.org/html/2504.12285v1`, since
`WebFetch` was unavailable in this session; quotes below are verbatim from that page).

Table 1 reports each benchmark with its shot count directly under the benchmark name, e.g.
`ARC-Challenge (0-shot; Acc,norm)`, `MMLU (5-shot; Acc)`, `GSM8K (4-shot; EM)`. Appendix B
("Evaluation Pipeline Details") states the methodology directly:

> "For all other benchmarks assessing language understanding, reasoning, knowledge, and
> comprehension, we used the standard lm-evaluation-harness framework. Models were prompted using a
> chat format for generative tasks (e.g., GSM8K, IFEval, and MT-Bench), while default settings from
> the respective toolkits were used for other tasks."

This is exactly what `arena_en.py` replicates: harness defaults for every metric/filter choice
(we never override a task's `metric_list`), with two things pinned per task — `num_fewshot` and
whether chat formatting is applied:

| Task            | num_fewshot | chat format | Paper's metric (Table 1)  |
|-----------------|:-----------:|:-----------:|----------------------------|
| `mmlu`          | 5           | no           | acc                        |
| `gsm8k`         | 4           | **yes**      | exact_match                |
| `arc_challenge` | 0           | no           | acc_norm                   |
| `arc_easy`      | 0           | no           | acc_norm                   |
| `hellaswag`     | 0           | no           | acc_norm                   |
| `winogrande`    | 0           | no           | acc                        |
| `piqa`          | 0           | no           | acc_norm                   |
| `ifeval`        | 0           | **yes**      | inst_level_strict_acc      |

(`FEWSHOT_BY_TASK` / `CHAT_TASKS` in `arena_en.py`.) Note `gsm8k`'s own harness yaml defaults to
`num_fewshot: 5`, not 4 — `arena_en.py`'s explicit `num_fewshot=4` override for that group is what
makes this match the paper rather than the harness's own default.

The published Table 1 values for BitNet b1.58 2B4T (as fractions, matching the harness's 0-1 scale)
are baked into `arena_en.py`'s `REFERENCE` dict and rendered as a "BitNet 2B4T (paper)" column
alongside our own measured value — cited from the same URL, restated in `docs/benchmarks/arena_en.md`
on every run.

Benchmarks the report also uses (OpenbookQA, BoolQ, CommonsenseQA, TruthfulQA, TriviaQA, MATH-500,
HumanEval+, MT-bench) are out of scope for this task's fixed list and use non-`lm-evaluation-harness`
toolkits for some of them (evalplus, a math-evaluation-harness fork, LLM-judge) per Appendix B, so
they wouldn't be apples-to-apples with a single `lm_eval` run anyway.

## lm_eval API used

`lm_eval.evaluator.simple_evaluate(model=<LM instance>, tasks=[...], num_fewshot=int,
apply_chat_template=bool, fewshot_as_multiturn=bool, limit=..., task_manager=<shared TaskManager>,
...)`. Passing an already-constructed `LM` object (rather than a model-name string) is an explicitly
supported path (`evaluator.py`: `else: ... lm = model`) — `arena_en.py` uses it for both systems so
the model is loaded exactly once per run.

**Why grouped, not one call**: `num_fewshot` and `apply_chat_template` are call-wide in this harness
version, not per-task, so a single task list can't mix 5-shot MMLU with 4-shot chat-formatted GSM8K
in one `simple_evaluate()` call. `arena_en.py:group_tasks()` buckets the requested tasks by
`(num_fewshot, chat)` and issues one `simple_evaluate()` call per bucket (≤4 for the default 8-task
list), sharing one `TaskManager()` (built once — its yaml-index build is the slow part, observed
~1-2 minutes cold) and, for `results`/`versions`/`n-shot`/`higher_is_better`, one merged dict.

The Markdown table (`build_rows` + `render_table`) is written by hand rather than via
`lm_eval.utils.make_table` because the deliverable needs a "BitNet 2B4T (paper)" reference column
that the harness's own table has no concept of; it keeps the harness's `metric,filter` key format
(e.g. `exact_match,strict-match`) as the "Metric" column so multiple filters on one task (GSM8K's
`strict-match`/`flexible-extract`) both show up as separate rows, matched to the reference by the
metric root before the comma.

## System A: BitNet b1.58 2B4T (`--system bitnet2b`)

`arena_en.py:load_bitnet_lm()` builds `lm_eval.models.huggingface.HFLM(pretrained=<local dir>,
dtype="bfloat16", batch_size=..., device=...)` — the harness's own `hf` backend, per the task brief.

**The uint8-weight quirk.** This PC's transformers 5.3.0 + this checkpoint reproduce the bug
documented in `forge/bitnet_reference.py:_fix_unmaterialized_offline_weights`: `from_pretrained`
completes without error but leaves every offline `AutoBitLinear.weight` packed as `torch.uint8`
instead of unpacked ternary floats, and forward raises `float != unsigned char`. `load_bitnet_lm()`
reuses that exact function (unmodified, imported as `bitnet_reference._fix_unmaterialized_offline_weights`)
against `HFLM`'s own `.model` right after construction — it's conditional by construction (checks
`mod.weight.dtype == torch.uint8` per module and no-ops, returning 0, when the bug doesn't reproduce,
e.g. a newer transformers on Colab per the task brief).

One wrinkle the reused function doesn't handle, because its only caller before now
(`bitnet_reference.py:run_real`) always loads float32-only on CPU: the fix re-reads the raw tensor
straight from `model.safetensors` and produces a **new CPU float32** `nn.Parameter`, but `HFLM.__init__`
has already moved the rest of the model to `device` in the requested `dtype` (bf16) by the time
`load_bitnet_lm()` gets to call the fix. Left alone this would just trade the original
`float != unsigned char` crash for a `bfloat16 != float32` / `cuda != cpu` one on the same line.
`load_bitnet_lm()` closes that gap itself (not by editing `bitnet_reference.py`, which is outside
this task's file ownership): after the fix runs, it walks the same `AutoBitLinear` modules and
moves+casts each fixed `.weight` to `(lm.device, target_dtype)`. This is lossless — ternary values
are exactly `{-1, 0, +1}`, representable exactly in bf16/fp16/fp32 alike.

**OOM fallback.** `main()` wraps `load_bitnet_lm()` in a `try/except RuntimeError`: a CUDA OOM message
triggers one retry with `device="cpu", dtype="float32", batch_size=1`, and clamps `--limit` to ≤3 —
this is what §Smoke below actually exercised on the 6 GB card.

## System B: Ilaria-130M (`forge/eval/arena_ilaria_adapter.py`)

`Ilaria130MLM(TemplateLM)`, registered as `@register_model("ilaria")`, built directly on
`forge/ilaria_model.py` + `forge/nxtf.py:load_nxtf` + `forge/hf_tokenizer.py:load` — the same trio
`forge/ppl.py` uses, so this adapter inherits that script's already-checked Go-parity guarantees
(float32 CUDA, no autocast, `load_nxtf` only ever copies float32 data — asserted at construction).

- `eot_token_id` = `model.cfg.eos_token_id`, read from the checkpoint's own NXTF header rather than
  hardcoded — for `data/forge/brain-a/transformer.nxtf` this resolves to `0`, confirmed by reading
  the header directly (`"eos_token_id": 0`) and cross-checked against the tokenizer's own
  `<|endoftext|>` vocab id (also `0`) — matching the task brief's "EOS id 0".
- `_loglikelihood_tokens`: per-request forward pass (`model(ids)`), `log_softmax`, then the
  continuation's tail log-probs gathered against its own token ids — same slicing rule
  (`logits[inplen-contlen:inplen]`, here expressed as slicing the tail since context is always a
  prefix) that `lm_eval.models.huggingface.HFLM._loglikelihood_tokens` uses, so `is_greedy`/log-prob
  semantics match what harness tasks expect.
- `loglikelihood_rolling`: reuses `lm_eval.utils.get_rolling_token_windows` /
  `make_disjoint_window` directly — the same windowing helper `HFLM.loglikelihood_rolling` calls —
  rather than reimplementing chunking, so the two backends can't quietly drift on that algorithm.
  (None of the 8 default tasks call this method; it's implemented because `TemplateLM` requires it.)
- `generate_until`: manual greedy loop (argmax each step, no sampling) that stops at `eot_token_id`
  or the first matching string in the task's `until` list, whichever comes first; honors a task's own
  `gen_kwargs["max_gen_toks"]` (e.g. `ifeval` sets 1280) over the adapter's `--max-gen-toks` default.

**Unbatched by design.** Every model call is a single `[1, T]` forward — no padding, no attention
mask. `IlariaTransformer.forward` takes no mask argument and its causal `scaled_dot_product_attention`
only ever looks backward within one sequence, so right-padded batching would in fact be safe to add
later, but it's not implemented now: correctness-first for a 130M model that's "fine on the 6 GB GPU"
per the task brief, and it sidesteps an entire class of padding/masking bugs. `batch_size` is still
accepted on the constructor (so `hf`-style `model_args` strings don't blow up) but documented as
unused. See §Caveats for what this costs on the full Colab run.

**Chat format**: never applied to Ilaria — it's an untuned base LM with no `tokenizer.chat_template`
(`hf_tokenizer.py`'s byte-level BPE has no chat-template concept at all), so wrapping its few-shot
prompts in BitNet's `System:/User:/Assistant:` template would just be adding noise tokens it was
never trained to interpret. `arena_en.py` hardcodes `chat_eligible = (system == "bitnet2b")`
rather than exposing this as a real per-system option.

## `arena_en.py` CLI

```
python forge/eval/arena_en.py --system {bitnet2b,ilaria130m} [--tasks t1,t2,...] [--limit N]
    [--out results/<system>.json] [--device ...] [--dtype ...] [--batch-size ...]
    [--hf-dir ...] [--brain-dir ...] [--bench-md docs/benchmarks/arena_en.md]
```

Prints the Markdown table, writes the full `results`/`versions`/`n-shot`/`higher_is_better` dict as
JSON to `--out` (default `results/<system>.json`), and appends a dated section (settings + table) to
`docs/benchmarks/arena_en.md`, creating it with a header + the report citation on first use.
`forge/colab/arena_en.sh` runs both systems back to back on Colab and copies `results/*.json` +
`docs/benchmarks/arena_en.md` to `MyDrive/ilaria/arena/`.

## Caveats

- **IFEval is slow and needs real generation** for both systems — 1280-token greedy decode per
  example, no early stop for Ilaria unless a `<|endoftext|>` happens to appear (it's untuned, so it
  usually won't within budget). Expect it to dominate wall-clock for `ilaria130m`.
- **GSM8K/IFEval chat formatting is BitNet-only**; Ilaria's numbers on those two tasks reflect
  plain-completion prompting, not the paper's chat-formatted setup — expected to be weaker for that
  reason alone, independent of raw capability.
- **Ilaria scoring is unbatched.** Fine at `--limit 20` (see §Smoke); the full default 8-task list
  (MMLU alone is ~14k questions × ~4 choices) will be throughput-bound by Python/kernel-launch
  overhead per request rather than GPU compute — see the runtime estimate in the final report.
- **The uint8-weight fix is this-PC/this-transformers-version-specific** by the same reasoning
  `bitnet_reference.py` already documents; `load_bitnet_lm()` logs how many modules it touched (0 on
  a run where it isn't needed) so a Colab run's log makes the difference visible.
- **BitNet's 6 GB-card path is a smoke test, not a real number** — `--limit 5` on one task, batch
  size 1, with a CPU/`--limit 3` fallback if bf16 still doesn't fit; real BitNet numbers should come
  from the Colab run.
