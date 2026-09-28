# Real Learning Data (Phase 3) Implementation Plan

> **For Antigravity:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Evolve the Ilaria from a hardcoded demo to a trained cognitive organism capable of recalling facts on the capability scoreboard using a robust pre-training CLI tool (`cortex-train`) and a curriculum learning scheduler.

**Architecture:** A modular trainer CLI that loads a custom JSON/JSONL pre-training corpus (supporting both single paragraphs and Q&A pairs), sorts training samples by length and complexity (curriculum scheduler), measures cognitive surprise/prediction error, and performs dynamic spaced repetition of high-error samples.

**Tech Stack:** Go 1.26, Go Standard Library (bufio, encoding/json, flag, os, fmt, time), existing `ilaria/cortex` package.

---

## Task 6: Corpus Pipeline & Pre-training CLI

**Files:**
- Create: `data/corpus/README.md`
- Create: `data/corpus/general.jsonl`
- Create: `cmd/cortex-train/main.go`

### Step 1: Create Corpus Directory and Documentation

Create `data/corpus/README.md` describing the data format (text and Q&A pairs) and `data/corpus/general.jsonl` containing the exact training corpus to pass the basic recall suite.

### Step 2: Implement the Pre-Training CLI

Create `cmd/cortex-train/main.go`. It must:
1. Accept CLI flags:
   - `--data-dir` (string): Organism data directory (default: `data/cortex`).
   - `--corpus` (string): Path to corpus file or folder (default: `data/corpus/general.jsonl`).
   - `--epochs` (int): Number of curriculum epochs (default: 15).
   - `--fresh` (bool): Reinitialize a new empty organism instead of loading existing (default: false).
   - `--curriculum` (bool): Enable complexity-based curriculum sorting (default: true).
   - `--revisit` (bool): Enable dynamic surprise-based spaced repetition (default: true).
2. Load/Initialize the `Organism`.
3. Read the JSONL corpus streaming-fashion with a `bufio.Scanner`.
4. Parse both `{"text": "..."}` and `{"instruction": "...", "response": "..."}` objects.
5. Order/schedule items via `Curriculum`.
6. Log real-time training telemetry:
   - Tokens per second
   - Vocabulary growth rate
   - Global prediction error (surprise) trends
   - Revisit frequency
7. Save the fully trained organism back to the data directory.

---

## Task 7: Curriculum Learning & Spaced Repetition

**Files:**
- Create: `cortex/curriculum.go`
- Create: `cortex/curriculum_test.go`

### Step 1: Write the Failing Test

Create `cortex/curriculum_test.go` with a test verifying that the curriculum scheduler correctly parses items, sorts them by complexity (length), and generates revisit queues based on high surprise/prediction error.

### Step 2: Implement Curriculum Scheduler

Create `cortex/curriculum.go`. Define:
- `CorpusItem`: Struct representing a training entry (Text or Instruction/Response).
- `Curriculum`: Holds corpus items and provides complexity-based sorting.
- `Revisit Queue`: Logic to schedule specific items for extra training cycles based on the surprise/prediction error feedback from the organism.

### Step 3: Integrate and Run Tests

Run `go test -v ./cortex/...` to verify both curriculum tests and existing brain/vocab tests pass.

### Step 4: Run Evaluation Baseline Check

Run the training pipeline:
`go run ./cmd/cortex-train --fresh --epochs=15`
And run evaluation:
`go run ./cmd/cortex-eval`
Expected Result: Capability score rises from 40% to 100% since facts are properly stored in the episodic memory (Hippocampus) and linked in the associations (Brain/Wernicke).

---

## Verification Plan

### Automated Tests
- Run `go test -v ./cortex/...`
- Run `go vet ./...` and `staticcheck ./...`

### Manual Verification
- Run `go run ./cmd/cortex-train --fresh --epochs=15` and check telemetry prints correctly.
- Run `go run ./cmd/cortex-eval` to confirm a score of 100/100 and cognitive status upgrades to `Emergent Agent` or `Cognitive System`.
