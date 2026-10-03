# SWOS M1 — Independent QA: Universal Device Synthesis + Native Kernel Seed

**Date:** 2026-09-28  
**Role:** independent principal systems/kernel/security verifier  
**Source policy:** read-only; no repairs performed  
**Only intentional QA write:** this report

## Verdict summary

| Candidate | Verdict | Summary |
|---|---|---|
| D — Device Synthesis | **REJECTED** | Required Go gates pass, but the trust boundary is forgeable: journal activation accepts caller-constructed `VerificationResult` values; candidate-controlled provenance/test/static-observation fields are treated as independent evidence; actual built artifact bytes are never verified. |
| E — Native Kernel Seed | **REJECTED** | Reproducible PE32+ EFI artifact and host gates pass, but the DeviceGraph decoder/capability boundary accepts unsafe non-canonical/range data, capability generations can wrap back to a stale handle, and bounded IPC does not reject stale/forged capability references. Real boot execution is additionally **BLOCKED** because QEMU is absent. |

Passing tests are not sufficient to override the security/integrity findings below.

---

# Candidate D — Device Synthesis

## What verified correctly

- `HardwareBindingHash` is deterministic for accepted manifests and sorts firmware, buses, device properties, devices, and edges before hashing.
- Device IDs and bus IDs are checked for duplicates; device bus references and device-edge endpoints are checked.
- Selector matching requires a concrete `DeviceID`, so a validated manifest cannot match multiple devices through the selector alone.
- Source/build-manifest/toolchain/provenance metadata hashes are recomputed from the bytes/objects present in the candidate bundle.
- A hardware binding mismatch is rejected by `DeterministicVerifier`.
- An observed undeclared capability is rejected when it is actually present in `ObservedCapabilities`.
- Journal persistence uses same-directory temporary file + file sync + rename + directory sync and fails closed on malformed JSON, sequence mismatch, illegal transitions, current-state mismatch, missing required evidence fields, and hash-chain corruption.
- The unknown-device lifecycle test exercises PROBE → MATCH → SYNTHESIZE → BUILD → VERIFY → STAGE → CANARY → ACTIVE → ROLLBACK and passes.

## Findings

### D-1 — CRITICAL — STAGE/CANARY/ACTIVE authorization accepts a forgeable `VerificationResult`

**Files:**  
- `swypik-os/core/devicesynth/journal.go:155-180`  
- `swypik-os/core/devicesynth/journal.go:246-260`  
- `swypik-os/core/devicesynth/verifier.go:23-30`

**Problem**

`validateTransitionEvidence` authorizes protected transitions by checking only:

1. `Verification != nil`;
2. `Verification.OK == true`;
3. supplied `CandidateDigest` equals `Verification.CandidateDigest`;
4. `Verification.TargetState` rank is high enough.

`VerificationResult` is a public mutable struct. The journal does not re-run the verifier, authenticate the verifier result, require the expected verifier ID, verify the current hardware binding, inspect `Checks`, or require/recompute an artifact manifest/trust record. `ArtifactDigest` is not required for STAGE/CANARY/ACTIVE at all.

On reload, `validateRecord` only requires a non-empty `VerificationDigest`; it cannot prove that the persisted digest came from an authentic verifier decision.

**Adversarial reproduction / reasoning**

A caller can construct a value equivalent to:

`VerificationResult{OK:true, TargetState:StateActive, CandidateDigest:X}`

with empty `Checks`, empty `VerifierID`, and empty `HardwareBindingHash`. If `X` is also supplied as `TransitionEvidence.CandidateDigest`, STAGE and CANARY pass; ACTIVE also passes when `HealthPassed=true`. No deterministic verification needs to have executed.

A stale result also has no journal-side binding to the *current* hardware manifest because the transition API receives no hardware manifest/binding.

**Impact**

The state machine can mark unverified code STAGED/CANARY/ACTIVE, bypassing the central safety invariant.

**Minimal repair**

Make verifier authorization non-forgeable and state-bound. At minimum:

- do not accept a caller-authored `VerificationResult` as authority;
- have the journal/activation layer invoke a trusted verifier or consume an opaque verifier-issued attestation/token;
- bind that attestation to candidate digest, hardware binding, artifact digest, verifier identity/version, target state, and required evidence;
- require a valid `ArtifactManifest`/trust record before STAGE/CANARY/ACTIVE;
- persist enough authenticated data to revalidate on load.

---

