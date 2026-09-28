# Handoff: Swyp Forge — teach Ilaria to write and repair verified code

Paste everything below the line into the next agent's chat.

---

You are continuing work in `D:\nexus` (Go module `nexus-cortex`). Read `AGENTS.md` first and follow it: work on a new branch `agent/swyp-forge`, never push, never read `data/`, `cuda/` or `*.exe` (passing a model path to a program is fine), and run `go vet ./...` plus `go test -count=1 -timeout 180s ./...` before claiming anything is done. Other agents have ~41 uncommitted changes in this checkout. Do not modify, stage, stash, revert or commit them: stage only files you created or changed, by explicit path.

## Where things stand (verified 2026-09-28)

- **Swyp Lang** lives in `swyp/`, which is its own Go module (`swyp-lang`) and outside `nexus-cortex`'s `./...`. Build it with `powershell -File swyp/scripts/build-local.ps1`; that writes `swyp/bin/swyp.exe`. Its tests are `cd swyp && go test ./...` (about 3 minutes). Read `swyp/README.md`, `swyp/docs/SEMANTIC_CORE.md` and `swyp/docs/ILARIA_LOOP.md`.
- **`swyp judge`** takes stdin `{"version":1,"source":"...","contract":{...}}` and returns a verification report plus a one-line `summary`:
  - `PASS exhaustive`
  - `FAIL counterexample: f(x=-50) returned -50, but the contract requires result >= 0`
  - `ERROR ... -- hint: ...`

  Contracts live in `swyp/examples/swyp/contracts/*.i64.json`. Keep the domain at 256 cases or fewer, so the verdict is `exhaustive` and not `tested`.
- **`cmd/ilaria-swyp`** is the loop. BitNet b1.58 2B writes the function; `cortex/swyp_solve.go` extracts it, verifies it with `cortex/swyp_tool.go` (`SwypJudgeChatTool.Verify`), and feeds the verdict back. Every prompt starts from a fresh context. Run it like this:
  ```
  go build -tags gpu -o <scratch>/ilaria-swyp.exe ./cmd/ilaria-swyp
  <scratch>/ilaria-swyp.exe -cuda -model data/forge/bitnet-2b4t/bitnet.nxtf \
    -tokenizer data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json \
    -swyp "D:\nexus\swyp\bin\swyp.exe" -contract swyp/examples/swyp/contracts/sum_to.i64.json \
    -task "Return the sum 1 + 2 + ... + n (zero when n is 0)."
  ```
  Each run loads the model (about 7 s), and a reply takes 3–10 s on the GTX 1660 Ti (6 GB).
- **Live baseline.** Out of 6 contracts, 5 were verified on the first reply: square, next, above, max2 and recursive sum_to. The sixth, `absolute`, was **never** repaired. The model wrote `if x < 0 { x } else { -x }`, got a correct counterexample, and in 3 more replies either repeated that code or made it worse.
- **The gap:** the model cannot repair logic from a counterexample. Decoding is greedy only; `Runner.argmax` has no sampling.
- **Training data format** (`forge/tool_data.py`, `load_trajectories`): JSONL rows of `{"language":"en","messages":[{"role","content"},...]}`. The first message is `system` and the last is `assistant`. Read the role-transition rules in that file before generating data. `forge/colab/` has the existing LoRA notebooks and builders (see `build_project_v6.py` and `Ilaria_Project_V7_Pilot.ipynb`). Adapters load with `-adapter <prefix>`.

## Goal

Measurably raise Ilaria's verified pass rate on **held-out** Swyp contracts, especially **repair after a counterexample**, using data that the Swyp verifier has checked end to end. Nothing enters the training set unless `swyp judge` produced its verdict.

## Plan (commit after each phase)

1. **Contract corpus.** Create `swyp/examples/swyp/tasks/` with about 60 tasks, each holding a contract, a plain-English task and a hand-written reference solution.
   - Cover these tiers: arithmetic, comparisons/branches (abs, clamp, sign, max3), loops (sum, product, count, power), recursion (factorial, fib with small bounds) and multi-input.
   - Write a Go test that runs `judge` on every reference and requires `exhaustive`, which proves each contract is satisfiable.
   - Freeze a split of 40 train and 20 held-out tasks, balanced by tier. **Held-out tasks must never appear in training data.**
2. **Batch evaluation.** Add `-tasks <jsonl>` to `ilaria-swyp`, so one model load runs many tasks, with `-rounds` and a JSONL report. Record the baseline pass@1 (verified on the first reply) and repair@4 (verified within 4 replies) on held-out tasks. Write the result into `swyp/docs/ILARIA_LOOP.md`.
3. **Verified repair trajectories.** Write a generator for the 40 train tasks.
   - **(a)** Mutate the reference solution: invert a comparison, swap branches, go off by one, replace `+`/`*`, drop a base case.
   - **(b)** Run `judge` on each mutant and keep only those with a real `FAIL counterexample`.
   - **(c)** Emit this conversation: system, user task, assistant wrong code, user "The verifier says: <exact summary>. Fix it.", assistant correct code, which must be `exhaustive` again.
   - Also emit direct first-try examples, and include real verified model replies from phase 2.
   - Put deterministic seeds and a manifest of hashes next to the data, following the pattern in `forge/colab/project-examples-v6/manifest.json`.
4. **LoRA.** Prepare a Colab notebook plus builder following the existing v6/v7 pattern, and dry-run it locally as far as possible without a GPU. **Colab needs the user's Google account: stop and give the user the exact cells to run.** Do not claim training happened.
5. **After an adapter exists.** Re-run phase 2 with `-adapter` on held-out tasks, and also run `cmd/ilaria-chat -eval cmd/ilaria-chat/testdata/tools_eval.jsonl` to check that general tool use did not regress. Report the before/after table. Accept the adapter only if held-out repair@4 improves and tools_eval does not drop.
6. **Optional, independent:** add a temperature/top-k sampling option to `Runner` (default stays greedy) and measure repair@4 with it against greedy on the same held-out tasks.

## Rules for claims

- Report what you ran, with the command and its output. `exhaustive` means complete execution over a finite domain; it is not an SMT proof, so never call it one.
- Six or even twenty tasks are a small sample. State the counts; never write "solves programming".
- If a phase fails or is blocked, say so and stop that phase. Do not paper over it.

## Pitfalls already hit

- **Escapes in shell text.** Bash heredocs and inline Python in this environment have mangled `\n` and `\b` in Go string literals and Windows paths. Write multi-line edits to a file with the editor tool, or use raw strings, and then run `gofmt -l` on your files.
- **CRLF from Python.** Python `write_text` on Windows converts LF files to CRLF. Use `write_bytes` and check with `git diff --check`.
- **Existing `gofmt -l` noise.** Many untouched `cortex/*.go` files are listed by `gofmt -l`. Check only your own files.
- **`swyp judge` timeouts.** It once exceeded its 10 s deadline at process start (probably antivirus); this did not reproduce. Treat a verifier timeout as an infrastructure error, not as a FAIL verdict.
- **`D:\swyp lang` is an empty leftover.** Ignore it; the code is only in `D:\nexus\swyp`.
- **Model habits.** The model writes Rust style and renames functions. Semantic Core now accepts tail expressions and final if/else expressions, and the loop renames a sole function to the contract entry. Keep those behaviours tested.
