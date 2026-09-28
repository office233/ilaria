# AGENTS.md

## 1. What This Project Is
Ilaria is an experimental sparse cognitive architecture written in Go.
It combines Sparse Distributed Representations (SDRs), associative memory, online learning,
and sparse routing into a biologically-inspired, local-first cognitive prototype.

## 2. Stack & Layout
- Stack: Go 1.26.2 (see go.mod), optional CUDA/WebGPU compute; headless service for SwypikOS.
- `cmd/`: CLI applications, trainers, evaluators, benchmarks, and headless API server (`ilaria-serve`).
- `cortex/`: Core cognitive engine implementing brain regions (Wernicke, Broca, Hippocampus), SDRs, and compute.
- `cortex/compute/`: Hardware compute abstractions for CPU, optional CUDA, and WebGPU bindings.
- `docs/`: Architecture designs, limitations disclosures, and capability scoreboard metrics.
- `scripts/`: Data ingestion, tokenization, training watchers, and build helper scripts.
- `data/`: Training corpora, evaluation suites (`.jsonl`), and organism persistence state.
- `cuda/`: Standalone CUDA kernel implementations for GPU acceleration.
- `swypik-os/`: SwypikOS (separate Go module `swypik-os`, imported with history). Build and test it from that
  directory: `cd swypik-os && go vet ./... && go test ./...`. It talks to `cmd/ilaria-serve` over `POST /v1/chat`.

## 3. How to Build / Test / Lint
- Build all commands: `go build ./cmd/...`
- Build entire repository: `go build ./...`
- Build with WebGPU tag: `go build -tags webgpu ./cortex/compute/...`
- Run linter / static analysis: `go vet ./...`
- Run standard test suite: `go test -count=1 -timeout 180s ./...`
- Run fuzz smoke tests:
  - `go test -run=^$ -fuzz=FuzzUnmarshalTernaryLayer -fuzztime=15s ./cortex`
  - `go test -run=^$ -fuzz=FuzzLoadSemanticMemory -fuzztime=15s ./cortex`
  - `go test -run=^$ -fuzz=FuzzFractalCortexLoadMetadata -fuzztime=15s ./cortex`
- Run headless API: `go run ./cmd/ilaria-serve -model <bitnet.nxtf> -tokenizer <tokenizer.json>`
- SwypikOS owns the UI in its own repository. Do not recreate a dashboard here.
- Run evaluation: `go run ./cmd/cortex-eval -data-dir ./data/cortex`

## 4. Conventions Found
- Formatting: Standard Go formatting enforced via `gofmt` and `go vet`; tabs for indentation.
- Generated code: No code generator toolchain; manual fallback stubs (`cublas_stub.go`, `radio_cuda_stub.go`).
- Migrations: No database migration framework; state persisted via JSON and custom binary formats (NTX1).
- i18n: No dedicated i18n framework; docs in EN/RO, dual-language search seed queries (`en`, `ro`).
- Naming: Go idiomatic camelCase/PascalCase; snake_case for Go files; kebab-case for `cmd/` subdirectories.

## 5. Do Not Modify
- Do not modify: deploy scripts (`scripts/*.ps1`, `scripts/*.bat`), CI workflows (`.github/workflows/*`), prod configs, secrets (`.env*`), backups, or generated binary dirs (`bin/`, `dist/`).
- Do not run deploy, push, or publish commands (`git push`, release scripts).
- Do not open or read restricted paths: `.env*`, `private/`, `backups/`, `uploads/`, `node_modules/`, `dist/`, `*.zip`, `*.log`, `*.exe`, `data/`, `cuda/`, or secrets of any kind.

## 6. Change Policy
- Branching: Always work on a dedicated branch named `agent/<task>`.
- Commits: Keep commits small, focused, and accompanied by clear commit messages.
- Verification: Run `go vet ./...` and `go test -count=1 -timeout 180s ./...` before reporting done.
- Scope: Touch only files explicitly requested by the task; never run destructive git commands.
