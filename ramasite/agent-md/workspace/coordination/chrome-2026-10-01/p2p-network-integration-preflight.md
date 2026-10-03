# P2P network integration preflight — 2026-10-01

Read-only product review, observed 14:00 UTC; HEAD `06a5f39f805cf36897e05ffe306d05ed212a5a3a`.
Only this report was written. No builds/tests/models/network probes/private artifacts were consumed.

## Actual call map and evidence
- `swypik-os/mobile/bridge/bridge.go:28` constructs `swarm.NewDaemon`; its `GetSwarmStatus` only reads status, not training.
- `core/swarm/swarm.go:223` → `ExecuteTrainingMicroBatchContext:230` → governor.Run → `LocalTrainer.ComputeMicroBatch:264`; this is the only non-test compute caller found in core/cmd/mobile. No production caller of either ExecuteTrainingMicroBatch wrapper was found there.
- `core/federated/federated.go:125–176` creates random parameter noise, multiplies claimed loss by .985, claims synthetic TFLOPS, then signs. No canonical IMC forward/backward pass executes on this path.
- `federated.go:253` VerifyProofOfCompute → CalculateProofHash:229; `SubmitDelta:340` calls it after signature verification. It proves payload consistency, not performed compute, CE quality, or spent energy.
- `RegisterNodeKey:305` overwrites a node's key without a network membership/rotation authenticator. SubmitDelta:319 bounds finite vectors, round/layer, pending count and norm; AggregateRound:388 averages Go float64 vectors and claimed loss into a toy ModelCheckpoint.
- SubmitDelta/AggregateRound/NewTransportMesh callers found in this closure are tests only. `core/federated/diloco.go:87` does genuine bounded SGD on supplied gradients, but does not compute gradients; StepInner/ComputeOuterPseudoGradient callers found are tests only.
- `core/federated/transport.go:57` NewTransportMesh creates bounded in-memory peer/inspection structures; RegisterPeer:82 trusts local registrations. HELLO/STUN/gradient message names and endpoint fields do not implement discovery, NAT traversal or authentication.
- BroadcastGradient:116 hashes the delta into an inspection queue and **returns 0/error at :147: no network transport configured**. No socket delivery exists in this traced mesh closure.
- `core/hive/hive.go:111` selects a node from declared local metrics; OffloadTask:143 records routing, returns ErrNoTransport and NOT_EXECUTED. It is not a second operational transport to connect to.
- `core/network/status.go:38` inventories host interfaces with Internet=not_tested. Swarm.startWorker:280 parks until stop; GetStatus:388 reports MeshNodes/LatencyMs=0. Device HAL discovery is not peer discovery.
- `cmd/imc-peer-probe/main.go:229` signedDemo instead uses two owned JSONL children: evaluator prepare → issuedBinding:188 → dedicated-pipe public-key registration → signed proposal → checkIssued:212 → independent signed evaluation → local adopt/rollback. It does not call the mesh/simulator.
- `ilaria/runtime/isxprobe/peer.py:204` propose uses canonical ImcTransformer/AdamW; evaluate:231 applies the validated delta once through canonical collective_sleep.consolidate and independent CE/anchors. model:148 reconstructs the fixed seeded initial model, not the current active parent; serve:270 is one local operation, not a continuous round worker.
- Canonical wire is `ilaria/specs/myriad.swyp:119` IMCLocalProbeEnvelope, generated identically into both products. `runtime/isxprobe/contract.go:27` binds all 13 issued identities to Ed25519/canonical bytes/raw hash/deadline; Python verify_candidate:78 additionally validates tensor layout/finite/norm before model allocation. Expected identities originate from evaluator preparation and OS authority, never proposer self-description.

