# Swyp Compute Fabric — community GPU/CPU/NPU contribution

Status: **design only.** This build detects GPUs (`core/compute`) and stores the
user's consent (`settings.json` → `compute`). It runs no training work, earns no
rewards and contacts no coordinator. The previous "swarm/federated" modules
produced random gradients and fake coin balances and are not part of the
desktop.

## Goal

People who install SwypikOS may explicitly contribute idle GPU/CPU/NPU capacity
to Ilaria and other verified Swypik workloads. This is a strategic compute plane,
not a crypto/mining/reward feature.

The first coordinator may run centrally for bootstrap, but the protocol must not
be Azure-locked: later coordinators can be multi-region/federated while preserving
the same signed-job, lease, verification and accounting contracts.

Candidate workloads include evals, synthetic-data validation, adapter/LoRA
training, distillation shards, embedding/index builds, search experiments and
batched inference. Full synchronous training is used only when hardware/network
economics justify it.

## Non-negotiable properties

1. **Explicit consent.** Off by default. Turning it on shows what runs, when
   and what data moves. Revocable at any time; revocation stops work at once.
2. **Only when idle.** Start only when the device is idle, on AC power, below a
   temperature limit and outside user-defined hours. Yield immediately when the
   user returns. Phones participate only while charging on Wi-Fi.
3. **No arbitrary code.** Devices execute signed job bundles only. The
   coordinator's signing key is pinned in the build. The worker runs in a
   restricted process (Job Object with CPU/memory limits; no access to user
   files; network only to the coordinator and blob storage).
4. **No user data leaves the device.** Training data comes from the coordinator.
   Learning from on-device data would be a separate, explicitly-consented
   federated mode with its own privacy review.
5. **Untrusted results.** Any contributor can be faulty or malicious. Nothing a
   device reports is accepted without verification.

## Architecture

```text
Coordinator fabric
  ├─ registry: model versions, checkpoints (Blob Storage, content-addressed)
  ├─ scheduler: shards of training data → leases with deadlines
  ├─ verifier: replication, spot checks, robust aggregation
  └─ ledger: useful verified work per device (only after verification)
Device worker (SwypikOS)
  ├─ consent + idle/thermal/power policy
  ├─ lease client (device identity key, mTLS or signed requests)
  ├─ sandboxed runtime executing signed job bundles on the GPU
  └─ uploader: compressed update + metadata + signature
```

### Protocol sketch

| Call | Purpose |
| --- | --- |
| `POST /v1/workers` | Register device public key and measured capabilities (GPU model, VRAM, measured throughput). |
| `POST /v1/leases` | Ask for work; receive a job manifest: bundle hash + signature, checkpoint hash, data shard hash, hyperparameters, deadline. |
| `POST /v1/leases/{id}/heartbeat` | Keep the lease; a missed heartbeat lets the scheduler reassign it. |
| `PUT /v1/leases/{id}/result` | Upload the update (for example pseudo-gradient deltas), its hash and the device signature. |

All artifacts are addressed by SHA-256 and verified before use.

## Training approach

Consumer GPUs are heterogeneous, frequently offline and connected over slow
links. Methods that synchronize rarely fit this setting: each device performs
many local optimization steps on its shard, then sends a compressed update;
the coordinator aggregates updates into the next checkpoint (outer step).
Large models that do not fit one consumer GPU need pipeline or adapter-based
training (for example low-rank adapters) rather than full-parameter updates.

## Verification (the hard part)

- **Replication:** the same lease is given to k independent devices; results
  must agree within a tolerance before acceptance.
- **Spot checks:** the coordinator re-computes a random sample of leases.
- **Robust aggregation:** trimmed mean or Krum-style filtering limits the effect
  of outliers; the filter never trusts a flag the worker set itself.
- **Reputation:** devices whose results disagree lose weight or are excluded.
- **Signatures:** every result is signed with the device key registered at
  enrollment.

No cryptocurrency, mining or proof-of-work economic mechanism is part of the
design. Any future non-crypto incentive model is a separate product decision and
must never weaken consent, privacy or verification.

## What the desktop shows today

The Calcul tab lists detected NVIDIA GPUs (through `nvidia-smi`), whether the
user permits contribution (`/on`, `/off`), the coordinator URL
(`/coordinator https://…`) and states plainly that no work is running.