### D-2 — HIGH — provenance approval is candidate-controlled, not authority-controlled

**Files:**  
- `swypik-os/core/devicesynth/abi.go:80-85`  
- `swypik-os/core/devicesynth/abi.go:116-128`  
- `swypik-os/core/devicesynth/abi.go:134-139`  
- `swypik-os/core/devicesynth/verifier.go:142-149`

**Problem**

`EvidenceReference.Approved` is embedded directly in `CandidateBundle.Provenance`, which is synthesizer output. Although `SynthesisRequest` separately carries approved evidence, `VerificationRequest` has no trusted approved-evidence set. The verifier therefore accepts provenance merely because the candidate says `Approved: true` and provides a syntactically valid SHA-256.

**Adversarial reproduction / reasoning**

A malicious/incorrect synthesizer can return an arbitrary evidence reference, set `Approved=true`, choose any 64-hex SHA-256 digest, recompute `Manifest.ProvenanceHash`, and satisfy `approved_provenance`.

**Impact**

The model/candidate can self-approve the evidence that is supposed to constrain it.

**Minimal repair**

Remove approval authority from candidate-owned data. Pass an external policy-approved evidence set/registry into the verifier and require exact ID+digest membership. Candidate provenance should only reference evidence, never declare its approval.

---

### D-3 — HIGH — test evidence and built artifact identity are self-attested / not checked against trusted bytes

**Files:**  
- `swypik-os/core/devicesynth/abi.go:93-97`  
- `swypik-os/core/devicesynth/abi.go:116-128`  
- `swypik-os/core/devicesynth/verifier.go:128-155`  
- `swypik-os/core/devicesynth/verifier.go:167-185`

**Problem**

For built artifacts, the verifier checks only that `Manifest.BuildArtifactHash` has SHA-256 syntax. No built artifact bytes or trusted builder output are supplied, so the digest is never recomputed.

For tests, `TestEvidence.Passed` and `EvidenceHash` are candidate-bundle fields. `requiredTestsPassed` accepts them when `Passed=true` and the hash is syntactically valid; it does not validate an independent runner result or evidence payload.

**Adversarial reproduction / reasoning**

- A candidate can declare any valid-looking `sha256:<64 hex>` as the build-artifact hash; a different binary can subsequently be staged because activation never reads/re-hashes the artifact bytes.
- A candidate can emit `TestEvidence{ContractID:"required", Passed:true, EvidenceHash:"sha256:..."}` without an independent test executor ever producing the evidence.

**Impact**

A tampered/replaced binary or fabricated test result can satisfy the current verifier contract.

**Minimal repair**

Move artifact and test evidence to trusted verifier inputs:

- provide actual artifact bytes/path via a trusted builder and recompute SHA-256;
- represent test results as verifier/runner-issued attestations bound to contract ID, candidate digest, artifact digest, toolchain, and output digest;
- do not allow the synthesizer to populate authoritative `Passed` evidence.

---

### D-4 — HIGH — capability audit trusts candidate observations and does not enforce the closed v1 vocabulary

**Files:**  
- `swypik-os/core/devicesynth/abi.go:18-28`  
- `swypik-os/core/devicesynth/abi.go:116-128`  
- `swypik-os/core/devicesynth/verifier.go:89-125`

**Problem**

`ObservedCapabilities` is part of the candidate bundle, so the candidate can omit an undeclared effect. The verifier does not run or consume an independent static/build capability observation.

Also, `LogicalCapability` is an open string type. The verifier checks requested capabilities only against caller-provided `AllowedCapabilities`; it does not first require membership in the ABI v1 capability vocabulary. A misconfigured caller can therefore authorize an arbitrary string not defined by Driver ABI v1.

**Adversarial reproduction / reasoning**

- Candidate uses an undeclared operation but leaves it out of `ObservedCapabilities`: `no_undeclared_capability` remains true.
- Caller includes `LogicalCapability("kernel-memory")` in `AllowedCapabilities`; candidate requests/declares it and can pass the current membership logic.

The existing unit test correctly rejects an undeclared capability **only when the test itself inserts that capability into `ObservedCapabilities`**.

**Impact**

The effect/capability boundary is not independently enforced.

**Minimal repair**

Use a trusted static/build scanner result as verifier input, not candidate output, and reject any requested/declared/observed capability that is not in the canonical ABI v1 set before applying policy intersection.

---

### D-5 — MEDIUM — HardwareManifest validation misses bus-parent references and cycle invariants