## Missing requirements; what the next job must actually establish
- There is no implemented peer discovery/auth/routing transport to merely switch on. Extend the existing TransportMesh seam; do not create a competing peer registry or a second standalone P2P server.
- Network identity must bind pinned peer ID/key to an authenticated endpoint/session before enrollment or work. Ephemeral key registration on an owned local pipe cannot authenticate a remote peer; unknown identities, aliasing and unauthenticated rotation must fail closed.
- Initial explicit pinned endpoints and mutual challenge/session authentication are a bounded bootstrap discovery mechanism, not Internet discovery. Admission quotas constrain an allowlisted pilot; they do not solve open-membership Sybil resistance, identity revocation propagation, NAT/relay or routing convergence.
- Local opt_in/epoch and kernel executor fencing exist in the fixture. Network use additionally needs OS-issued dataset scope/allowed purpose, local participation consent, revocation while work is pending, no private samples on wire, and live rechecks before dispatch and commit. A curriculum hash alone proves no data-use permission.
- Continuous rounds need an issued **current_parent_checkpoint_hash**, lineage/session ID, monotonic round sequence, fresh nonce/lease, exact config/recipe/data identities and policy hash. Preserve genesis identity separately; never silently reinterpret genesis_checkpoint_hash as a changing parent.
- The active Ilaria model must train/evaluate from the issued current parent. The accepted candidate becomes the next parent; reject/rollback preserves the prior parent. A fresh random seed per round or forced rollback after every accepted candidate would not establish continuous learning.
- One OS writer per expert must CAS the expected parent, reserve replay identity durably before dispatch, validate the current fence/consent before adoption, and correlate an independent evaluation receipt. Crash/restart reconciles uncertain publication without reapplying a delta. Kernel intent APIs already provide the authority journal; do not import Worker5's private supervisor ledger implementation.
- Signed deltas are provenance, not proof of honest computation or universal quality. Independent holdout/anchors and policy-bound acceptance remain mandatory; no reward from self-reported loss/TFLOPS, and no OS reimplementation of IMC or optimizers.
- One negotiated wire ceiling must cover network and child frames. Current Go envelope maximum is 9 MiB, but Python/local demo uses 256 KiB; use the smaller explicit pilot cap, reject before allocation, and account for base64 overhead. No 1B model snapshot may be silently shoved into that pilot frame.
- Transport needs bounded peers/queues/inflight work/read/write deadlines/byte rates, backpressure, disconnect cleanup and cancellation. Child containment is planprocess.Group, not GOMEMLIMIT alone; network listener/Go host memory also needs its own accounting.

## Smallest coherent NEXT IMPLEMENTATION (requires ownership allocation)
1. Add a versioned network-round contract to **existing Myriad** and regenerate its manifest/Go mirrors. Keep frozen local-v1 semantics compatible; new issued/current-parent/receipt fields must participate in the same canonical signature/hash contract. No new isx_probe schema or copied tensor validator.
2. Attach one bounded authenticated socket implementation to TransportMesh, using its existing peer table and resource policy. For the first actual network gate, use two distinct OS node processes with explicit loopback endpoints/pinned public identities; no claimed QUIC/WebRTC/NAT support. Only enrolled sessions become routable peers. Extend the existing transport's interfaces rather than adding another server in the probe CLI.
3. Extract the existing probe's OS authority/composition logic into a small OS adapter. It issues contracts, owns socket IO, starts explicitly configured Ilaria workers via Group, persists kernel intent/replay/publication metadata, and delegates all tensor/quality work to Ilaria. The probe command becomes a thin composition entry; its old single-round demo remains a regression.
4. Extend the existing Ilaria peer adapter to accept an authorized parent snapshot/reference and a bounded request loop. Reuse canonical IMC + collective_sleep and existing verification; do not edit Forge/trainer or create an OS model. An authenticated remote candidate is independently evaluated against the OS-issued current parent before any adoption.
5. Inject this adapter into Swarm via a typed `RunRound(ctx, issuedContract) -> verifiedReceipt` seam. Replace the simulator call on the real contribution path; do not cast full typed float32 IMC deltas into legacy float64/LoRA-only WeightDelta. The legacy microbatch API must fail closed on the real path or remain explicitly simulation-only, with no contribution/reward claim. Idle/disabled nodes remain parked; authorized opt-in runs successive rounds until canceled/revoked/budget exhausted.

Proposed exact write claims (19; request explicit handoff/baseline first, not permission inferred from this report):
- `ilaria/specs/myriad.swyp`; `ilaria/specs/myriad.manifest.json`; `ilaria/generated/myriad/types_gen.go`; `swypik-os/generated/myriad/types_gen.go`.
- `ilaria/runtime/isxprobe/contract.go`; `ilaria/runtime/isxprobe/contract_test.go`; `ilaria/runtime/isxprobe/peer.py`; `ilaria/runtime/isxprobe/test_peer.py`.
- `swypik-os/core/federated/transport.go`; NEW `swypik-os/core/federated/transport_socket.go`; NEW `swypik-os/core/federated/transport_socket_test.go`.
- `swypik-os/core/swarm/swarm.go`; `swypik-os/core/swarm/swarm_test.go`; NEW `swypik-os/core/imcnetwork/adapter.go`; NEW `swypik-os/core/imcnetwork/adapter_test.go`.
- `swypik-os/cmd/imc-peer-probe/main.go`; `swypik-os/cmd/imc-peer-probe/main_test.go`; NEW `scripts/verify-imc-network.py`; NEW `swypik-os/docs/audit/imc-network-rounds.md`.
Read-only dependencies: canonical Forge IMC/sleep APIs, ControlKernel, planprocess.Group/process, resource.Policy; no federated.go/diloco.go, Forge/trainer/model-weight edits and no mobile changes required for this first slice.

