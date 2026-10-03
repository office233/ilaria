# SWOS M1 — Compute Fabric v1

WORKTREE EXCLUSIV: E:\CEO\wt\swos-compute-fabric-m1
BASE istoric: f0b244a. EXISTĂ deja cod untracked în swypik-os\core\computefabric; inspectează-l și continuă-l, nu-l șterge orbește.
Nu lucra în E:\nexus main.

Citește:
- E:\CEO\specs\mission-swypikos-ilaria.md
- E:\CEO\projects\swos\analysis\07-owner-correction-os-compute.md
- E:\CEO\projects\swos\analysis\10-compute-fabric-v1.md
- E:\CEO\projects\swos\analysis\08-universal-native-ai-install.md
- E:\CEO\wt\swos-compute-fabric-m1\AGENTS.md
- swypik-os/docs/ILARIA_COMPUTE.md
- codul live core/computefabric existent

OWNER GOAL: utilizatorii SwypikOS contribuie voluntar GPU/CPU/NPU idle; compute-ul trebuie să fie util și verificat, zero crypto/mining.

Construiește un M1 real, self-contained, fără cloud vendor lock-in:
1. DeviceIdentity/PublicKey + CapabilityProfile (CPU/GPU/NPU, VRAM/RAM, runtime/driver, measured throughput, thermal/power/network class).
2. ConsentPolicy: off by default, idle-only, AC/battery, max power/GPU %, temp, VRAM, bandwidth, schedule, immediate revoke/yield.
3. Signed JobManifest v1: job id/type, input/checkpoint hashes, artifact hashes, required capabilities, resource limits, deadline, verifier policy, output contract.
4. Lease lifecycle: OFFERED/LEASED/RUNNING/CHECKPOINTED/SUBMITTED/VERIFIED/ACCEPTED/REJECTED/EXPIRED/REVOKED; heartbeats, expiry, idempotency/exactly-once acceptance.
5. Content-addressed ArtifactRef.
6. Worker-side admission function: hardware/policy compatibility, no arbitrary code beyond signed bundle/known runtime profile.
7. ResultEnvelope signed by device identity and bound to lease+job+input+checkpoint+output hashes.
8. Independent verification policy:
   - replication groups;
   - spot-check/gold jobs;
   - exact/deterministic vs tolerance classes;
   - robust aggregate interface;
   - contributor result never trusted just because signature is valid.
9. Coordinator core in-memory/reference implementation with deterministic tests; persistence interface separated for M2.
10. Workload classes: eval, synthetic validation, LoRA/adapters, distillation, embedding/index, search experiment, batch inference. Full training only as declared workload profile.
11. Zero crypto/reward/token semantics in new package.
12. Tests: forged signature, expired lease, duplicate result, replay under new lease, revoke during run, policy mismatch, hardware mismatch, invalid artifact hash, acceptance exactly once, Byzantine/outlier handling contract.

Scope write:
- swypik-os/core/computefabric/**
- optional swypik-os/cmd/swypik-compute-sim/**
- docs/COMPUTE_FABRIC_V1.md only.

Gemini: dacă provider_status spune Antigravity/Gemini 3.8 Flash available, poți folosi MAX 5 read-only subagents pentru protocol/security/federated-learning critique și adversarial tests. Tu ești singurul autor.

Final: gofmt; go test -count=1 -race ./core/computefabric; go vet ./...; go test -count=1 -timeout 180s ./...; git diff --check.
No commit/push/deploy.