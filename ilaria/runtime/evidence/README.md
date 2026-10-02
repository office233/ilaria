# Signed execution evidence

This package consumes the generated Swyp effects v1 contract without importing
Swyp or SwypikOS internals. It verifies an executor's signed execution outcome
and returns a local observation. It cannot execute effects, issue grants,
promote checkpoints or admit training examples.

## CLI

From the Ilaria module:

```powershell
go run ./cmd/evidence-check --request request.json --result result.json --receipt receipt.json --expected expected.json --keys keys.json
```

All five inputs must be regular JSON files. Request, receipt and expected
context files are limited to 64 KiB; the result and public-key registry files
are limited to 2 MiB. The decoded result is limited to 1 MiB. The CLI writes
one observation after successful verification and otherwise exits with an
error. It never writes the input file path or result payload into an observation.

For a persistent supervisor connection, start:

```powershell
go run ./cmd/evidence-check --stream --keys keys.json
```

The process loads its public-key registry once. Stdin accepts one bounded JSON
document per line with exactly `protocol_version`, `request`, `result`,
`receipt` and `expected`. The envelope version is `1`; its nested fields use
the same DTOs and independent expected context as file mode. The supervisor
must keep at most one outstanding request and obtain expected context from
its trusted control plane, rather than guest-supplied data.

Each stdout line contains `protocol_version`, the original `request_id`,
`accepted`, and `error_code`. Success includes an `observation`; rejection
omits it. Verifier rejection uses `evidence_rejected`; an unsupported envelope
version uses `unsupported_protocol`. Both preserve request correlation and
allow the next envelope. Malformed JSON, unknown/duplicate/missing fields,
invalid encoding, oversized lines or decoded payloads, and path/name/identifier
limit violations are fatal and stop the process without a response for that
envelope. EOF ends the process cleanly. Responses are written immediately,
without waiting for the stream to close.

The complete envelope is limited to 2 MiB and the decoded result to 1 MiB.
Protocol path/name/identifier bounds remain unchanged. There is no automatic
key reload: restart the process with updated trusted configuration to apply
rotation or revocation. File mode remains available for individual envelopes.

The public-key registry format is `ilaria-effect-trust-registry-v1`, with a
`keys` object mapping each signer key ID to an object containing `executor_id`,
`public_key` and `revoked`. Public keys use standard padded base64. Keep this
registry under control-plane control; a receipt cannot supply its own trust.
Private signing keys are neither accepted nor needed by Ilaria.

The expected execution file supplies `task_id`, `node_id`, `attempt_id`,
`executor_id`, `grant_id`, `lease_id` and a positive `fence`. It may also pin
`intent_id`. Obtain this current context independently from trusted task/lease
state, and retain the original requested operation. Copying expected fields
from an incoming receipt would defeat the execution-context check.

## Go API

Create `NewVerifier(map[string]TrustedKey)` with configured public keys, then
call `Verify(request, result, receipt, expected)` using the generated
`ilaria/generated/swypeffects` DTOs and `ExpectedExecution`. Each verifier owns
an immutable snapshot of the supplied registry. Construct a new verifier when
trust configuration changes, including key rotation or revocation.

`DecodeStrict` is the JSON boundary helper used by the CLI. It rejects unknown,
duplicate, aliased and missing required fields; null scalars; trailing data;
invalid UTF-8 and unpaired escaped UTF-16 surrogates; and noncanonical base64.
Empty strings remain explicit required fields. An empty successful file result
uses an empty byte slice rather than null.

Verification binds the entire request and result hashes, request identity,
effect and capability, expected task/node/attempt/executor/grant/lease/fence,
intent, status, privacy class, timestamp and signer identity. Only successful
terminal results with no error become observations. Unknown or revoked signers,
another executor's key, negative/nonterminal outcomes, stale fences and altered
payloads are rejected.

The Swyp schema fixes DTO field order. SHA-256 covers `json.Marshal` of the full
request or result. Ed25519 covers `nexus.effect.receipt.v1\n` followed by the
canonical receipt with `signature=null`. `ReceiptHash` identifies this signed
content, excluding the signature bytes. Shared golden hashes and the root
integration gate exercise interoperability with the actual broker.

## Evidence policy and limits

An observation has `purpose="execution_evidence_only"`,
`privacy_class="local_private"` and `training_eligible=false`. The signature
proves that a configured trusted executor attested the bound outcome; it does
not establish task correctness, provenance permissions or training rights.
Admission into memory or training requires a separate authenticated policy.

The verifier is stateless: it does not deduplicate observations, determine
whether a lease remains live, manage keys or reconcile broker intents. The
consumer must supply current expected context; the host control plane owns
lease validity, commit and replay prevention.

See the [workspace milestone](../../../docs/milestones/effects-v1.md) for the
complete vertical slice and its next implementation steps.

The CLI includes `BenchmarkEvidenceFileVersusPersistentStream`, comparing
32 repeated file-mode verifications with one persistent 32-envelope batch.
It measures in-process file reads, JSON work, signature verification and
allocations. It excludes process startup, OS provider work and energy use.
Run it from the Ilaria module with:

```powershell
go test ./cmd/evidence-check -run '^$' -bench BenchmarkEvidenceFileVersusPersistentStream -benchmem
```
