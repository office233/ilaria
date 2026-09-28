# Ilaria: headless operation and safety changes

Ilaria contains the model engine, training/evaluation tools and a headless HTTP
service. SwypikOS owns the user interface in its own repository. The embedded
`web/` package and `cmd/cortex-web/` dashboard have been removed; do not add a
replacement frontend here. Old design notes may describe that retired dashboard.
The deprecated `WebPort`/`WebBindAddr` JSON fields remain for compatibility, but
are not a UI and do not configure `ilaria-serve`.

## SwypikOS integration

Start with real, compatible BitNet model and tokenizer paths:

```sh
go run ./cmd/ilaria-serve -model /path/to/bitnet.nxtf -tokenizer /path/to/tokenizer.json
```

The existing contract is retained: `GET /health`, `POST /v1/chat`, default
`127.0.0.1:8091`. Minimal request body: `{"prompt":"Salut"}`. Existing alternating
history validation, JSON size limits, tool budgets and response fields are
unchanged. SIGTERM now initiates the same graceful shutdown as an interrupt.

Call from the SwypikOS **backend**, not directly from browser JavaScript. The
service intentionally rejects browser origins and cross-site requests. Do not
remove those checks or enable wildcard CORS to integrate the UI. For non-loopback
serving, the existing TLS certificate/key and `ILARIA_API_TOKEN` requirements
remain. Keep credentials in the SwypikOS backend and operator secret configuration,
never in browser code or this repository. No SwypikOS repository is changed by
these fixes.

The former dashboard's `/api/chat`, `/api/save`, `/api/sleep`, `/api/feedback` and
other UI endpoints are **removed**, not aliases for `/v1/chat`. No equivalent
state-mutating HTTP routes were silently added to the inference service.

## Executing Go code

`cortex/swe.RunGo` now fails closed: no OS-isolated executor is configured.
The zero value `GoRunChatTool{}` also refuses execution. `ilaria-serve` never
registers this tool.

`RunTrustedGo` / `RunTrustedGoWithOptions` are explicitly unsafe, operator-selected
host executors. The existing CLI option `ilaria-chat -allow-host-go` opts into
that behavior and prints a warning. It must not be set by model output or exposed
to untrusted remote users. These functions limit source files/bytes, execution
time, stdout+stderr capture, automatic dependency downloads and normal Unix
process-group lifetime. They **do not** isolate filesystem access, networking,
user identity, RAM or deliberately detached processes. No claim of secure
containerization is made. Non-Unix host execution refuses to run until a supported
process-tree/isolated executor is implemented there.

Built-in execution limits can be configured through `TrustedGoOptions`.
The temporary module's Go version follows the runtime instead of a fixed version;
`GOTOOLCHAIN=local` and `GOPROXY=off` prevent toolchain/dependency downloads.
Existing fixed executor test fixtures deliberately use the trusted API; separate
tests verify default refusal and resource handling.

## Configuration and existing state

`cmd/cortex` and `cmd/train` apply only explicit CLI flags after loading defaults
and JSON. Explicit zero/false values are valid overrides. The final merged
configuration is validated. Configuration JSON is published via a temporary file
rather than truncating the last good file first.

`OpenOrganism` is used by `cmd/cortex`, `cmd/train` and `cmd/cortex-autonomous`.
Only an absent or genuinely empty data directory permits new state. Existing
state is loaded without a fallback that overwrites it after a load error.
`-fresh` on an existing non-empty directory is refused: choose a new directory.
This deliberately changes old overwrite behavior. Operate one process/writer per
data directory. Legacy callers of `NewOrganism`/`LoadOrganism` elsewhere were not
all migrated in this change.

**Remaining limitation:** `Organism.Save` is still a multi-file, nontransactional
legacy save. The configuration writer's atomic publication does not turn the
entire organism into a generation-based snapshot. A safe migration requires
updating and testing the other model/CLI readers, not only replacing `Save`.
Maintain independent recovery copies of valuable state before using these legacy
training paths.

## Training and resume

The trainer validates token stream dtype (explicit little-endian uint16/uint32),
file length, token ID range, model dimensions, batch sizes and train/validation
split before allocating the model. The last valid training window is included.
Validation uses independent deterministic windows and restores the model's mode.

PT/NXTF files are individually written to private temporary files, flushed,
fsynced, closed and then replaced. Failed serialization cannot first truncate the
old target. These are **not** a joint filesystem transaction or a guarantee for
all network/Drive filesystems. The checkpoint stores the hash of its matching best
NXTF export; resume refuses a missing or mismatched pair rather than silently
claiming reproducibility. A crash between the two publications may require a
matching recovery copy. Concurrent writers to one run directory are unsupported.

Current checkpoints include a versioned schema, model/optimizer/GradScaler state,
NumPy/Python/Torch CPU/CUDA RNG states, token count and a training signature with
model configuration, data/tokenizer hashes, stream format, runtime versions and
learning-rate schedule. Resume keeps the original total step horizon:

```sh
# Example pattern; all model/data arguments must match on both invocations.
python forge/train_ilaria.py --data /path/to/tokens --out /path/to/run --steps 3000 --stop-after 500
python forge/train_ilaria.py --data /path/to/tokens --out /path/to/run --steps 3000 --resume /path/to/run/checkpoint.pt
```

`--stop-after` saves resume state without adding an unscheduled validation or
changing best-model selection. `--resume` is not compatible with legacy
unversioned checkpoints; use the explicitly named `--init-from` option to warm
start from matching legacy weights with a fresh optimizer/RNG. Both load paths
use `weights_only=True`. Large/untrusted PT files remain resource-sensitive; the
restricted unpickler is not a memory limit or an OS sandbox.

Bitwise CPU continuity was verified for small synthetic runs with dropout and
gradient accumulation, including pauses between evaluations. This is not a
cross-device, cross-version, CUDA/compiled-mode or production-quality guarantee.

`forge/nxtf.py::load_nxtf` preflights headers, version, tied weights, shapes, tensor
payload lengths and a configurable parameter budget before allocation. It rejects
trailing/truncated data and validates even with `python -O`. The NXTF2BIN layout,
tensor orientation and Go/Python model mathematics are unchanged.

## Verification

On the real checkout with the Go version required by `go.mod` and Python
NumPy/PyTorch/pytest installed:

```sh
go vet ./...
go test -count=1 -timeout 180s ./...
go test -race -count=1 -timeout 180s ./...
go build ./cmd/...
python -m pytest -q forge/test_audit_regressions.py forge/test_remediation.py
```

The external remediation bundle also supplies `verify.py`, which performs the
headless path/import check and runs these targeted checks (`--race` is optional).
That script does not rewrite go.mod, install dependencies, deploy or push.

The checked-in CI workflow is unchanged. Its disabled security scanners and lack
of a Python job remain follow-up infrastructure work. The documentation no longer
claims those jobs are already active. GPU/Windows runtime validation, crash
recovery of a full organism and production inference/load tests are not claimed
by this remediation's local results.
