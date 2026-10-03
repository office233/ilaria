# Worker 3 Round 2 — Ilaria TritPack20 codec and CPU reference MatVec

State: COMPLETE

## Workspace / branch

- ChatGPT Bridge MCP access verified for `E:\nexus`.
- Branch observed: `codex/nexus-supervisor-v3`.
- Existing dirty/untracked work is preserved. No branch/index/history operation, reset/clean, stage/commit, switch, push, deploy or publication will be performed.
- Read before edits: root `AGENTS.md`, `ilaria/AGENTS.md`, current coordination `README.md`, and `coordinator.md`.
- The prior Worker 3 v3 cache/report are handed off to Worker 5 and remain untouched.
- No corpus/checkpoint/weight/private/training-state files will be read; no Forge/model/trainer/tokenizer/training configuration will be modified.

## Exact claimed files

Worker 3-R2 exclusively claims only these new files until this report becomes `State: COMPLETE`:

- `ilaria/runtime/tritpack20/codec.go`
- `ilaria/runtime/tritpack20/codec_test.go`
- `ilaria/runtime/tritpack20/format.go`
- `ilaria/runtime/tritpack20/format_test.go`
- `ilaria/runtime/tritpack20/matvec.go`
- `ilaria/runtime/tritpack20/matvec_test.go`
- `ilaria/runtime/tritpack20/benchmark_test.go`
- `ilaria/runtime/tritpack20/README.md`
- `ilaria/docs/architecture/TRITPACK20_V1.md`
- `docs/coordination/chrome-2026-10-01/worker-3-r2.md`

No existing source file is claimed.

## API published early

Package: `ilaria/runtime/tritpack20`.

Stable public surface:

```go
const (
    Version       = 1
    TritsPerWord  = 20
)

type Limits struct {
    MaxInputDim      uint64
    MaxOutputDim     uint64
    MaxTrits         uint64
    MaxPayloadBytes  uint64
    MaxSnapshotBytes uint64
}

type Snapshot struct { /* immutable after construction */ }

func PackedBytes(tritCount uint64, limits Limits) (int, error)
func Pack(dst []byte, trits []int8) error
func ValidatePacked(payload []byte, tritCount uint64) error
func Unpack(dst []int8, payload []byte, tritCount uint64) error

func NewSnapshot(
    in, out uint64,
    weightScale float32,
    trits []int8,
    limits Limits,
) (*Snapshot, error)

func ParseSnapshot(encoded []byte, limits Limits) (*Snapshot, error)
func (s *Snapshot) MarshalBinary() []byte
func (s *Snapshot) In() int
func (s *Snapshot) Out() int
func (s *Snapshot) WeightScale() float32
func (s *Snapshot) PayloadBytes() int
func (s *Snapshot) Hash() [32]byte

func (s *Snapshot) MatVec(dst []float32, activations []int8, activationScale float32) error
```

Final contract and invariants:

- Encoding is versioned and deterministic: exactly 20 trits per little-endian `uint32`, no variable-width word representation.
- Trit mapping is canonical base-3: `-1 -> 0`, `0 -> 1`, `+1 -> 2`; trit index 0 is the least-significant base-3 digit. Unused digits in the final partial word are canonical zero digits and must decode to no additional trits.
- Payload size is exactly `4 * ceil(N/20)` bytes; any oversized/truncated/non-canonical word is rejected.
- Snapshot layout is exactly IMC projection `[in,out]`: logical weight `W[i,outIndex]` is trit index `i*out + outIndex`.
- Canonical IMC source uses one abs-mean ternary weight scale per projection tensor; the snapshot stores that explicit positive finite FP32 `weightScale`. Activation input is `int8` plus one positive finite dequantization scale supplied per MatVec call (the per-token counterpart of the existing IMC activation quantizer).
- Snapshot binary format carries dimensions, layout/version, the exact weight-scale bits, packed payload length, and SHA-256 over the canonical unhashed body. Parse validates all of them before allocating/copying.
- Limits are explicit and checked with overflow-safe arithmetic before allocations.
- `Snapshot` owns one canonical encoded buffer plus parsed scalar metadata and exposes no mutable backing storage.
- `MatVec` writes into caller-preallocated `dst`, decodes packed words on the fly without materializing the matrix, accumulates integer dot products in `int64`, and must allocate zero bytes per call after snapshot initialization.
- No file access, model loading, checkpoint/weight authority, OS authority, inference orchestration, distributed/P2P behavior or alternate model family is introduced.

## Implementation delivered

