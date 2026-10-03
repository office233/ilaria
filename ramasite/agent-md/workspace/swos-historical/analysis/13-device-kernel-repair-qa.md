# SWOS M1 — Fresh QA after Device Synthesis + Native Kernel repairs

**Date:** 2026-09-28  
**Role:** independent principal kernel/security verifier  
**Source policy:** read-only; no repairs performed  
**Only intentional QA write:** this report  
**Required contract:** `E:\CEO\projects\swos\dispatch\qa-device-kernel-repair.md`

## Verdict summary

| Candidate | Verdict | Summary |
|---|---|---|
| D — Device Synthesis | **VERIFIED** | Former D-1..D-5 are closed in the inspected source. Protected transitions use verifier-signed Ed25519 attestations bound to candidate, hardware, artifact, verifier identity/version, target state and evidence summary; reload revalidates them. Provenance/test/artifact/capability/topology adversarial cases are covered and required Go gates pass. |
| E — Native Kernel Seed | **VERIFIED** | Former E-1..E-6 are closed in the inspected source. Canonical DeviceGraph decoding, resource-range safety, reserved-byte rejection, capability generation retirement, IPC authority checks and topology validation are present; no introduced integer/length arithmetic defect was found. Required build/inspection gates pass reproducibly. |

**Runtime x86_64 boot evidence:** **BLOCKED** because QEMU is absent. This is not treated as a source rejection because the M1 seed contract is structural and explicitly makes no boot-success claim.

---

# Candidate D — Device Synthesis

## D-1 — VERIFIED — protected transition authorization is non-forgeable and reload-revalidated

### Source evidence

- `swypik-os/core/devicesynth/attestation.go:21-31` defines the signed attestation fields:
  - candidate digest;
  - hardware binding hash;
  - artifact digest;
  - verifier ID/version/key ID;
  - target state;
  - evidence-summary hash;
  - signature.
- `swypik-os/core/devicesynth/attestation.go:34-80` signs and verifies Ed25519 attestations and rejects schema/identity/key/signature mismatch.
- `swypik-os/core/devicesynth/verifier.go:288-304` issues an attestation only after the deterministic verification result is successful.
- `swypik-os/core/devicesynth/journal.go:187-213` requires a successful result plus signed attestation for STAGE/CANARY/ACTIVE and rejects mutable result fields that do not match the signed attestation.
- `swypik-os/core/devicesynth/journal.go:220-240` binds the protected transition to:
  - exact candidate digest;
  - exact artifact digest;
  - current journal hardware binding;
  - permitted target-state rank;
  - configured verifier trust anchor;
  - valid Ed25519 signature.
- `swypik-os/core/devicesynth/journal.go:293-334` revalidates every persisted protected-transition attestation and its canonical digest while loading the journal.
- `swypik-os/core/devicesynth/devicesynth_test.go:247-280` verifies a fabricated public `VerificationResult` cannot stage.
- `swypik-os/core/devicesynth/devicesynth_test.go:282-354` verifies tampered payload, stale hardware binding and persisted-attestation tampering fail closed after reload.

### Adversarial result

| Case | Result |
|---|---|
| Caller-fabricated `VerificationResult{OK:true}` | **REJECTED** |
| Tampered signed evidence-summary payload | **REJECTED** |
| Attestation stale for different current hardware binding | **REJECTED** |
| Persisted attestation edited and journal hash recomputed | **REJECTED on reload** |

No D-1 defect reproduced.

---

## D-2 — VERIFIED — candidate provenance cannot self-approve

### Source evidence

- `swypik-os/core/devicesynth/abi.go:80-87` explicitly makes candidate `Approved` metadata legacy/non-authoritative.
- `swypik-os/core/devicesynth/verifier.go:250-251` authorizes provenance only through the externally supplied approved-evidence registry.
- `swypik-os/core/devicesynth/verifier.go:338-358` requires exact `ID + digest` membership and ignores candidate approval flags.
- `swypik-os/core/devicesynth/devicesynth_test.go:356-367` verifies candidate self-approval without registry authority fails.