**File:** `swypik-os/core/devicesynth/types.go:176-213`

**Problem**

Bus IDs are unique, but `BusDescriptor.ParentID` is never checked for existence, self-reference, or cycles. Device edges validate only endpoint existence and non-empty relation; self-edges, duplicate edges, and cycles are accepted.

**Adversarial reproduction / reasoning**

These manifests currently validate:

- bus `b0` with `ParentID:"missing"`;
- bus `b0 -> b1`, `b1 -> b0`;
- device edge `A -> A`;
- `A -> B`, `B -> A`.

`HardwareBindingHash` will deterministically hash these invalid/ambiguous graphs rather than reject them.

**Impact**

Downstream topology traversal can receive structurally invalid graphs despite a successful manifest validation.

**Minimal repair**

Validate bus parent existence, forbid self-parent, detect parent cycles, and define/enforce edge cycle/duplication policy by relation type.

---

## D adversarial matrix

| Scenario | Result |
|---|---|
| Unknown-device E2E | **PASS** — covered by `TestUnknownDeviceSynthesisVerifyCanaryRollback`; package/race tests pass. |
| Candidate metadata tamper after genuine verification | **PARTIAL PASS** — candidate digest changes and a genuine stale result no longer matches; however actual built artifact bytes are outside the digest verification path (D-3). |
| Stale/fabricated verification | **FAIL** — journal trusts caller-constructed `VerificationResult` (D-1). |
| Hardware binding mismatch | **PASS at verifier boundary** — `hardware_firmware_binding` rejects mismatch; existing test covers it. Journal can still be bypassed by D-1. |
| Undeclared capability | **PARTIAL** — rejected if independently observed data is supplied, but observations are candidate-controlled (D-4). |
| Corrupt journal | **PASS for accidental/crash corruption** — malformed JSON, sequence/state/transition/hash-chain corruption fail closed; atomic replace is used. The chain is not an authenticated anti-tamper log against a writer that can recompute hashes. |

## D required command results

- `go test -count=1 -race ./core/devicesynth` — **PASS**, exit 0, `ok swypik-os/core/devicesynth 1.502s`.
- `go vet ./...` — **PASS**, exit 0.
- `go test -count=1 -timeout 180s ./...` — **PASS**, exit 0; all reported packages passed, including `core/devicesynth`.
- `git diff --check` — **PASS**, exit 0.

**Candidate D verdict: REJECTED.**

---

# Candidate E — Native Kernel Seed

## What verified correctly

- Source is first-party C11/freestanding seed code; no Linux kernel headers or copied Linux source were found. Search hits for “Linux” were documentation/ADR references only.
- Build script writes build products below `out/` and contains no disk partitioning, boot-entry, firmware-variable, mount, deployment, or install mutation.
- Capability table implements per-slot generation, domain binding, lease-fence equality, per-object rights masks, and explicit revoke.
- DeviceGraph decoder bounds node/resource/edge counts before indexing and requires exact total wire length.
- Duplicate node IDs and broken node/resource/edge references are rejected.
- IPC queue is bounded and checks payload length and queue capacity.
- x86_64 UEFI declarations use `ms_abi` for public firmware calls/entrypoint. The entrypoint takes `EFI_HANDLE` and `EFI_SYSTEM_TABLE *`; system-table/boot-service prefixes place `GetMemoryMap` at the expected prefix position.
- UEFI memory-map capture records address, byte size, descriptor stride/version, entry count, and map key in static storage.
- `build.ps1` does not call `ExitBootServices` or mutate boot/disk state.
- The produced image is `pei-x86-64`, PE32+ (`Magic 020b`), subsystem 10 (EFI application), entrypoint RVA `0x1000`.
- `objdump -x` reports no `DLL Name:` entries; the import table is empty.
- ARM64 and RISC-V outputs are correctly documented as host-compiler contract/layout checks, not real ARM64/RISC-V binaries.
- UEFI 2.11 §2.3.4 matches the x64 RCX/RDX calling convention used through `ms_abi`. UEFI 2.11 §2.1 requires PE32+ EFI image loading/fixups; actual firmware load is not claimed here.

## Findings

### E-1 — HIGH — decoded fixed-width strings are not guaranteed NUL-terminated

**Files:**  
- `swypik-kernel/include/swypik/kernel/device_graph.h:77-78`  
- `swypik-kernel/src/core/device_graph.c:186-204`  
- consumer example: `swypik-kernel/tests/host_core_test.c:143-146`

