# Worker 3 — SwypikOS immutable attested plan snapshot cache

State: COMPLETE

## Workspace / branch

- MCP access verified for `E:\\nexus`.
- Branch observed at start: `codex/nexus-supervisor-v3`.
- Existing dirty/untracked work was preserved. No branch/index/history change, reset/clean, stage/commit, push, deploy or publication was performed.
- Read before edits: root `AGENTS.md`, `swypik-os/AGENTS.md`, `docs/milestones/supervisor-v2.md`, coordination README, and active Worker 1/2 reports. Worker 4/5 reports were read again before handoff.
- Product boundary preserved: only a host-owned SwypikOS cache library plus this report were written. No Swyp, Ilaria, supervisor/CLI/process-group/resource/shared integration file was modified.

## Exact handed-off files

Worker 3 created only these files:

- `swypik-os/internal/plancache/identity.go`
- `swypik-os/internal/plancache/verify.go`
- `swypik-os/internal/plancache/cache.go`
- `swypik-os/internal/plancache/lock_windows.go`
- `swypik-os/internal/plancache/lock_unix.go`
- `swypik-os/internal/plancache/cache_test.go`
- `swypik-os/internal/plancache/benchmark_test.go`
- `docs/coordination/chrome-2026-10-01/worker-3.md`

These files are now released to Worker 5. Worker 3 stops editing them at this state transition.

## Stable public library API for Worker 5

Package: `swypik-os/internal/plancache`.

### Configuration

```go
type Config struct {
    Root                string
    Partition           string
    StoragePolicy       string
    MaxEntries          int
    MaxBytes            int64
    MaxIRBytes          int64
    MaxProvenanceBytes  int64
    MaxAttestationBytes int64
    MaxMetadataBytes    int64
}

type Stats struct {
    Entries int
    Bytes   int64
}

func Open(Config) (*Cache, error)
func (c *Cache) Close() error
func (c *Cache) Stats(context.Context) (Stats, error)
```

Configuration is explicit. `Root` must be absolute and must resolve without symlink/reparse indirection. `Partition` is a validated single path component. On first open the partition persists an immutable `.partition.json` containing `StoragePolicy` and every quota; later producers must present the exact same policy or `Open` returns `ErrPolicyMismatch`. This prevents concurrent producers from enforcing different disk limits in the same partition.

### Complete compilation identity

```go
type Input struct {
    Name    string
    Content []byte
}

type IdentityInput struct {
    Source       []byte
    Dependencies []Input
    Compiler     []byte
    Protocol     []byte
    Policy       []byte
}

type NamedHash struct {
    Name   string
    SHA256 string
}

type Identity struct {
    Version          int
    Key              string
    SourceHash       string
    DependencyHashes []NamedHash
    CompilerHash     string
    ProtocolHash     string
    PolicyHash       string
}

func Identify(IdentityInput) (Identity, error)
```

`Identify` hashes the exact source bytes, every dependency logical name + exact content bytes, opaque canonical compiler identity bytes, protocol identity bytes and relevant policy bytes. Dependency input order is normalized by name; duplicate names are rejected. Path and mtime are not identity inputs. The final key is a domain-separated SHA-256 over a length-delimited canonical digest representation.

Worker 5 must populate `Compiler`, `Protocol` and `Policy` with complete canonical host identities; the cache does not invent or infer them.

### Snapshot + explicit trust boundary

```go
type Snapshot struct {
    CanonicalIR []byte
    Provenance  []byte
    Attestation []byte
}

type Claim struct {
    Identity        Identity
    StoragePolicy   string
    CanonicalIRHash string
    IRBytes         int64
    Provenance      []byte
    Attestation     []byte
}

type Verifier interface {
    VerifySnapshot(context.Context, Claim) error
}

type VerifierFunc func(context.Context, Claim) error

func (c *Cache) Get(context.Context, Identity, Verifier) (Snapshot, error)
func (c *Cache) Put(context.Context, Identity, Snapshot, Verifier) error
func (c *Cache) Remove(context.Context, Identity) error
```

`Put` verifies configured size limits before cache allocations/publication, computes SHA-256 over the exact canonical-IR bytes, then requires the caller-supplied host `Verifier` before touching cache data. Every successful `Get` re-reads bounded files, recomputes IR/provenance/attestation digests, then requires a fresh host verifier decision before returning bytes.

