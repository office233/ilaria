# Broker effects v1

This milestone connects an actual Swyp program to read-only SwypikOS effects
and signed execution evidence verified by Ilaria. It needs no running model,
network service, privileged driver or Python ML dependency.

## Product responsibilities

- **Swyp** compiles source into validated Core IR and runs the existing safe
  interpreter with an explicit handler. It emits logical `clock_read` or
  `workspace_read` requirements. It never receives a host grant or credential.
- **SwypikOS** resolves host-owned exact grants, authenticates the executor
  against a live Control Kernel lease, confines reads using directory handles,
  journals the intent and signs its observed outcome.
- **Ilaria** verifies the signed outcome against an explicitly configured,
  executor-bound public-key registry and independent expected execution context.
  It returns an observation with `training_eligible=false` and no file payload.

```text
Swyp source -> validated Core IR -> safe interpreter
                                      |
                        EffectRequest JSONL (no authority)
                                      |
                 SwypikOS exact grant + authenticated lease
                                      |
                  PREPARED -> STARTED -> bounded provider
                                      |
                         durable RESULT + signed receipt
                                      |
                 Ilaria signature/hash/expected-epoch checks
                                      |
                      local execution evidence observation
```

There is one interpreter and one Control Kernel. Public DTOs in each product
are generated from [the shared Swyp schema](../../swyp/specs/effects.swyp).
Each Go module remains independently buildable with `GOWORK=off`.

## Run the integration gate

From the repository root:

```powershell
./scripts/verify-effects.ps1
# Explicit tool paths are supported:
./scripts/verify-effects.ps1 -GoCommand <go-path> -PythonCommand <python-path>
```

The gate builds the three CLIs in a unique temporary directory. It runs a Swyp
program that reads a fixture file and the real clock, checks the returned file
contents, and independently compares the program's module hash with emitted
Core IR. Both receipts are verified by the Ilaria CLI. All fixtures, grants,
configuration, keys and journals are temporary. The Ed25519 fixture is a
publicly known RFC 8032 test vector; it provides no production identity.

The same gate also exercises:

- Reopening the broker's journal and refusing to replay an observed intent.
- Refusing a changed request under an existing exact grant.
- Rejecting modified payloads, signatures and lease fences.
- Rejecting unknown, revoked or incorrectly executor-bound trusted keys.
- Enforcing a file read budget and stopping the guest on provider failure.
- Rejecting a result for another request and stopping on an unanswered deadline.
- Refusing effects in the ordinary pure runtime and rejecting unsupported
  effects before the broker runtime emits any request.

`verify-workspace.ps1` includes this gate when all three products are selected.
`-SkipEffects` explicitly omits it. CI runs the integration on Windows and Linux
alongside product tests, race detection and generated-contract drift checks.

## Interfaces

### Swyp

```text
swyp core-broker --run-id RUN_ID [--entry main] [--steps 100000]
     [--max-bytes 1048576] [--timeout 5s] source.swyp [typed entry arguments]
```

Stdout emits one `EffectRequest` per effect; stdin supplies one correlated
`EffectResult`. The final stdout frame has `type="completion"`, the module
hash, status, typed result and steps, or a diagnostic. Returned bytes are
base64. Only one request is outstanding at a time. Failed, denied, uncertain
and blocked outcomes stop execution without retries.

Requests use `RUN_ID:SEQUENCE` identities. The caller chooses a distinct run
identity for distinct logical work and retains the same identity when checking
already-issued work. Reusing an identity cannot silently replay an observed
intent. `RunWithEffects` exposes the same handler boundary to Go callers;
`Run`, fast/turbo execution and verification retain their pure boundary.

The interpreter keeps fuel, calls, traps, cancellation and storage semantics.
Returned file bytes enter a bounded arena owned by the individual run, and
cannot mutate a prepared executable shared by other runs. Handler code must
respect the supplied context. Unsupported declared effects and ambiguous
instruction capability bindings fail before execution.

### SwypikOS

```text
effect-broker --config ABSOLUTE_HOST_CONFIG.json
```

The host config contains `journal`, `executor_id`, `executor_credential`,
`signer_key_id`, `signer_private_key` (base64 Ed25519 private key), `roots`
(alias to absolute directory), and `grants`. Every grant specifies:

```text
grant_id, request_hash, request_id, effect, capability,
task_id, node_id, root_id, max_bytes, expires_at_unix_ms
```

These are trusted control-plane inputs. The JSONL guest cannot supply them.
`request_hash` pins every request field, including module hash, function,
effect, requirement and relative file path. The broker binds the grant to the
authenticated task/node/attempt/executor/lease/fence epoch. File reads use a
configured `os.Root` handle, regular files only, relative resource names and
explicit byte/deadline limits. Symlink escape is refused by the handle-based
API. File contents can still change while being read; the receipt attests to
the bytes actually returned, rather than a filesystem snapshot.

Positive node/task read-byte ceilings additionally restrict each operation.
Task-wide aggregate resource accounting and process-level CPU/memory enforcement
remain work for the supervisor/sandbox; this read-only broker is not that sandbox.

Output is an envelope with `request`, `result`, `receipt` and `expected`.
`expected` is obtained from the host grant and lease, independently of the
receipt. One effect node is prepared per grant because Control Kernel intents
must be prepared before its node enters `EXECUTING`.