**Problem**

The decoder copies all 16 bytes of `firmware_version` and all 24 bytes of `model` directly from untrusted wire data. If every byte is nonzero, neither array is a valid C string. The public struct exposes them as `char[]`, and existing test/consumer code uses `strcmp`.

**Adversarial reproduction / reasoning**

Craft a valid-length graph whose 24-byte model field contains 24 nonzero bytes. Decode succeeds. Any later `strcmp`/string consumer can read past the `model` array until it happens to encounter a zero byte.

**Impact**

Malformed device-graph input can create out-of-bounds reads in downstream kernel/driver-domain code.

**Minimal repair**

Either reserve one byte and force termination on decode, or model these fields as explicit `{length, bytes}` values. Reject non-canonical overlength/nonterminated wire encodings if the ABI promises strings.

---

### E-2 — HIGH — DeviceGraph accepts wrapping/zero-length resource ranges and exposes them as capabilities

**Files:**  
- `swypik-kernel/src/core/device_graph.c:138-144`  
- `swypik-kernel/src/core/device_graph.c:301-310`  
- `swypik-kernel/src/core/device_graph.c:324-361`

**Problem**

Resource validation checks only node existence and resource kind. It does not reject zero length or `start + length` overflow before converting the resource into MMIO/DMA/shared-memory/config/etc. capability objects.

**Adversarial reproduction / reasoning**

A wire resource such as `start = UINT64_MAX - 7`, `length = 16` decodes and validates. `swyp_device_resource_capability` then returns that wrapping range as a capability object.

**Impact**

Any later range check written as `addr < base + length` can wrap and authorize the wrong address region. This is a security boundary defect, not merely malformed metadata.

**Minimal repair**

Validate resource ranges before acceptance:

- kind-specific nonzero length requirements;
- `length <= UINT64_MAX - start`;
- sensible IRQ/config/control constraints;
- reject impossible/overlapping ranges according to policy before capability creation.

---

### E-3 — MEDIUM — “canonical” DeviceGraph wire format accepts hidden nonzero reserved bytes

**Files:**  
- encoder: `swypik-kernel/src/core/device_graph.c:206-257`  
- decoder: `swypik-kernel/src/core/device_graph.c:260-321`

**Problem**

The encoder zeros reserved bytes, but the decoder does not require them to be zero. Ignored bytes include header reserved fields and padding/reserved bytes in node/resource/edge records.

Therefore multiple different byte strings decode to the same logical graph even though `KERNEL_SEED.md` describes the wire representation as canonical.

**Adversarial reproduction / reasoning**

Take a valid encoded graph and change only ignored reserved bytes (for example header bytes 18–23 or resource reserved bytes 12–15). The parsed graph is unchanged and validation succeeds.

**Impact**

Wire-level hashing/signing/content addressing can become malleable: semantically identical graphs can have different byte digests, and hidden data can be carried through an otherwise “canonical” envelope.

**Minimal repair**

Reject any nonzero reserved/padding field during decode and document which bytes are required to be zero.

---

### E-4 — MEDIUM — 32-bit capability generation wrap can revive an ancient stale handle

**File:** `swypik-kernel/src/core/capability.c:126-130`

**Problem**

A capability handle contains a 32-bit generation. Revoke increments the generation and, on wrap to zero, resets it to 1.

After enough reuse of the same slot, generation 1 recurs. An old generation-1 handle can become bit-identical to a newly minted handle for that slot.

**Adversarial reproduction / reasoning**

Start from slot S generation 1, retain the old handle, cycle revoke/remint until the 32-bit generation wraps, then remint S at generation 1. If domain/fence and requested rights also match, the ancient handle can resolve to the new grant.

**Impact**

This violates the documented invariant that a stale handle cannot regain authority when a slot is reused.

**Minimal repair**

Never recycle a generation value within the lifetime of stale handles: retire a slot on generation exhaustion, widen the generation/epoch design, or add a non-wrapping table epoch/nonce.

---

### E-5 — MEDIUM — bounded IPC does not reject stale/forged capability references

**Files:**  
- `swypik-kernel/include/swypik/kernel/ipc.h:10-16`  
- `swypik-kernel/src/core/ipc.c:26-50`

**Problem**

`SwypIpcMessage.sender_capability` is copied into the queue without lookup or validation. `swyp_ipc_send` and `swyp_ipc_receive` do not take a capability table, domain, lease fence, or endpoint send/receive grant.