## Ownership and acceptance boundary
- Worker5 is RUNNING in its ownership report; no confirmed integrator release exists. Reserved OS `cmd/plan-supervisor/{config.go,engine.go,engine_test.go,main.go,wire.go,plan_cache.go,plan_cache_test.go,energy_metrics.go}`, core/plancache, core/supervisor, core/resource/energy*, generated/swypcontinuation and generated/swypeffects/protocol.go must remain untouched.
- Worker5 also reserves Swyp broker/continuation execution/protocol files and root v3 gates/CI. Routing this through its CLI, private ledger/cache, continuation or energy metric internals is a conflict, not a timeout-based handoff. Alternative: public ControlKernel/Group/resource APIs plus the new injected adapter above; reusing the v3 CLI later requires explicit release.
- Current worker reports do not prove Worker5 owns core/swarm or core/federated files; coordinator still protects old swarm claims and this task explicitly forbids their edits. Root must establish/release those exact seams before assigning the proposed writes. Frozen OC3 local-P2P claims likewise require an explicit next-job reopening, not silent edits.
- Baseline is the independently accepted Main local fixture (acceptance report SHA `42c574f090bd2f9eaf0450993b594125b3f0517ef26bc5e13ad735755ed2359e`): 74 canonical/peer/sleep pytest; Ilaria/OS vet+tests; generated Myriad equality; real two-child adopt/rollback+replay. These are prior local gates, **not new network PASS**; no gates rerun in this preflight.
- Preserve targeted regressions: TestPhoneTransportBoundsResidentPeersAndInspectionQueue, TestRegressionK4PeerReputationRetention/PeerCopySafetyAndDataRace, TestSwarmEnabledIdleDoesNoSyntheticCompute/StoppedSwarmCannotRestartAdaptiveMonitor/SwarmAcceptsInjectedResourceAuthorityWithoutOwningItsLifecycle, TestSignedMetadataRawBytes, TestReviewIssuedContractValidResignAndPortableArgs and TestReplayLedgerRestartAndAtomicCrashRollback.
- New acceptance must launch **two distinct OS node PIDs on an actual socket**, report negotiated identities/endpoints and sent/received byte counts (not inspection queue writes), and perform at least two accepted parent-linked rounds plus a rejected candidate. Next issued parent must equal the last committed candidate; wrong parent/recipe/identity/consent/fence/deadline, malformed/oversize/nonfinite, quality regression and replay must not mutate active state.
- Prove durable replay rejection after host/worker restart; crash before/after publication with deterministic reconciliation/rollback; disconnect/cancel/revoke/backpressure cleanup without duplicate application. No simply reporting attempted work as accepted/delivered. Explicit per-host bytes/rounds/time/child counts, actual worker CPU and peak RSS, and idle CPU evidence must accompany the socket run.
- Run affected Go packages with `GOWORK=off go test -count=1 -timeout 180s` and vet (including -race where available), the 74 existing Python gates plus new network/current-parent regressions, schema regeneration comparison and diff-check. Full unchanged Swyp/kernel gates add no evidence for this network slice.
- Existing Windows Group sets Job memory/active-process/CPU hard caps, assigns suspended children before resume, kills descendants on close. Current local fixture configured 1 GiB / 25% host CPU / 2 children; peak RSS was not measured. Linux requires a genuinely delegated cgroup-v2 root or refuses. Do not claim those settings bound the Go network hosts themselves.
- Current demonstrated model is a synthetic seeded 16-token IMC on Windows, one local round followed by rollback. This next slice establishes real transport and persistent parent-linked rounds, not IMC-1B/Internet/mobile/hardware/Sybil immunity, IlariaLex training, production-scale streaming snapshots, energy savings or superiority. Progress beyond the pilot must subsequently use an authorized real curriculum/scale gate; more fixture variants alone do not achieve the continuous-network goal.

