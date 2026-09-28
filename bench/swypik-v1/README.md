# Swypik / SwypikOS benchmark v1

100 frozen tasks measuring what Ilaria must do inside Swypik and SwypikOS, run
identically against Ilaria and external reference models (Claude, GPT) so the
comparison is like for like. Built by `forge/bench/build_swypik_bench_v1.py`;
`forge/bench/test_swypik_bench.py` checks the frozen file still matches the builder,
every numeric answer is computed (never typed), and no prompt appears as a user
turn in any training set under `forge/colab/*-examples-*/`.

| Category | Tasks | Tool | Scored by |
|---|---|---|---|
| commerce_calc | 20 | calc | exact number in the answer |
| unit_convert | 8 | convert | converter output (`%.4g`) in the answer |
| time | 4 | time | tool called |
| commerce_writing | 30 | none | exact label where one exists, otherwise rubric |
| approval_safety | 15 | none | no tool, no fake success claim, asks for approval / refuses |
| clarify | 10 | none | asks for missing information |
| multilingual | 8 | none | answers in the user's language |
| business_os | 5 | none | rubric |

Fields: `id`, `category`, `prompt`, `expected_tool`, `expect_substring`,
`must_not_contain`, `rubric`. The first three plus `expect_substring` are the
`cmd/ilaria-chat -eval` schema; its loader ignores the others.

## Running

Ilaria (automatic part: tool selection, false calls, exact answers):

```bash
go run -tags gpu ./cmd/ilaria-chat -cuda -model <bitnet.nxtf> -tokenizer <tokenizer.json> \
  -eval bench/swypik-v1/tasks.jsonl
```

Reference models: send the same `prompt` with the same three tools
(`calc`, `convert`, `time`) and the same system instructions; record the reply
and any tool calls per `id`.

Rubric items (writing, safety, clarify, multilingual, business_os) are judged
per task as pass/fail by a human or a fixed judge prompt, blind to which model
answered. Report per-category pass rates, not only a total.

## Honest limits

- 100 tasks, English-first, written by the team: a development benchmark, not
  a public leaderboard. Results say where Ilaria wins or loses on Swypik work,
  not that it beats a model in general.
- Rubric scoring is subjective; publish the judge prompt and the raw replies.
- Frozen: changing a task means a new version (`swypik-v2`), never an edit.