No D-2 defect reproduced.

---

## D-3 — VERIFIED — actual artifact bytes and external trusted test evidence are bound

### Source evidence

- `swypik-os/core/devicesynth/verifier.go:206-216` hashes actual `BuiltArtifact` bytes and requires exact equality with `Manifest.BuildArtifactHash` for VERIFY/STAGE/CANARY/ACTIVE.
- `swypik-os/core/devicesynth/verifier.go:253-257` requires external trusted test evidence for protected states.
- `swypik-os/core/devicesynth/verifier.go:360-389` binds each required test result to:
  - contract ID;
  - runner ID/version;
  - candidate digest;
  - artifact digest;
  - toolchain hash;
  - passed status;
  - evidence hash.
- `swypik-os/core/devicesynth/devicesynth_test.go:369-375` verifies candidate-owned fake `Passed=true` evidence is non-authoritative.
- `swypik-os/core/devicesynth/devicesynth_test.go:382-388` verifies different artifact bytes cannot satisfy the manifest hash.

### Adversarial result

| Case | Result |
|---|---|
| Candidate-owned fake test pass | **REJECTED** |
| Built artifact bytes differ from manifest hash | **REJECTED** |
| Test evidence missing required trusted runner entry | **REJECTED** |

No D-3 defect reproduced.

---

## D-4 — VERIFIED — closed ABI v1 vocabulary and external capability observation enforced

### Source evidence

- `swypik-os/core/devicesynth/verifier.go:172-179` requires policy-allowed, candidate-requested and manifest-declared capabilities all to belong to the closed Driver ABI v1 vocabulary.
- `swypik-os/core/devicesynth/verifier.go:218-231` validates the external scanner observation and rejects observed capabilities not declared by the candidate.
- `swypik-os/core/devicesynth/verifier.go:326-336` binds scanner observation to scanner identity/version, candidate digest, artifact digest, evidence hash and ABI-v1 capability vocabulary.
- `swypik-os/core/devicesynth/devicesynth_test.go:390-413` verifies arbitrary `kernel-memory` remains rejected even if the caller policy allowlist contains it.
- `swypik-os/core/devicesynth/devicesynth_test.go:415-423` verifies candidate omission cannot hide an undeclared capability present in the trusted scanner observation.

No D-4 defect reproduced.

---

## D-5 — VERIFIED — malformed bus/device topology rejected

### Source evidence

- `swypik-os/core/devicesynth/types.go:176-201` checks unique bus IDs, parent existence, self-parent and parent cycles.
- `swypik-os/core/devicesynth/types.go:218-242` checks device-edge endpoint existence, non-empty relation, self-edge, exact duplicates and directed cycles.
- `swypik-os/core/devicesynth/devicesynth_test.go:426-465` covers missing bus parent, bus cycle, self edge, duplicate edge and device cycle.

No D-5 defect reproduced.

---

## Candidate D required command results

1. `go test -count=1 -race ./core/devicesynth`  
   **PASS**, exit 0.  
   Exact package result: `ok swypik-os/core/devicesynth 1.793s`.

   Note: the first invocation was not admitted by the Bridge because the host was at CPU 100% and the heavy-job admission slot was occupied. It did not execute the test and therefore was not a code failure. The required command was retried independently and passed as above.

2. `go vet ./...`  
   **PASS**, exit 0, no output.

3. `go test -count=1 -timeout 180s ./...`  
   **PASS**, exit 0.  
   All reported packages passed; `swypik-os/core/devicesynth` reported `ok ... 1.200s`.

4. `git diff --check`  
   **PASS**, exit 0, no output.

**Candidate D verdict: VERIFIED.**

---

# Candidate E — Native Kernel Seed

## E-1 — VERIFIED — fixed-width strings are canonical and C-string safe

