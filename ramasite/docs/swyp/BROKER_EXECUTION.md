# Brokered Core execution v1

`core-broker` executes the existing safe Core interpreter with an explicit
JSONL handler. Swyp does not open a guest-requested file, read a clock, or resolve
a grant. SwypikOS supplies the host broker. A running model is optional.

```powershell
.\bin\swyp.exe core-broker --run-id task_42 --entry now --steps 10000 --timeout 5s --max-bytes 262144 examples/swyp/broker-effects.swyp
```

A supervisor can compile once and pin the resulting Core IR before authorizing
an execution:

```powershell
.\bin\swyp.exe core-preflight --entry now -o task_42.core.json examples/swyp/broker-effects.swyp
.\bin\swyp.exe core-broker --ir --run-id task_42 --entry now task_42.core.json
```

`core-preflight` emits the generated `EffectPlan` DTO:

```json
{"protocol_version":1,"module_hash":"...","entry":"now","effects":["clock.read"],"capability_bindings":{"now/clock.read":"clock_read"}}
```

It validates the same supported effects and instruction-local capability
bindings as `RunWithEffects`, without executing guest instructions or invoking
a handler. Parameters need no values for preflight. Pure plans encode `effects`
as `[]` and `capability_bindings` as `{}`. The effect set is the entry's transitive
declaration; bindings list actual effect instructions in reachable functions.
`Executable.PreflightEffects` exposes that same detached result to embeddings.
The generated DTO is validated by `protocol/effects.ValidatePlan` before any
snapshot publication. `DecodePlan` applies the strict envelope and nested-map
rules on the host: ASCII entry/function identifiers of at most 64 bytes, lowercase
capability names, sorted unique supported effects, at most 128 bindings, and
non-null collections. A conservative effect declaration can have no actual
instruction binding. Duplicate keys, including escaped aliases, are rejected.
Direct `core-broker` invocations validate the same plan before executing, so an
unrepresentable reachable effect binding cannot fail after an earlier request.

The optional `-o` destination must not exist. It contains exact compact canonical
Core IR JSON with no trailing newline, so its file SHA-256 equals `module_hash`.
Canonical snapshots exceeding the Core decoder's 1 MiB ceiling fail before
publication. `core-broker --ir` reads the bounded snapshot through the strict
Core decoder, prepares an owned module, and hashes canonical JSON again. It
does not parse or reopen the original source. Source replacement or deletion
after preflight therefore cannot change this execution.

The supervisor owns the private snapshot location and must protect it from
untrusted writes. It must match request/completion module hashes against the
plan and match every `FUNCTION/EFFECT` binding before granting an effect. A plan
describes requirements and grants no authority. Snapshot consumption avoids
repeated source compilation while keeping the existing interpreter and its
budgets. It does not provide a second VM or an authorization cache.

The host starts the command, reads stdout, authorizes each request, and writes
one result line to stdin. The command uses the safe profile; `--profile` is not
accepted. Input is the explicit source file or `--ir` snapshot, followed by typed entry
arguments. The source's selected entry and call graph produce canonical Core IR,
whose SHA-256 is attached as `module_hash` on every request. Source locations are
part of this IR snapshot and therefore part of the hash.

Requests are the exact `EffectRequest` DTO from `specs/effects.swyp`, with IDs
`RUN:1`, `RUN:2`, and so on. A host must use a fresh run ID for a new logical
execution and bind grants to the actual module and task. Recovery of that same
logical execution preserves its run and request identities so the broker can
apply idempotency checks. Swyp does not manage or trigger retries. IDs are ASCII and reserve
suffix space under the instruction limit; an overlong prefix fails before any
effect. The guest sends a logical capability requirement such as `clock_read`
or `workspace_read`, never an opaque token.

Only these effect instructions are supported:

| Instruction | Source builtin | Request | Successful result |
|---|---|---|---|
| `clock.read` | `clock()` | empty path, declared clock capability | `value_type: i64`, base64 ASCII canonical nonnegative Unix milliseconds |
| `fs.read` | `read_file(path)` | nonempty UTF-8 path, no NUL, at most 4096 bytes | `value_type: bytes`, base64 file content |

The existing Core clock instruction returns `u64`; the wire protocol restricts
clock results to nonnegative `i64`, then converts exactly. All current pure Core
instructions, calls, storage operations and checked traps retain their safe
interpreter semantics. File results live in a run-owned arena: `bytes_len`,
`bytes_get`, passing bytes through calls, and returning bytes all work.

Unsupported declared entry effects fail before execution, including a declared
unsupported effect in a branch that would not run. Capability ambiguity is
checked in reachable functions that contain an actual effect instruction. A
function may propagate two different logical requirements from its callees;
each actual instruction still needs a unique binding in its own function.
`Run`, `RunFast`, `RunTurbo` and `Verify` retain their pure-only boundary.

Results must match the pending protocol version, ID and effect result type.
The decoder rejects omitted, unknown, duplicate, aliased and trailing fields.
Successful values must be non-null; an empty file uses the empty base64 string.
`denied`, `failed`, `uncertain` and `blocked` stop execution with a corresponding
diagnostic. Swyp does not retry, continue with a default, or claim a missing
effect succeeded. Signed receipts and their task/grant/lease/fence checks remain
host evidence and are not part of the guest value.

Fuel counts function entries, instructions and terminators exactly as the safe
executor does. A broker invocation is one instruction; resuming does not reset
fuel, call depth, slots or storage. `--timeout` (1 ms through 60 s) covers safe
execution and response waits after compilation. `--max-bytes` (0 through 1 MiB,
default 256 KiB) limits accumulated file content accepted into the run; immutable
module constants have their separate 256 KiB bound. Each input line is limited
to 2 MiB and each decoded protocol value to 1 MiB. An embedding handler must
respect its context; the CLI exits on timeout while awaiting stdin. Embedding
callers of the CLI adapter must close a blocked reader after cancellation.

The final stdout line has `type: completion`:

```json
{"protocol_version":1,"type":"completion","run_id":"task_42","module_hash":"...","status":"succeeded","result":{"type":"u64","value":"1780000000000"},"steps":3}
```

Scalar values use Core's exact text literals. A final bytes result uses
`{"type":"bytes","value":"<base64>"}` instead of a descriptor tied to an
internal arena. Failures omit `result`, set `status: failed`, retain consumed
steps, and include the structured `diagnostic`. CLI exit status is nonzero on a
failure. Effect requests are emitted directly and have no `type` field.

For embedding without a subprocess, `Executable.RunWithEffects` accepts
`EffectRunOptions{Fuel, MaxBytes}` and a synchronous `EffectHandler`. Its calls
and replies have detached values and sequence correlation; descriptor allocation
stays in the machine. `EffectRunResult.ResolveBytes` returns an owned copy and
does not alter the prepared executable, which remains reusable across runs.