1. Confirmed the canonical declaration in `specs/myriad.swyp`, the packed-projection deployment requirement in `docs/plans/MASTER_PLAN.md`, and `x @ w` / `[in,out]` / abs-mean-weight-scale / per-token-int8 semantics in the targeted public IMC source. No native TritPack20 implementation existed in `runtime/`.
2. Implemented a fixed 88-byte v1 header plus exact packed payload, strict SHA-256 integrity, immutable owned snapshots, mandatory explicit limits, overflow checks before snapshot allocation, and canonical padding validation.
3. Implemented the scalar CPU MatVec with direct packed-word decoding, exact int64 accumulation, preallocated output, no expanded matrix and no mutable scratch state.
4. Added synthetic golden endian vectors, 1/19/20/21 round trips, nonsquare matrices, corruption/version/hash/scale/overflow/bounds tests, independent scalar parity, zero-allocation assertions, benchmarks, package README and the byte-level architecture contract.

## Checks

Focused final gate from `E:\\nexus\\ilaria`:

- `go fmt ./runtime/tritpack20` — PASS.
- `go vet ./runtime/tritpack20` — PASS.
- `go test -count=1 -timeout 120s ./runtime/tritpack20` — PASS: `ok ilaria/runtime/tritpack20 0.282s`.
- The suite includes `testing.AllocsPerRun(1000, ...)` and requires exactly zero allocations for valid MatVec calls.

Final synthetic benchmark, Windows/amd64 on AMD EPYC 7763, 50 iterations each:

- `BenchmarkPack1MiTrits-8`: 1,201,634 ns/op, 174.53 MB/s, 0 B/op, 0 allocs/op.
- `BenchmarkMatVec768x768-8`: 2,871,794 ns/op, 41.08 MB/s, 0 B/op, 0 allocs/op.
- `BenchmarkParseSnapshot768x768-8`: 129,072 ns/op, 914.65 MB/s, 122,994 B/op, 3 allocs/op. Parse allocations are initialization-time immutable ownership/hash work, not MatVec hot-path allocations.

Full Ilaria Go gate used process-local `GOCACHE`/`GOTMPDIR` under the worker temp directory:

- `go vet ./...` — PASS.
- `go test -count=1 -timeout 180s ./...` — PASS; Bridge summary: 11 packages OK, 0 failed; `runtime/tritpack20` passed in 0.570s in the final run.

Canonical Python architecture gate used `PYTHONPYCACHEPREFIX` in worker temp, `PYTHONDONTWRITEBYTECODE=1`, and pytest cache disabled:

- `python -m py_compile forge\\imc_model.py forge\\train_ilaria.py forge\\training_state.py` — PASS.
- `python -m pytest -q -p no:cacheprovider forge\\test_imc_model.py` — PASS: 47 passed in 110.37s. No Forge source was modified.

Linux/race capability probe:

- Windows Go reports `GOOS=windows`, `GOARCH=amd64`, `CGO_ENABLED=0`.
- WSL `command -v go` returned no Go toolchain. Therefore Linux `go test -race` was unavailable without installing a toolchain, which was prohibited and not attempted.
- Pure-Go `linux/amd64` cross-compile with `CGO_ENABLED=0` using `go test -c` into worker temp — PASS; temporary binary removed. This is a compile check, not a claimed race result.

Diff/ownership gate:

- `git diff --check` — exit 0. Only pre-existing CRLF/LF warnings for unrelated SwypikOS docs were printed.
- Scoped status is exactly `?? docs/coordination/chrome-2026-10-01/worker-3-r2.md`, `?? ilaria/docs/architecture/TRITPACK20_V1.md`, and `?? ilaria/runtime/tritpack20/`.
- No file was staged or committed.

No energy measurement was performed or inferred.

## Handoff

Released contract: use explicit host limits; obtain ternary projection trits and the existing projection's abs-mean weight scale from a separately verified checkpoint/conversion path; pass per-token int8 activations with the matching explicit dequantization scale; treat TritPack20 SHA-256 as content integrity only, not checkpoint authentication/provenance.

Remaining limits: this is a codec, immutable projection snapshot and scalar CPU reference kernel only. It does not load/convert production checkpoints, implement complete IMC inference, SIMD/GPU/NPU kernels, prove inference quality, prove sub-1GB full-model residency, measure energy, establish universal hardware support, or add P2P/distributed behavior. FP32 v1 uses one projection-wide weight scale matching the current canonical IMC semantics; any future scale granularity requires an explicitly new format/version rather than silent reinterpretation.

The handed-off files above are released to the coordinator/integrator. Worker 3-R2 stops editing them when this report changes to COMPLETE.
