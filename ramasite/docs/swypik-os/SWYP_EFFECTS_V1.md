# Swyp effect broker v1

SwypikOS executes explicit `clock.read` and `fs.read` requests through
`core/effects`. Swyp emits requests; it does not choose host authority. Ilaria
can verify a receipt against independently supplied public keys and execution
bindings. A verified receipt is execution evidence, not a Control Kernel
verification verdict or permission to commit a task.

The shared wire contract is `../swyp/specs/effects.swyp` and the generated
OS DTOs are `generated/swypeffects/types_gen.go`. Canonical JSON and signing
rules are owned by the shared specification and workspace protocol documentation.

## Go API

`effects.OpenReader(map[alias]absoluteHostDirectory)` opens trusted read roots.
`effects.NewBroker(effects.Config{Kernel, Reader, SignerKeyID, PrivateKey,
Grants, Now})` constructs a broker with immutable host policy. `Now` is optional
and supports deterministic tests. `Execute(ctx, executorCredential, request)`
returns an `EffectResult`, signed `EffectReceipt`, and a transport/configuration
error. Invalid wire requests return an error. Valid denied, failed, uncertain
and blocked requests return signed outcomes. `ExpectedBinding(requestID)`
returns context from the configured grant, independently of receipt contents.

A `Grant` binds the full canonical request hash, request ID, grant ID,
task/node/attempt/executor identity, lease ID and fence, expiry, and filesystem
root alias/byte limit. A grant for one path, capability, module or function
cannot authorize a different request. Grants are trusted host policy; guest
JSON contains no grants, credentials, host paths or signing keys. The Control
Kernel remains the authority for authenticated executor identities, durable
leases, attempts, fencing and intent state.

The effective per-read limit is the smallest of the grant limit, protocol
ceiling and each positive task/node `Budget.MaxReadBytes`. A zero optional
kernel budget adds no bound; negative read budgets fail closed. Changing a
restart configuration cannot widen an existing node's persisted read budget.
Aggregate accounting across several nodes is not implemented by this slice.

## Local JSONL adapter

Build and run from the product root:

```powershell
$env:GOWORK = 'off'
go build -o .\bin\effect-broker.exe ./cmd/effect-broker
.\bin\effect-broker.exe --config C:\private\host-config.json
```

The adapter reads one complete request JSON object per stdin line and writes
one JSON envelope per stdout line: `request`, `result`, `receipt`, `expected`.
The host must obtain `expected` independently from its configuration and
Control Kernel state before trusting a receipt; a guest-provided envelope is
not an authority source. Configure public keys separately on the Ilaria
consumer; a receipt never supplies its own trusted key.

The explicit host configuration has this shape (placeholders are not valid
signing material):

```json
{
  "journal": "C:\\private\\effects.journal",
  "executor_id": "local-worker",
  "executor_credential": "<host-provisioned credential>",
  "signer_key_id": "local-host-key",
  "signer_private_key": "<base64 of a provisioned 64-byte Ed25519 private key>",
  "roots": {"fixture": "C:\\private\\approved-data"},
  "grants": [{
    "grant_id": "read-grant-1",
    "request_hash": "<SHA-256 of the exact canonical request JSON>",
    "request_id": "read:1",
    "effect": "fs.read",
    "capability": "workspace_read",
    "task_id": "effect-task-1",
    "node_id": "effect-node-1",
    "root_id": "fixture",
    "max_bytes": 4096,
    "expires_at_unix_ms": 1790773200000
  }]
}
```

The example expiry must be replaced by an explicit future deadline. Root and
journal paths must be absolute. Protect the host configuration as private key
material; do not commit it or supply it from untrusted input. No default
credential, signing key, grant, filesystem root or process/network authority
is created. Invalid configuration is rejected before journal creation.

One effect uses one configured node. The CLI creates missing task/node
topology before freezing it and claims an authenticated lease until the
configured expiry. Restart reuses an existing execution epoch, including an
expired or observed one, and never mints an automatic retry. New grants need
distinct request IDs, grant IDs and nodes. Existing broker tasks and effect
kinds must match the host configuration.

## Execution and recovery

The Control Kernel fsyncs `PREPARED`, then `STARTED`, before any provider call.
The broker validates credentials, exact policy, deadline and lease/fence before
preparation, again before start, immediately before the provider, and after
the provider returns. A durable `RESULT` binds the complete result hash,
including status, value type, bytes and error code.

Successful and known failed reads leave the intent in `RESULT`; independent
verification and commit are deliberately separate Control Kernel operations.
The adapter does not turn its own receipt into a verification verdict.
Cancellation, lost authority or a non-durable result after `STARTED` returns
`uncertain`, publishes no file contents and attempts Control Kernel uncertainty
recovery. If storage itself fails, the durable journal must be reopened and
reconciled; an uncertain receipt does not assert that this recovery succeeded.

`STARTED`, `RESULT`, `UNCERTAIN`, `RECONCILING` and committed intents block
automatic replay. A still-`PREPARED` intent can proceed only under the current
authorized Control Kernel epoch. A restart cannot retrieve old file contents
from the journal: the journal stores result hashes rather than private values.

## Bounds and limits

Messages are at most 2 MiB, values at most 1 MiB, relative file paths at most
4096 UTF-8 bytes. Parsing rejects duplicate/unknown/case-alias fields, omitted
protocol fields, null scalar/byte fields, malformed UTF-8 or unpaired Unicode
surrogates, trailing JSON values and excessive nesting.

`fs.read` accepts clean relative paths inside configured aliases. `os.Root`
provides confinement during path changes and rejects symlinks escaping a root.
Only regular files are accepted; oversize reads publish no partial contents.
Linux opens nonblocking so a FIFO cannot hang before type validation. Windows
and Linux are the supported providers. A trusted root should contain ordinary
local data: this namespace boundary does not isolate bind mounts, hard links
or pseudo-filesystems, and a blocking filesystem syscall is not forcibly
terminated by a Go context. The deadline is checked again before publication.
This is a local read-only vertical slice, not a general sandbox or remote
authority service.

Receipts use Ed25519 with the domain `nexus.effect.receipt.v1\n` and bind all
semantic fields, signer key ID and independent execution context. Their
privacy class is `local_private`. Downstream consumers must enforce their own
expected epoch and key registry; a valid signature alone grants no capability.

## Validation

The OS tests exercise request/identity/grant/fence/expiry rejection, cancellation
before and after start, durable result and restart blocking, deadline loss
before provider invocation, bounded failure evidence, clock isolation,
strict JSON and canonical golden hashes, root traversal/symlink rejection,
Linux FIFO handling, and the multi-node JSONL adapter. The workspace integration
tests additionally invoke Swyp, this CLI and the Ilaria consumer as separate
processes. Run the required product vet/test gate and the workspace verifier.