The package deliberately treats Core IR as opaque to preserve the product boundary. The host verifier must establish that `CanonicalIRHash` is the digest of canonical, verified Core IR and validate the supplied provenance/attestation. There is no ambient authority and no production/default key in this package.

Exported sentinel errors are `ErrMiss`, `ErrCorrupt`, `ErrUntrusted`, `ErrConflict`, `ErrQuota`, `ErrLimit`, `ErrUnsafePath`, `ErrPolicyMismatch`, and `ErrClosed`.

## On-disk / concurrency contract

- All filesystem operations below the configured root use Go 1.26 `os.Root`, so relative traversal and symlink escapes cannot leave the configured root.
- Root symlink/reparse indirection is rejected before `os.OpenRoot`; partition, entry and entry-file symlinks are rejected with `Lstat` checks.
- Windows producers serialize through `LockFileEx`; non-Windows producers use `flock`. Lock retries happen only while an API call is active and obey its context. No background goroutine, ticker or idle poller exists.
- A producer writes a fresh random `.tmp-*` directory, writes and file-syncs IR/provenance/attestation/metadata, syncs the temporary directory on Unix, then exposes the complete immutable entry with one same-root atomic directory rename.
- Abandoned `.tmp-*` / `.cfg-*` publications are removed only while holding the cross-process lock, including on `Open`, so a crashed producer cannot expose a partial final entry.
- Published entry directories are never mutated by the cache. Re-publishing the same identity succeeds only for byte-identical IR/provenance/attestation; a different snapshot returns `ErrConflict`.
- Corrupt/truncated target entries fail closed. `Get` removes the corrupt target while locked and returns `ErrCorrupt`; it never treats cached bytes as trusted output.
- Payload and metadata file sizes are checked against configured bounds before allocating read buffers. Metadata has an additional 16 MiB hard ceiling.
- Quota accounting uses actual logical file lengths of the four published entry files (metadata + IR + provenance + attestation), not caller metadata. Temporary publication is capacity-reserved before writes.
- `MaxEntries` and `MaxBytes` are enforced under the same cross-process lock as publication.
- Eviction is deterministic **oldest-publication first**, using `PublishedUnixNS` then key as a tie-break. Successful reads do not mutate access state. This intentionally replaces the earlier RUNNING-report wording that said “oldest-access-record”; Worker 5's coordination note correctly identified that mismatch.
- Scans use bounded `ReadDir(64)` batches and retain only aggregate counters plus one oldest candidate; the cache never retains an in-memory index of all entries.

## Tests implemented

`cache_test.go` covers:

- miss/hit and mandatory fresh host verification;
- cache-level invalidation misses for source, dependency content, compiler identity, protocol identity and policy identity;
- dependency-order canonicalization and duplicate dependency rejection;
- immutable conflicting producer output;
- IR truncation/tamper detection and corrupt-entry purge;
- rewritten attestation + matching rewritten cache metadata still rejected by the independent host verifier;
- concurrent producers through multiple cache instances;
- four separate OS processes racing to publish the same immutable entry;
- abandoned crash-publication cleanup;
- deterministic count-quota eviction;
- byte-quota eviction and post-publication bound;
- oversize refusal before verifier invocation;
- persisted partition-policy mismatch refusal;
- symlink root and symlink partition rejection on the actual Windows host.

The verifier used by tests is synthetic HMAC with a clearly named public fixture key in `cache_test.go`; production code contains no key.

## Actual verification results

### Focused package gate

Command:

```powershell
go vet ./internal/plancache
go test -count=1 -timeout 120s ./internal/plancache
```

Result: PASS. Final focused test run:

```text
ok  swypik-os/internal/plancache  1.384s
```

A separate explicit Windows symlink gate also passed both subtests:

```text
TestSymlinkRootAndPartitionRejected/root      PASS
TestSymlinkRootAndPartitionRejected/partition PASS
ok  swypik-os/internal/plancache  0.372s
```

Linux build compatibility was checked without generating repository artifacts:

```powershell
$env:GOOS='linux'
$env:GOARCH='amd64'
$env:CGO_ENABLED='0'
go test -c -o "$env:TEMP\plancache-linux.test" ./internal/plancache
```

Result: PASS; temporary test binary was removed immediately.

### Race coverage availability

