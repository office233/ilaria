# Driver synthesis security contract

## Threat model

Generated device-support code is untrusted input even when Ilaria produced it.
The model may be wrong, evidence may be incomplete, a hardware description may be
malicious or stale, and a valid driver for one firmware revision may be dangerous
on another. Model confidence is never an authorization signal.

The M1 control rule is:

`synthesize → isolated build → deterministic verify → stage → canary → health gate → activate or rollback`

No step grants ambient kernel memory, filesystem or network authority.

## Authority boundary

Generated drivers are user-mode/capability-domain by default. They may request
only the v1 logical device capabilities (`mmio`, `ioport`, `irq`, `dma`, `config`,
`power`, `clock`). A request is merely a declaration; the SwypikOS authority plane
must later mint and enforce narrow capabilities for the exact device and resource.

Kernel-resident generated code is outside this M1 contract. Any future exception
requires a separate reviewed policy, stronger memory-safety/static guarantees and
an explicit trusted-kernel change process.

## Deterministic acceptance gates

`core/devicesynth.DeterministicVerifier` fails closed unless all applicable checks
pass. In particular:

- manifest/service ABI versions must match v1;
- the selector must match the intended manifest device;
- the candidate hardware binding must equal the canonical manifest binding;
- requested capabilities must be policy-allowed;
- requested, declared, policy-allowed and independently observed capabilities must
  all belong to the closed Driver ABI v1 vocabulary before policy intersection;
- declared capabilities must equal the synthesis request;
- build/static observations are authority-plane scanner inputs, never candidate
  declarations, and may not reveal undeclared capabilities;
- source, build manifest, toolchain and provenance hashes must match exact bytes;
- trusted builder artifact bytes are re-hashed and must exactly match the manifest
  before VERIFY/STAGE/CANARY/ACTIVE;
- candidate provenance has no approval authority: every reference must match an
  externally supplied approved-evidence registry by exact ID+digest;
- candidate-owned `Passed` test fields are non-authoritative; every required test
  needs external runner evidence bound to candidate, artifact, contract and
  toolchain before staging.

The verifier is deterministic and contains no model call. A future independent
model reviewer can add advisory evidence but cannot override these policy gates.

## Canary, rollback and crash safety

The adaptation journal enforces legal state transitions and persists them through
an atomic replacement file with a hash-chained history. STAGE/CANARY/ACTIVE require
an Ed25519 verifier attestation signed by a configured trust anchor and bound to the
exact candidate digest, current hardware binding, trusted built-artifact digest,
verifier identity/version, permitted target state and evidence-summary hash. A
caller-constructed `VerificationResult` has no authority without that signature.
ACTIVE also requires explicit canary health evidence. A health regression records
a reason and enters ROLLBACK; repeated inability to recover can enter SAFE_MODE.

Load-time journal validation revalidates every persisted verifier signature against
the configured trust anchors and current hardware binding in addition to rejecting
malformed headers, sequence gaps, illegal transitions, current-state mismatches and
hash-chain corruption. Recomputing the hash chain cannot forge verifier authority.
The system must never infer that a partially persisted transition succeeded.

## Topology policy

Bus parents must exist, cannot self-parent and must form an acyclic parent forest.
M1 device edges are treated as directed hierarchical/dependency relations: self
edges, exact duplicates and directed cycles are rejected before a hardware binding
can be computed. A future non-hierarchical relation must define separate semantics
before it can opt out of this DAG policy.

## Privacy

The canonical manifest has no raw serial field. Raw hardware serials/private
identifiers are excluded by default. When correlation is strictly necessary and
policy permits it, only a one-way SHA-256 digest is stored in `SerialDigest`.
Evidence bundles must not contain user files, conversations, secrets or unrelated
device identifiers.

## Mobile and automotive boundaries

Locked phone/tablet boot chains, proprietary baseband/GPU/ISP firmware and secure
elements remain subject to vendor authorization and available specifications.
AI synthesis does not bypass those technical or legal boundaries.

Automotive generated code is not authorized for brakes, steering, airbags,
propulsion or other safety-critical actuation in this architecture. Such control
requires OEM authorization and a separately certified safety architecture.

## Required evidence before broader rollout

M1 proves only the portable contracts and simulated unknown-device lifecycle. Real
hardware rollout additionally requires isolated build/runtime domains, capability
broker enforcement, emulator/property/fault tests, controlled physical probes,
signing keys/attestation policy, qualified hardware matrices and recovery testing.
