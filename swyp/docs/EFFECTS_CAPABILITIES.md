# Effects, capabilities, and the SwypikOS broker boundary

This document defines **Effect ABI v1** for Swyp Core IR and the v1 wire
boundary that SwypikOS must implement around it. The authority invariant is:

> An effect declaration is not authority. Authority is an opaque SwypikOS
> capability that guest Swyp code cannot fabricate.

The current Core executor remains deterministic and has no filesystem, process,
network, clock, RNG, model, tool, or device syscall/FFI path.

## 1. Core IR Effect ABI v1

Core IR keeps module `version: 1`. Effectful functions opt into a separately
versioned metadata surface:

```json
{
  "name": "inspect",
  "params": [{"name":"x","type":"i64"}],
  "result": "i64",
  "effect_version": 1,
  "effects": ["fs.read"],
  "required_capabilities": [
    {"name":"workspace_read","effect":"fs.read"}
  ],
  "slots": ["i64"],
  "blocks": [
    {"terminator":{"op":"return","value":0,"location":{}}}
  ]
}
```

`required_capabilities[].name` is a **logical requirement name**. It is not a
capability token, handle, bearer credential, resource locator, or secret. The
Core IR schema contains no field in which guest code can place such authority.
Unknown JSON fields are rejected by the strict decoder, so attempts to add
`capability_refs`, `token`, `handle`, or similar fields fail closed.

Pure functions are canonical when all three effect fields are omitted. Existing
pure Core IR remains accepted, including old JSON that explicitly encoded an
empty `effects` array. The source frontend remains pure-only in this milestone;
no new surface syntax is required to preserve source compatibility.

### 1.1 Effect registry

Effect ABI v1 accepts only these effect identifiers:

```text
clock.read
fs.read
fs.write
model.infer
net.connect
net.fetch
process.exec
rng.sample
tool.call
```

The registry is closed. Unknown effect names are invalid IR. Device operations
remain reserved until a concrete device effect vocabulary is specified instead
of guessing a generic authority class.

### 1.2 Canonical form and validation

For an effectful function:

- `effect_version` is exactly `1`;
- `effects` contains 1..16 known identifiers in strictly increasing lexical
  order, with no duplicates;
- `required_capabilities` contains 1..32 entries, ordered by `(effect, name)`;
- capability requirement names match `[a-z][a-z0-9_]{0,63}` and are unique;
- every capability requirement references a declared effect;
- every declared effect has at least one capability requirement;
- every caller propagates all effects and all capability requirements of every
  directly called function.

Because propagation is checked on every call edge, the declared profile of an
entry function is a transitive upper bound for its selected call graph. Missing
propagation is invalid IR, not an implicit ambient grant.

## 2. Prepare, execute, and verify semantics

`coreir.Prepare` validates the module and snapshots it. The prepared executable
exposes `Semantics(entry)`, which returns `purity`, `effect_version`, `effects`,
and `required_capabilities` from the owned snapshot.

Pure execution is unchanged. `Executable.Run` rejects an effectful entry with
diagnostic code `effectful_program` **before guest execution begins**. It does
not resolve a capability and does not execute a host effect.

Contracts may now describe effects with:

```json
{
  "effect_version": 1,
  "effects": ["fs.read"]
}
```

The contract effect set must exactly match the executable entry's effect set.
For effectful programs, `Verify` validates the contract/profile and returns:

```json
{
  "status": "unknown",
  "method": "effect-contract-validation",
  "purity": "effectful",
  "reason": "effectful_execution_not_supported"
}
```

No test case is executed and no host effect occurs. This prevents bounded pure
execution from being misreported as evidence about an effect that was never
brokered.

## 3. EffectRequest / EffectResult v1 boundary

The following envelopes define the Swyp-to-SwypikOS boundary. They are a wire
contract for the capability broker; the current Core executor does **not** yet
emit or resume these envelopes.

### 3.1 EffectRequest

```json
{
  "version": 1,
  "request_id": "eff_...",
  "function": "inspect",
  "effect": "fs.read",
  "capability_requirement": "workspace_read",
  "arguments": {},
  "budget": {"wall_ms": 10000}
}
```

The request carries the logical requirement name only. It never carries an
opaque capability token. SwypikOS resolves `capability_requirement` against the
current task/lease/approval context, applies scope attenuation and policy, and
either denies the request or invokes the corresponding broker implementation.

### 3.2 EffectResult

```json
{
  "version": 1,
  "request_id": "eff_...",
  "status": "ok",
  "result": {},
  "evidence": {
    "effect_id": "effect_...",
    "result_sha256": "...",
    "duration_ns": 0
  }
}
```

`status` is one of `ok`, `denied`, or `error`. Broker evidence may record an
opaque capability **reference identifier** for audit correlation, but raw bearer
tokens and secrets must never enter Swyp IR, model context, logs, or datasets.

Future resumable effect execution must bind each result to the original
`request_id`, effect declaration, task/lease fence, and broker evidence before
the guest can continue. Blind retry of an uncertain external effect belongs to
SwypikOS recovery policy, not to the Swyp VM.

## 4. Tool ABI v1 relationship

Tools use the same authority split. A descriptor declares effects and logical
requirements:

```json
{
  "version": 1,
  "tool_id": "swyp.verify",
  "input_schema_sha256": "...",
  "output_schema_sha256": "...",
  "effects": [],
  "required_capabilities": [],
  "determinism": "deterministic",
  "timeout_ms": 10000,
  "max_input_bytes": 32768,
  "max_output_bytes": 65536
}
```

Only the **SwypikOS host side** may bind opaque capability references to a
ToolCall after authorization:

```json
{
  "version": 1,
  "episode_id": "ep_...",
  "call_id": "call_...",
  "tool_id": "swyp.verify",
  "arguments": {},
  "capability_refs": [],
  "budget": {"wall_ms": 10000}
}
```

That host ToolCall is not Core IR and is never guest-authoritative. A ToolResult
must bind to `call_id` and carry result/build evidence hashes. The SwypikOS
capability broker remains the single owner of host/device effects.

## 5. What is deliberately not implemented here

- no direct syscall, FFI, filesystem, network, process, clock, RNG, model, or
  tool opcode in the Core VM;
- no capability minting, parsing, attenuation, storage, or validation in Swyp;
- no scheduler, lease, retry, or crash-recovery state machine in Swyp;
- no resumable effect instruction yet;
- no effect syntax in the source frontend yet.

The next SwypikOS integration step is to implement the broker that resolves
logical requirements to opaque grants and executes/denies `EffectRequest` with
lease/fence, idempotency, evidence, and recovery semantics.
