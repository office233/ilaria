# Swyp foreign broker host boundary

SwypikOS owns authority. Swyp source and HIR may name logical capability
requirements, but guest protocol objects never carry kernel capability tokens,
grant IDs, native handles, secrets, or ambient host authority.

`core/swypbroker` implements the host half of Swyp broker protocol v1 without
importing Swyp compiler internals.

## Trust sequence

The required host sequence is:

```text
Swyp broker plan
    -> strict parse + plan_id verification
    -> explicit host approval / Registry
    -> strict broker request parse + request_id verification
    -> exact request-to-approved-plan binding
    -> host execution_id replay reservation
    -> logical capability resolution
    -> trusted executor adapter
    -> result ABI / wire validation
    -> broker response
```

The `Registry` stores immutable canonical copies of approved plans. Merely
presenting a self-consistent plan hash does not approve a plan.

The request validator checks plan ID, call ID, caller, target, ABI/version,
symbol, logical capability, argument ABI descriptors, result ABI, wire encoding,
wire sizes, finite-float rules, bool encoding and deterministic zero padding for
`repr(C)` structs.

Request hashes are integrity identifiers, not authorization. A guest that changes
`symbol` or another contract field and computes a fresh `request_id` is still
rejected because the request no longer matches the approved plan.

## Capability resolution

`CapabilityResolver` receives a validated logical requirement and returns a
host-only `Grant`. `Grant` has no exported data fields and is not part of any JSON
protocol object. A resolver may close over the Control Kernel, Chameleon,
device-broker, policy database, or another SwypikOS authority service.

The broker never derives authority from the guest's symbol or capability string.
Those strings only select requirements already present in an approved plan.

## Executor boundary

`Executor` is a trusted host adapter abstraction, not a generic dynamic loader.
It receives:

- the already validated plan/request identity;
- ABI and symbol from the approved plan;
- validated wire arguments;
- the expected result ABI;
- the host-only grant returned by the resolver.

An executor implementation should map approved targets to pre-registered native
adapters. It must not load arbitrary libraries or infer extra authority from guest
strings.

## Replay model

Swyp requests are content-addressed, so identical semantic calls intentionally
have identical `request_id` values. SwypikOS therefore supplies a separate
host-generated `execution_id` to `Broker.Dispatch`. Reusing the same execution ID
is rejected before capability resolution or execution. A new host execution ID
may intentionally execute the same content-addressed request again.

The current package keeps this replay ledger in memory. A production service that
requires replay protection across OS restarts should back the execution IDs with
durable Control Kernel state before enabling irreversible native effects.

## Current non-goals

This package does not yet:

- load DLLs/shared objects;
- call arbitrary C symbols;
- mint capabilities;
- expose capability tokens to Swyp;
- persist approved plans or replay state;
- choose a native calling convention/register assignment;
- provide cross-process IPC framing.

Those are separate host integrations. The protocol and authority boundary are
validated first so later adapters cannot silently bypass them.
