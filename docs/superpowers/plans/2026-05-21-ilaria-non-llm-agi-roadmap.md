# Ilaria Non-LLM AGI Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Ilaria from a hardcoded neural demo into a measurable non-LLM cognitive engine that can improve through data, memory, feedback, and benchmarks.

**Architecture:** Keep the project non-LLM, but stop treating architecture names as proof of intelligence. Build a testable core: deterministic config, clean data pipeline, native sequence prediction, semantic memory, feedback learning, evaluation harness, and scaling path.

**Tech Stack:** Go 1.26, existing `ilaria/cortex` package, binary persistence, CLI tools, JSON/JSONL corpora, Go tests, `go vet`, `staticcheck`.

---

## Reality Contract

The target is not "declare AGI"; the target is "prove capability". Each phase must add a measurable behavior that was not present before. A phase is complete only when it has tests, metrics, and a before/after score.

First win condition: Ilaria must stop echoing the prompt and must answer from learned memory with confidence scores that match reality.

Second win condition: Ilaria must learn from a held-out corpus and improve next-token/next-concept prediction without code changes.

Third win condition: Ilaria must beat small non-LLM baselines first: n-gram, Markov, TF-IDF retrieval, and simple RNN-style sequence memory if added later.

Only after those wins should it be compared to a classical LLM.

---

## File Structure

- Modify: `cortex/vocab.go` - safe vocabulary growth, tokenizer tests, no silent `<UNK>` contamination.
- Modify: `cortex/brain.go` - generation should not return the prompt as the answer.
- Modify: `cortex/organism.go` - separate process pipeline from demo, add confidence-aware answer policy.
- Modify: `cmd/cortex/main.go` - add CLI flags for data dir, seed, demo mode, no-save, fresh start.
- Modify: `cmd/cortex/interactive.go` - scanner error handling and data-dir aware save.
- Create: `cortex/config.go` - all sizes, thresholds, seeds, paths, and learning knobs.
- Create: `cortex/eval.go` - shared evaluation primitives.
- Create: `cmd/cortex-eval/main.go` - benchmark runner.
- Create: `cortex/*_test.go` - unit and regression tests.
- Create: `data/corpus/README.md` - corpus format and quality rules.
- Create: `data/evals/*.jsonl` - fixed benchmark sets.

---

## Phase 1: Make The Current System Honest

### Task 1: Fix Vocabulary Overflow

**Files:**
- Modify: `cortex/vocab.go`
- Test: `cortex/vocab_test.go`

- [ ] Write a failing test proving `GetOrCreate` never silently returns `0` for a normal new word.
- [ ] Change the full-vocab behavior to return an explicit error from a new method `GetOrCreateChecked`.
- [ ] Keep `GetOrCreate` as a compatibility wrapper, but make internal training call the checked method.
- [ ] Run: `go test ./cortex -run TestVocab -v`
- [ ] Run: `staticcheck ./...`
- [ ] Commit: `fix: make vocab overflow explicit`

### Task 2: Stop Prompt Echo As A Valid Answer

**Files:**
- Modify: `cortex/brain.go`
- Modify: `cortex/organism.go`
- Test: `cortex/brain_test.go`
- Test: `cortex/organism_test.go`

- [ ] Add a regression test: input `where do neurons fire?` must not return the exact same string.
- [ ] Change `Brain.Generate` so prompt tokens are context, not output.
- [ ] Add answer policy: if no confident continuation exists, return `(no confident response)` or a structured low-confidence result.
- [ ] Run: `go test ./cortex -run 'TestBrain|TestOrganism' -v`
- [ ] Commit: `fix: prevent prompt echo responses`

### Task 3: Separate Demo From Engine

**Files:**
- Create: `cortex/config.go`
- Modify: `cmd/cortex/main.go`
- Modify: `cmd/cortex/interactive.go`

- [ ] Add config fields: `DataDir`, `Seed`, `Demo`, `NoSave`, `Fresh`, `MaxGenWords`.
- [ ] Add CLI flags: `--data-dir`, `--seed`, `--demo`, `--no-save`, `--fresh`, `--interactive`.
- [ ] Make demo corpus run only when `--demo=true`.
- [ ] Make audit-safe runs possible with `--no-save`.
- [ ] Run: `go run ./cmd/cortex --demo=false --no-save`
- [ ] Commit: `feat: add runtime config and audit-safe mode`

---

## Phase 2: Build Measurement Before Intelligence Claims

### Task 4: Add Evaluation Harness

**Files:**
- Create: `cortex/eval.go`
- Create: `cmd/cortex-eval/main.go`
- Create: `data/evals/basic_recall.jsonl`
- Create: `data/evals/no_echo.jsonl`

- [ ] Define JSONL format: `{"input":"...","must_not_equal_input":true,"expected_contains":["..."]}`.
- [ ] Implement evaluator that loads an organism, runs each case, records response, confidence, surprise, and pass/fail.
- [ ] Add `--report-json` flag for machine-readable output.
- [ ] Run: `go run ./cmd/cortex-eval --data-dir ./data/cortex --eval ./data/evals/no_echo.jsonl`
- [ ] Commit: `feat: add benchmark runner`

### Task 5: Add Capability Scoreboard

**Files:**
- Create: `docs/metrics.md`
- Modify: `cmd/cortex-eval/main.go`

- [ ] Track: exact echo rate, recall accuracy, unknown-answer honesty, prediction error, confidence calibration.
- [ ] Add a score summary from 0 to 100.
- [ ] Print failed examples first.
- [ ] Commit: `feat: add measurable capability scoreboard`

---

## Phase 3: Real Learning Data

### Task 6: Corpus Pipeline

**Files:**
- Create: `data/corpus/README.md`
- Create: `cmd/cortex-train/main.go`
- Modify: `cortex/organism.go`