The broker persists `PREPARED` and `STARTED` before invoking a provider, and
`RESULT` before returning successful evidence. Already started, observed or
uncertain work requires reconciliation and is never blindly executed again.
Cancellation or lease loss after an effect started returns uncertainty and
withholds contents. The broker intentionally leaves independent verification
and `COMMITTED` transitions to the existing control plane.

### Ilaria

```text
evidence-check --request request.json --result result.json
               --receipt receipt.json --expected expected.json --keys keys.json
```

The key registry has `format="ilaria-effect-trust-registry-v1"` and a `keys`
object keyed by signer identity. Each entry contains `executor_id`, base64
`public_key`, and `revoked`. The receipt cannot nominate a trusted public key.
The verifier copies caller configuration; key rotation/revocation is applied
by constructing a new verifier from updated trusted configuration.

The independently supplied expected execution specifies `task_id`, `node_id`,
`attempt_id`, `executor_id`, `grant_id`, `lease_id`, and `fence`; it may also pin
`intent_id`. A consumer must obtain this context from its trusted control plane,
rather than copying it from a receipt. The integration fixture uses the broker's
host-originated expected context and separately configured public-key registry.

The verifier accepts only successful terminal execution evidence, with matching
request/result hashes, effect and requirement, expected identity/epoch, signature
and `local_private` privacy class. This attests to a configured executor's
observation; it does not prove application correctness or authorize training.

## Wire rules

Version 1 supports only `fs.read` and `clock.read`. The generated DTO schema
defines the exact field order. Every field is present, including empty strings.
Unknown, duplicate or case-folded field aliases and trailing JSON are rejected.
UTF-8 and escaped Unicode must decode without replacement, and byte values use
canonical padded base64.

- Request/result/receipt `protocol_version` is `1`.
- Request IDs are bounded ASCII identifiers; module/hash values are lowercase
  SHA-256 hex. Function and capability names follow the semantic identifier rules.
- `fs.read` returns `value_type="bytes"`; `clock.read` returns
  `value_type="i64"` with canonical nonnegative decimal Unix milliseconds in
  `value`. Core IR retains its existing `u64` clock type.
- Statuses are `succeeded`, `denied`, `failed`, `uncertain`, or `blocked`.
  Success has an empty error code. Other outcomes have no contents and an error.
  A successful empty file is an empty base64 string, rather than `null`.
- A message is limited to 2 MiB, a decoded result to 1 MiB and a path to 4096
  UTF-8 bytes. Host grants and interpreter cumulative response budgets may be
  smaller.
- Request and result hashes are SHA-256 over `encoding/json.Marshal` of the
  respective generated DTO, with no added whitespace. The result hash includes
  status, type and error, not just payload. Canonical JSON escapes `<`, `>` and
  `&`, and U+2028/U+2029 as Go's encoder does.
- The Ed25519 signature covers `nexus.effect.receipt.v1\n` followed by canonical
  JSON of the entire receipt with `signature=null`. It binds all hashes,
  execution IDs, fence, intent, outcome, timestamp, privacy and signer identity.

Cross-product golden hashes and actual CLI signature verification exercise the
canonical representation. `verify-contracts.ps1` regenerates all three DTO
copies from one `.swyp` source and rejects drift.

## Validation record (2026-09-30)

- The complete CLI integration and refusal cases passed with independent
  native Windows and Linux builds. Contract regeneration and CI lint passed.
- The combined `verify-workspace.ps1 -SkipForge` run passed on the final source:
  all three Go vet/test/build gates, four contracts, the effects integration and
  `git diff --check`. Forge/model and native kernel code were unchanged in this
  milestone; their separate audit gates were not repeated by this combined run.
- Full Windows Go vet/tests/build gates passed for all three products. Swyp
  also passed on its Go 1.21 minimum: 711 top-level tests, 37 platform/tool skips.
- Ilaria passed its complete Linux race gate; Swyp passed all 14 packages under
  race detection, with the CLI package retried after a legacy child-build test
  encountered local WSL I/O contention. SwypikOS passed Linux race/vet checks
  for the affected effects, Control Kernel and broker CLI packages.
- Ilaria's new verifier/CLI tests include 20 top-level cases and 126 subtests;
  measured statement coverage was 90.1% for the verifier and 82.4% for the CLI.
- Independent cross-review checked canonical hashes, signatures, scope/epoch
  validation and owned arenas. It also hardened the integration harness against
  disabled Python assertions and crash exits masquerading as expected refusals.

These gates establish the implemented development behavior. Task correctness,
model quality, independent commit/reconciliation and production supervision
remain separate milestones below.

## Next construction steps

1. Add a host supervisor that compiles/preflights a complete plan, issues exact
   grants before execution, transports multiple effect nodes, and routes signed
   evidence to independent verification and commit/reconciliation.
2. Add managed executor identities, secure signing-key storage, key rotation and
   control-plane context delivery. The present explicit local CLI configuration
   is suitable for controlled development and integration tests.
3. Bind semantic contracts and frozen task evaluations to the observed outcomes.
   Report completion, accuracy, latency, resource cost and recovery behavior
   against reproducible baselines before making quality or superiority claims.
4. Connect Ilaria proposals through this same authority boundary and separately
   implement authenticated provenance/admission rules before converting execution
   observations into memory or training examples.
5. Extend effects only with separate scope policies and meaningful tests for
   write, network, process and device authority. This milestone grants none of
   those operations.