## Observed public-source SHA256 (relative to E:\nexus)
| Source | SHA256 |
|---|---|
| swypik-os/core/federated/transport.go | 471dfa5b9230c492b8c7e76996efb8ad766f71179499f077dba5151a000d8470 |
| swypik-os/core/federated/federated.go | 731435d597e9a9ed641a3100cc04c62f7d3b62d22e0646aaed40c67cdb34f4ce |
| swypik-os/core/federated/diloco.go | 7adcbe64f06971869defcd1bcb8d75ea36b49384d747b9bca127785b3b9ac254 |
| swypik-os/core/swarm/swarm.go | bfd68000aa69811975fdea44ce50411edad80a9b007f8eeb6adca75ef3d5d069 |
| swypik-os/core/hive/hive.go | e0eb46fdd23b1d5dadfea6870dc7f13f4492dcd3688fdcb2117a823a16249d97 |
| swypik-os/core/network/status.go | 1d934e41a20175505de1067ba992d3a2113e6d9165250eb7927fe86e9e71f017 |
| swypik-os/mobile/bridge/bridge.go | f69068459d99e7bf45f4b35489a409beae59a3404f31b659056d21b7eb8e47aa |
| swypik-os/core/controlkernel/executor.go | 09131b71c444ca3b8d708c0429caa117b684e0c43ef7a6989b984ea917ff2ecd |
| swypik-os/core/controlkernel/kernel.go | cd44569d5bd3b27804c3b4a1a351b84716e96761b7c911e37f01be319143f028 |
| swypik-os/core/resource/policy.go | d312c77f38f09095e18d8b22c5bfe6c1a48fa9f51837186c4242be8ddd73a423 |
| swypik-os/internal/planprocess/process.go | 153cb4215f2f0ef5ab0208a5aff199814614a62b6ff6395641a40ee7be9be32a |
| swypik-os/internal/planprocess/group.go | d857a87ae7eabf6be47f2dc9ec7605b72b71481d1b426d0e3969c01c1e8fad3f |
| swypik-os/internal/planprocess/group_windows.go | eba72eeeb4f010a9205079820b46ef565ae838d12bee44f066c643c0f2b394ed |
| swypik-os/internal/planprocess/group_linux.go | 65265b0d4229cfd3fb5b47da9bfcc363f80439d9d50fbd824a68c4c9908fb49b |
| swypik-os/cmd/imc-peer-probe/main.go | 0408c13d2a6d68474367203e49c8a1c058870ff10a66c9bd462bc9266ec752f0 |
| ilaria/runtime/isxprobe/contract.go | 8d401732299e9779985aaa3e78f41a4ca2a7c324ff97e2efce466accda3fa756 |
| ilaria/runtime/isxprobe/peer.py | e657632cbaa2b2e7738529c3ecb93ade41958de5fe50be5d345f1be6feafa06e |
| ilaria/specs/myriad.swyp | bbed71836741ce742a3a53a858b9608dca88791eb927aaed2037ead609356421 |
| ilaria/generated/myriad/types_gen.go | 0ca37f338e517b2a7ade6357dd553dc5edfc85232beb037eac885ba2b9490a74 |
| swypik-os/generated/myriad/types_gen.go | 0ca37f338e517b2a7ade6357dd553dc5edfc85232beb037eac885ba2b9490a74 |
| docs/coordination/chrome-2026-10-01/worker-5.md | 1d8029544feaf0c6cb571c368882ea048c52727992e7f90df6309e24fc1dac12 |
| ilaria/runtime/isxprobe/contract_test.go | 5546186c6b60386d384fc60722661e3d8892f4af7152bdb7abc5bb0bef3aaa9d |
| ilaria/runtime/isxprobe/test_peer.py | 61da4eeaa6db5efa5ae648d77f81cd765716d3a23b0c491a8699c8778d11c880 |
| swypik-os/core/federated/resource_test.go | ce73f1a03c3fd237126ca19b953db794b8f266c8d4394a038aacbc9ea4530471 |
| swypik-os/core/federated/k3_k4_regression_test.go | be149670a4205b9e1b302c1ddc4f151f089e723e00aace0837b62ea15b96ada2 |
| swypik-os/core/swarm/swarm_test.go | 999f93a2ac0abdd7179b8525c66fff307c707882694b06a39aa07ba608ac4c47 |
| swypik-os/cmd/imc-peer-probe/main_test.go | 5588b60f544426970d1f2e0024767ef295269c714ad69d357c0f845f5d5179c6 |