### Source evidence

- `swypik-kernel/src/core/device_graph.c:67-80` requires a NUL terminator inside the fixed-width field and requires every byte from the first NUL through the end of the field to be zero.
- `swypik-kernel/src/core/device_graph.c:252-260` applies that canonical-string validation to in-memory graph nodes.
- `swypik-kernel/src/core/device_graph.c:452-456` rejects noncanonical full-width firmware/model strings before decoding.
- `swypik-kernel/tests/host_core_test.c:188-192` adversarially fills the entire firmware/model fields with nonzero bytes and expects `SWYP_ERR_CORRUPT`.

No E-1 defect reproduced.

---

## E-2 — VERIFIED — zero/wrapping/invalid resource ranges cannot mint capabilities

### Source evidence

- `swypik-kernel/src/core/device_graph.c:95-115` rejects:
  - zero length;
  - MMIO/DMA/shared-memory wrap;
  - port-I/O outside the 16-bit port space;
  - IRQ ranges other than one vector or beyond 32-bit;
  - config windows outside the 4 KiB aperture;
  - control resources with length other than one.
- `swypik-kernel/src/core/device_graph.c:117-141` defines overlap rejection policy.
- `swypik-kernel/src/core/device_graph.c:202-218` rejects an invalid resource before adding it to the graph.
- `swypik-kernel/src/core/device_graph.c:490-528` revalidates the resource before translating it into a capability object.
- `swypik-kernel/tests/host_core_test.c:210-245` covers zero length, `UINT64_MAX` wrapping, invalid IRQ/config/control ranges and forbidden overlap.

No E-2 defect reproduced.

---

## E-3 — VERIFIED — canonical wire reserved/padding bytes are rejected

### Source evidence

- `swypik-kernel/src/core/device_graph.c:432-434` rejects nonzero header reserved bytes.
- `swypik-kernel/src/core/device_graph.c:452-456` rejects nonzero node reserved/padding bytes plus noncanonical strings.
- `swypik-kernel/src/core/device_graph.c:461-465` rejects nonzero resource reserved bytes.
- `swypik-kernel/src/core/device_graph.c:475-479` rejects nonzero edge reserved bytes.
- `swypik-kernel/tests/host_core_test.c:194-208` mutates each reserved region and expects decode failure.

No E-3 defect reproduced.

---

## E-4 — VERIFIED — generation exhaustion permanently retires the slot

### Source evidence

- `swypik-kernel/src/core/capability.c:65-84` never mints from a retired slot and retires any free slot whose generation is zero.
- `swypik-kernel/src/core/capability.c:113-134` retires a slot permanently when generation reaches `UINT32_MAX`; it does not wrap generation back to 1.
- `swypik-kernel/tests/host_core_test.c:60-85` sets a slot directly to the near-wrap terminal generation, revokes it, verifies retirement, mints from another slot and confirms the ancient handle remains stale.

No E-4 defect reproduced.

---

## E-5 — VERIFIED — IPC validates sender and receiver authority at the boundary

### Source evidence

- `swypik-kernel/src/core/ipc.c:26-43` authorizes an IPC endpoint operation through capability lookup and additionally requires the capability object to name the exact endpoint.
- `swypik-kernel/src/core/ipc.c:45-68` requires sender capability + sender domain + lease fence + SEND right before enqueue and overwrites caller-provided `message.sender_capability` with the authenticated handle.
- `swypik-kernel/src/core/ipc.c:70-90` requires receiver capability + receiver domain + lease fence + RECEIVE right before dequeue.
- `swypik-kernel/tests/host_core_test.c:87-140` covers wrong domain, wrong fence, wrong right, revoked capability, forged handle, wrong endpoint and queue bound behavior.

No E-5 defect reproduced.

---

## E-6 — VERIFIED — parent/hierarchical topology self/duplicate/cycle cases rejected

### Source evidence