The queue correctly enforces payload/queue bounds, but it does not provide stale-reference semantics itself.

**Adversarial reproduction / reasoning**

Any 64-bit value, including a revoked capability handle, can be placed in `sender_capability`; the queue returns it unchanged.

**Impact**

If downstream code treats `sender_capability` as authenticated sender authority, stale/forged handles cross the IPC boundary unchecked.

**Minimal repair**

Either:

1. integrate capability lookup/domain/fence checks at the IPC entry boundary and only enqueue an authenticated sender identity/reference; or
2. explicitly rename/document the field as untrusted metadata and require a mandatory checked wrapper before any authority decision.

---

### E-6 — MEDIUM — DeviceGraph topology does not reject self/cyclic parent/edge graphs

**File:** `swypik-kernel/src/core/device_graph.c:115-153`

**Problem**

Node parent references and edge endpoints must exist, but self-parent/self-edge and cycles are not rejected.

**Adversarial reproduction / reasoning**

Graphs with `node.parent_id == node.id` or two nodes parented to each other pass the current reference checks. Equivalent cycles can be represented through topology edges.

**Impact**

Traversal code can loop or require ad-hoc cycle defenses despite receiving a “validated” graph.

**Minimal repair**

Define topology semantics per edge kind, reject self-parent, and perform bounded cycle detection for hierarchical relations.

---

## E UEFI / build evidence

### Reproducible build

Two independent required rebuilds produced the identical SHA-256:

`806ced9eb25d844518e38cabc4216088dde9af5dac5c33582343eb785652b946`

Both builds returned exit 0 and printed:

- host core tests: PASS;
- x86_64/ARM64/RISC-V contract compile checks completed;
- PE inspection completed;
- `swypik-kernel build: PASS`.

### PE/EFI inspection

Required `objdump -x out\efi\BOOTX64.EFI` shows:

- format: `pei-x86-64`;
- architecture: `i386:x86-64`;
- `Magic 020b (PE32+)`;
- `AddressOfEntryPoint 0x1000`;
- `Subsystem 0x0a (EFI application)`;
- empty import table / no `DLL Name:` entries;
- no Base Relocation Directory is emitted.

The empty relocation directory is recorded as an observation, not independently declared a failure here: x86_64 code may be fully position-independent for this seed. Because no firmware/QEMU load was executed, actual loader acceptance/relocation behavior remains unverified.

The PE file also carries the PE `DLL` characteristic due to the MinGW `-shared` link method; no DLL imports are present. This is likewise structural evidence only until firmware execution.

### Boot evidence

`build.ps1` reports:

`QEMU unavailable: boot execution remains an explicit blocker; PE build/inspection completed.`

Therefore:

- **do not claim boot success**;
- x86_64 firmware execution is **BLOCKED**;
- ARM64/RISC-V are compile/layout contracts only, not target binaries and not boot-tested.

## E required command results

- `powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1` — **PASS**, exit 0, SHA above.
- same build command second time — **PASS**, exit 0, identical SHA.
- `objdump -x out\efi\BOOTX64.EFI` — **PASS as structural inspection**; PE32+/EFI x86_64/no DLL imports confirmed.
- `git diff --check` — **PASS**, exit 0.
- root `swypik-os: go vet ./...` — **PASS**, exit 0.
- root `swypik-os: go test -count=1 -timeout 180s ./...` — **PASS**, exit 0; all reported packages passed.
- Linux-source/dependency search — no kernel/header/source dependency found; only documentation references to Linux.

**Candidate E verdict: REJECTED.**  
**Real x86_64 boot execution status: BLOCKED (QEMU absent).**

---

# Required repair order (informational only; no repair performed)

1. **D-1** — make verification authorization non-forgeable and bind activation to current hardware + exact artifact.
2. **D-2/D-3/D-4** — move provenance approval, test results, artifact bytes, and static capability observations outside candidate/model authority.
3. **E-1/E-2** — harden DeviceGraph decode/resource invariants before the graph can mint capabilities.
4. **E-3/E-6** — enforce canonical reserved bytes and topology invariants.
5. **E-4/E-5** — close capability generation-wrap and IPC stale-reference semantics.
6. Re-run all gates plus targeted adversarial tests for every repaired invariant.
7. Only after source QA passes, add QEMU/OVMF boot evidence for the x86_64 EFI seed.

No source files were repaired, committed, pushed, or deployed by this QA.