- [ ] Define corpus as UTF-8 JSONL: `{"text":"...", "source":"...", "lang":"ro|en", "quality":1}`.
- [ ] Add trainer command with `--corpus`, `--epochs`, `--shuffle`, `--save-every`.
- [ ] Reject broken UTF-8 and empty rows.
- [ ] Print tokens/sec, new vocab words, prediction error trend.
- [ ] Commit: `feat: add corpus training pipeline`

### Task 7: Curriculum Learning

**Files:**
- Create: `cortex/curriculum.go`
- Test: `cortex/curriculum_test.go`

- [ ] Sort training samples by length, novelty, and failure history.
- [ ] Revisit failed examples more often.
- [ ] Stop overtraining repeated hardcoded demo lines.
- [ ] Commit: `feat: add curriculum scheduler`

---

## Phase 4: Native Non-LLM Language Core

### Task 8: Replace Markov-Like Generation With Sequence Memory

**Files:**
- Create: `cortex/sequence_memory.go`
- Test: `cortex/sequence_memory_test.go`
- Modify: `cortex/brain.go`

- [ ] Store transitions over token IDs with context windows of 1, 2, 4, 8, and 16 tokens.
- [ ] Predict next token by weighted context match, recency, confidence, and novelty penalty.
- [ ] Return top-k candidates with scores, not just one word.
- [ ] Add tests where longer context beats shorter context.
- [ ] Commit: `feat: add multi-window sequence memory`

### Task 9: Add Semantic Memory

**Files:**
- Create: `cortex/semantic_memory.go`
- Test: `cortex/semantic_memory_test.go`
- Modify: `cortex/hippocampus.go`

- [ ] Extract concepts from repeated contexts.
- [ ] Store concept-to-evidence links.
- [ ] Recall facts with source memory IDs.
- [ ] Require answer generation to cite an internal memory ID in debug mode.
- [ ] Commit: `feat: add semantic memory layer`

---

## Phase 5: Feedback And Self-Improvement

### Task 10: Human Feedback Loop

**Files:**
- Modify: `cmd/cortex/interactive.go`
- Create: `cortex/feedback.go`
- Test: `cortex/feedback_test.go`

- [ ] Add commands: `/good`, `/bad`, `/correct <text>`.
- [ ] Store feedback events separately from normal memories.
- [ ] Increase/decrease transition confidence based on feedback.
- [ ] Add tests proving correction changes future output.
- [ ] Commit: `feat: add human feedback learning`

### Task 11: Self-Training Without LLM

**Files:**
- Create: `cmd/cortex-selfplay/main.go`
- Create: `cortex/selfplay.go`

- [ ] Generate questions from known memories.
- [ ] Answer them.
- [ ] Grade only with deterministic checks: memory overlap, contradiction, exact known facts.
- [ ] Never train on self-generated text unless it passes deterministic validation.
- [ ] Commit: `feat: add deterministic self-training loop`

---

## Phase 6: Robust Persistence And Safety

### Task 12: Harden Binary Loaders

**Files:**
- Modify: `cortex/brain.go`
- Modify: `cortex/hippocampus.go`
- Modify: `cortex/network.go`
- Test: `cortex/persistence_test.go`

- [ ] Add max limits for synapse count, neuron count, memory count, SDR byte length.
- [ ] Reject negative or impossible lengths before allocation.
- [ ] Add corrupt-file tests.
- [ ] Commit: `fix: validate persisted model files`

### Task 13: Save Full Organism State

**Files:**
- Modify: `cortex/organism.go`
- Modify: `cortex/wernicke.go`
- Modify: `cortex/predictor.go`
- Modify: `cortex/self.go`

- [ ] Persist Wernicke n-grams.
- [ ] Persist predictor state.
- [ ] Persist self-model and feedback state.
- [ ] Add roundtrip test: train, save, load, same answer and same stats.
- [ ] Commit: `feat: persist complete organism state`

---

## Phase 7: Scaling Path

### Task 14: Performance Baseline

**Files:**
- Create: `cortex/bench_test.go`
- Create: `docs/performance.md`

- [ ] Benchmark tokenization, encoding, sequence prediction, recall, save, load.
- [ ] Track memory usage with corpus size.
- [ ] Add target budgets: latency under 100 ms for short input, save under 2 s for baseline.
- [ ] Commit: `test: add performance baselines`

### Task 15: Sharding And Pruning

**Files:**
- Create: `cortex/store.go`
- Modify: `cortex/sequence_memory.go`
- Modify: `cortex/semantic_memory.go`

- [ ] Split memories by language and concept hash.
- [ ] Prune low-confidence transitions.
- [ ] Keep high-value feedback memories permanently.
- [ ] Commit: `feat: add scalable memory store`

---

## Phase 8: AGI Gate

Ilaria can be called "AGI candidate" only when it passes all gates below without changing code between tasks:

- No prompt echo on unknown questions.
- Learns new facts from text and recalls them later.
- Admits uncertainty when evidence is missing.
- Improves after correction.
- Generalizes a pattern to a new example.
- Keeps memory across restart.
- Beats n-gram and retrieval baselines on project evals.
- Shows calibrated confidence: high confidence is usually right, low confidence is usually uncertain.

Until then, it is a cognitive architecture experiment, not AGI.

---

## Execution Order

1. Phase 1 fixes correctness.
2. Phase 2 adds proof.
3. Phase 3 adds real data.
4. Phase 4 builds the native language core.
5. Phase 5 adds learning from feedback.
6. Phase 6 makes it reliable.
7. Phase 7 makes it scale.
8. Phase 8 decides whether the AGI claim is earned.

Do not skip Phase 2. Without evals, every improvement is just a story.