- `swypik-kernel/src/core/device_graph.c:143-180` performs bounded cycle detection across the documented hierarchy: `parent_id` plus `SWYP_DEVICE_EDGE_CONTAINS`.
- `swypik-kernel/src/core/device_graph.c:188-200` rejects self-parent when adding nodes.
- `swypik-kernel/src/core/device_graph.c:221-243` rejects self edges, duplicate edges and a newly introduced hierarchy cycle.
- `swypik-kernel/src/core/device_graph.c:245-305` revalidates parent existence/self-reference, duplicate edges and hierarchy acyclicity for decoded or externally populated graphs.
- `swypik-kernel/tests/host_core_test.c:247-275` covers duplicate/self/cyclic topology cases and parent cycles.

The implementation matches the documented M1 semantics in `KERNEL_SEED.md:50`: only `parent_id` and `CONTAINS` are hierarchical; other edge kinds are directed association edges.

No E-6 defect reproduced.

---

## Integer overflow / length arithmetic review

No introduced exploitable overflow/length arithmetic defect was found in the repaired paths.

- DeviceGraph decode bounds node/resource/edge counts before expected-size arithmetic: `swypik-kernel/src/core/device_graph.c:435-444`.
- The bounded maxima are 32 nodes, 64 resources and 64 edges, so the subsequent `size_t` wire-size arithmetic is far below overflow range on the supported 64-bit contracts.
- Resource interval end arithmetic is reached only after kind-specific no-wrap validation: `swypik-kernel/src/core/device_graph.c:95-120`.
- IPC queue indices use a fixed capacity of 8 with modulo arithmetic and explicit full/empty checks: `swypik-kernel/src/core/ipc.c:59-66,82-88`.
- Capability slot index is bounded by `SWYP_CAPABILITY_TABLE_CAPACITY` before table access: `swypik-kernel/src/core/capability.c:7-15`.
- UEFI memory-map division rejects zero descriptor size before computing entry count: `swypik-kernel/src/boot/uefi_x86_64.c:55-80`.

---

## Candidate E required command results

### Reproducible build #1

`powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1`

**PASS**, exit 0.

Observed:
- `swypik-kernel host core tests: PASS`
- architecture contract compile checks completed;
- PE inspection completed;
- `swypik-kernel build: PASS`;
- QEMU unavailable message emitted;
- SHA-256:
  `806ced9eb25d844518e38cabc4216088dde9af5dac5c33582343eb785652b946`.

### Reproducible build #2

Same command.

**PASS**, exit 0.

SHA-256 again:
`806ced9eb25d844518e38cabc4216088dde9af5dac5c33582343eb785652b946`.

**Build hashes are identical.**

### PE/EFI inspection

`objdump -x out\efi\BOOTX64.EFI`

**PASS as structural inspection**, exit 0.

Observed:
- file format: `pei-x86-64`;
- architecture: `i386:x86-64`;
- PE magic: `020b (PE32+)`;
- entrypoint RVA: `0x1000`;
- subsystem: `0x0a (EFI application)`;
- no `DLL Name:` import entries;
- Base Relocation Directory is zero-sized;
- PE Characteristics still include `DLL`, consistent with the current MinGW `-shared` link method.

The zero relocation directory and PE `DLL` characteristic remain structural observations, not a boot-success claim. Actual firmware loader acceptance is not verified on this workstation.

### Diff check

`git diff --check`

**PASS**, exit 0, no output.

**Candidate E verdict: VERIFIED.**  
**Real x86_64 firmware/QEMU boot execution status: BLOCKED (QEMU absent).**

---

# Final QA conclusion

- **Candidate D — VERIFIED**
- **Candidate E — VERIFIED**
- **E runtime boot evidence — BLOCKED only; no boot success claimed**
- **No source repairs performed**
- **No commit, push or deploy performed**

The required build regenerated only `swypik-kernel/out/` artifacts. No source file was intentionally written by this QA. The only intentional QA file write is this report.
