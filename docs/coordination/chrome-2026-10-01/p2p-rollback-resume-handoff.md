# P2P rollback/restart source handoff

Owner: `/root/p2p_independent_acceptance`. Source freeze: 2026-10-02 01:00 UTC.
Worktree: `C:\Users\abel\.codex\worktrees\p2p-resume-genesis-fix\nexus`.
Status: SOURCE_READY / STOP. The independent actual completed linked rounds
1/2/reject 3 and signed rollback 4, then failed at resumed commit 5 because the
same checkpoint bytes recurred. This revision fixes that event-index collision;
the subsequent actual rollback→restart proof remains assigned to the runner.

## Exclusive claims and hashes

- `swypik-os/core/imcnetwork/adapter.go`:
  `4f1bc3b232fd7232b6ef77d5483037dbda53a1b91230fd990a7e23914bc544e5`.
- New `swypik-os/core/imcnetwork/rollback_resume_test.go`:
  `645aa9229ebe4bea1b786e8df01a3975598ca7d4b65df0e1d274bf038f591638`.
- New `docs/coordination/chrome-2026-10-01/p2p-rollback-resume-handoff.md`:
  hash supplied separately after saving.

No Main edits, index changes, stage/commit/push, runtime/schema edits, corpus,
ignored weights, private data, Bridge, GPU, paid jobs, or actual TCP pilot by
this owner. Root prepared the public dependency baseline before authorizing
edits. Root independently confirmed all 299 protected Main pins plus HEAD,
branch, index and staged state remain unchanged.

## Behavior and authority

Both authenticated peers agree the bounded mode before issuer genesis/model
allocation: control envelope version 1, operation `pilot-mode`, matching rounds,
resume and rollback flags. `rollback_at_end=true` is required on BOTH peers.
The proposer remains connected for exactly one rollback notification and ACK.

The issuer consumes a new global sequence, node, lease and
`synthetic-model-rollback` intent. For the two-round pilot: accepted rounds 1/2,
rejected round 3, rollback 4, then independent resumed rounds 5/6/reject 7.
Rollback selects the preceding accepted checkpoint, using a retained immutable
commit event version, the exact known history, a real COMMITTED normal-publication
intent, and immutable checkpoint bytes. Existing checkpoint files or local
history alone cannot grant rollback authority. The canonical Ilaria worker only
measures the existing target; rollback does not train or reapply the old delta.

Publication uses the existing Control Kernel prepare/start/result/independent
verification/commit flow with a dedicated lease and exact request/result/fence
bindings. Restoration verification checks policy, ancestor and byte integrity;
it is not a new model-quality evaluation. Context, consent, deadline and live
executor authority are checked before effects. Active/current-parent CAS and
hash checks remain strict.

RunNode's preflight opens/reconciles the journal before sockets or worker/model
allocation. For rollback pending records, exact COMMITTED evidence restores the
After pointer and progress; other outcomes restore Before, retain pending
evidence, and refuse redispatch. Missing/unknown recovery evidence or an
active/progress split without a matching pending transaction remains refused.

## Versioned control metadata

`networkRollbackNotice` compact JSON has ordered keys `certificate,signature`.
The certificate's typed field order is:

`protocol_version,operation,before,after,target,target_intent_key,rollback_intent_key,nonce,consent_epoch,lease_fence,deadline_unix_ms`.

Version is 1; operation is `rollback`. Progress objects use ordered keys
`session,genesis,parent,lineage,sequence`. Version, sequence, consent and fence
are uint64; deadline is int64 Unix milliseconds. Consent epoch remains exactly
1 for this bounded synthetic protocol. The Ed25519 issuer-role signature covers
the exact compact typed certificate bytes; a transport signature cannot replace
it. Identifiers/hashes are ASCII and numbers are integers.

After is exactly Before.sequence+1 with the same session and immutable genesis,
and selects Target.parent. Target is an earlier committed normal publication.
After.lineage is SHA256 of sorted compact JSON:

`{"operation":"rollback-v1","prior_lineage":Before.lineage,"sequence":After.sequence,"target_intent_key":TargetIntentKey,"target_parent":Target.parent}`.

Intent keys are `session + round-N`; rollback's node ID is `round-N` for its
new sequence. RequestHash is SHA256(compact certificate). ResultHash and the
proof's `certificate_hash` are SHA256(full compact signed notice).

Each peer retains identical `rollback-N.json` signed-notice bytes and
`history-N.json` compact progress. Issuer also retains
`committed-N.json`, keyed by global sequence, as immutable commit event metadata.
Checkpoint bytes remain content addressed and may legitimately recur at different
committed sequences with different lineage. Neither event overwrites the other.