Windows Go reports `CGO_ENABLED=0`, so `go test -race` refused with:

```text
go: -race requires cgo; enable cgo by setting CGO_ENABLED=1
```

WSL2 was checked as an alternative, but `go` is not installed there (`bash: go: command not found`). No compiler/toolchain was installed or permissions changed solely to force a race run. Cross-process concurrency is nevertheless exercised by the normal package tests above.

### Synthetic local benchmark

Command:

```powershell
go test -run '^$' -bench 'BenchmarkCache(GetHit64KiB|Publish64KiB)$' -benchtime=25x -benchmem ./internal/plancache
```

Measured host: Windows/amd64, AMD EPYC 7763 64-Core Processor, benchmark process reports `-8`.

Result: PASS.

```text
BenchmarkCacheGetHit64KiB-8          25    1,973,000 ns/op     97,408 B/op   362 allocs/op
BenchmarkCachePublish64KiB-8         25   22,526,348 ns/op     17,264 B/op   257 allocs/op
PASS
ok  swypik-os/internal/plancache  1.355s
```

These are synthetic local fixture measurements only; no universal performance claim is made.

### SwypikOS product gate

Command attempted from `swypik-os`:

```powershell
go vet ./...
go test -count=1 -timeout 180s ./...
```

`go vet ./...` passed (the command proceeded into tests). The full test gate currently fails in Worker 2's active `core/supervisor` area with `invalid explicit authenticated continuation policy`, including:

- `TestAuthenticatedContinuationCrashSuspendResumeDoesNotReplayResolvedEffect`
- `TestAuthenticatedContinuationRejectsMismatchBudgetAndMissingResult`
- `TestAuthenticatedContinuationRejectsTamperRollbackAndFenceMismatch`
- `TestAuthenticatedContinuationPolicyChangeAndMissingRecordFailClosed`

Job summary: **50 packages OK, 1 failed**. In that same full run:

```text
ok  swypik-os/internal/plancache  2.638s
FAIL swypik-os/core/supervisor
```

Those supervisor files are exclusively claimed by Worker 2 and remained untouched.

### Diff gate / ownership

Command:

```powershell
git diff --check
git status --short -- docs/coordination/chrome-2026-10-01/worker-3.md swypik-os/internal/plancache
```

Result: `git diff --check` exit 0. Git printed only existing CRLF/LF conversion warnings for unrelated SwypikOS documentation. Worker 3 status is exactly:

```text
?? docs/coordination/chrome-2026-10-01/worker-3.md
?? swypik-os/internal/plancache/
```

No file was staged or committed.

## Remaining limits / integration requirements

1. Worker 5 must supply complete compiler/protocol/policy identity bytes. The package cannot safely infer these from executable path, path metadata or mtime.
2. Worker 5 must supply the host `Verifier` which validates canonical Core-IR provenance/attestation. Cache presence and cache metadata are never authority.
3. `MaxBytes` is a logical published-file byte quota, not filesystem block-allocation accounting; directory entries, the tiny lock/partition manifest and filesystem allocation overhead are not counted.
4. Windows file contents are flushed before atomic rename, but Windows has no equivalent directory-fsync primitive used here. A sudden power loss may therefore lose a just-published rename as a cache miss; partial/unverified data is never intentionally returned as a hit.
5. `os.Root` prevents path/symlink escape but is not a general hostile-filesystem sandbox for Unix bind mounts/device files. The configured cache root/partition remains host-owned storage.
6. Partition policy is immutable by design. To change quota/storage policy, Worker 5 should select a new explicit partition/version or perform an explicit host-controlled migration; concurrent producers must not silently disagree.
7. Local race instrumentation was unavailable for the reasons recorded above; no race-safety claim is based on an unrun race detector.

## Worker 5 handoff

Worker 5 may now take over these released files for supervisor-v3 integration. The intended integration sequence is:

1. Build `IdentityInput` from exact source/dependency contents plus complete compiler/protocol/policy identities.
2. Call `Identify`.
3. On `Get`, treat `ErrMiss`/safe corruption as a compile path, never as authority.
4. Supply a host-owned `Verifier` on both `Get` and `Put`.
5. Store only the verified canonical Core IR snapshot plus bounded provenance/attestation.
6. Keep the explicit partition/version stable for all concurrent producers sharing a root.

Worker 3 is COMPLETE and will not edit the handed-off files further.