At each acceptance the issuer captures the full preceding progress as its target
lookup cutoff. After the batch, lookup selects the highest same-parent committed
sequence at or below that cutoff, within the same session/genesis. Rejected
rounds preserve the parent but cannot become publication authority. The selected
event must equal history[N], match a real COMMITTED normal-publication intent
with exact key/node/external reference/result evidence, and bind its RequestHash
to history[N-1].parent plus the exact forward lineage. There is no fallback from
a selected unjournaled or conflicting event to an older version. Target sequence,
lineage and intent key are then explicit in the existing signed certificate.
Same-sequence metadata conflicts and unversioned hash-keyed legacy records are
refused; this revision does not overwrite or silently migrate them. These are
own synthetic public metadata.

The peer verifies exact preceding progress, issuer role, deadline, ancestor and
explicit rollback lineage before reservation/publication. New rollback consumes
round+nonce reservations. A prior work reservation without the exact retained
rollback certificate is refused. An exact retained certificate permits finishing
partial metadata reservations/progress after a crash, without worker dispatch.

The authenticated transport ACK has operation `rollback-ack`, exact After
progress and `certificate_hash`. Resume sync optionally includes the retained
rollback notice: only exact one-step rollback catch-up or already-identical
progress is accepted. Historical deadline expiry can be ignored for committed
metadata repair, which is separately admitted through signed issuer progress
and authenticated transport; it cannot authorize new training or rollback.
Ordinary resume's existing accepted/rejected lineage check is not weakened.

Issuer proof adds final `progress`, rollback `before/after/notice/sequence`,
`certificate_hash` and the actual kernel intent snapshot (state `COMMITTED`).
`resume_rollback_certificate_hash` is captured before resumed training and remains
the original rollback notice hash in the final resumed proof. Peer proof also
exposes final progress. Runner validates retained public metadata, signatures,
actual parent/quality measurements and independently restarted callers.

Work limits for R=2..8 remain explicit: R+1 training jobs; 2*(R+1)+2 peer
reservations with rollback; R+4 maximum worker commands with rollback. Global
sequence additions and reservation conversion are checked for overflow.

## Validation

- Twelve new test functions cover real committed ancestor journals, independently
  reopened restart, old batch/rollback replay refusal, separate ordinary lineage,
  role/freshness/epoch/sequence/ancestor tampering, consent/intent CAS refusal,
  real child exits before/after commit, partial peer reservation repair, bounded
- Additional regressions commit the exact same immutable checkpoint bytes at
  real journal sequences 2 and 5 across rollback 4, reconcile after CommitIntent,
  reopen independently, select exact ancestor versions by cutoff, refuse
  same-sequence conflicts and unjournaled latest versions, and check the exact
  preceding request binding. Public fixtures are unit-policy evidence, not
  model or network-quality proof.
- Package tests PASS: `go test -count=1 -timeout 180s ./core/imcnetwork`, 5.159s.
- Full affected OS tests PASS: `go test -count=1 -timeout 180s ./...`, 29.918s,
  48 passing packages and 7 packages without tests. Full `go vet ./...` PASS.
- Prior freeze's external pointer-only mutation: behavioral RED in restart with
  the original active/progress mismatch. External mutation treating RESULT as
  COMMITTED: behavioral RED in actual uncertain-crash recovery. Shared source
  was never modified for these RED runs.
- This freeze's external snapshot restores the unsafe hash-addressed immutable
  index alongside sequence records so existing typed reads reach commit 5.
  The new regression is RED after the real CommitIntent with the actual
  `immutable network metadata conflict`; current plain source is GREEN.
  Actual pilot must use no overlay.
- Standard and no-index whitespace checks supplied in the final owner receipt.

Logs and scalar gate receipts:
`E:\nexus-training\evidence\p2p-rollback-resume-20261002\owner-gates-repeated-checkpoint`.

The failed actual receipt is preserved at
`E:\nexus-training\evidence\p2p-rollback-resume-20261002\bounded-tcp-5s1wtbux\receipt.json`,
SHA256 `c3a5215e6401c13caa3cc2791d0ae4adf709c6c857595688deb14791e30377a2`.
It records initial peer agreement and signed rollback success, ordinary replay
denial, and the resumed collision. It is not a successful continuation receipt.

## Limits

This remains a bounded two-peer loopback synthetic prototype. The independent
successful actual rollback→restart continuation is pending at source freeze. Internet, multiple
machines, discovery/Sybil/aggregation, mobile contribution, production-scale
training, generalization, host/build hard caps and energy are not proved.
File/journal fsync and actual process-exit tests do not establish power-loss
directory durability. Consent is checked at admission/publication edges, not
instantaneously during every already-running worker instruction. Uncertain
publication intentionally stops for explicit recovery; no automatic replay.
Rollback requires a retained committed non-genesis ancestor; old state without
the new history/index is not silently migrated or fabricated.

The full user objective remains ACTIVE. Paid work remains blocked by the expired
window and guardReady=false; this source handoff does not alter that authority.
