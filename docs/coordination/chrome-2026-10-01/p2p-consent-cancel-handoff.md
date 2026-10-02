# P2P consent cancellation source handoff

Owner: `/root/p2p_independent_acceptance`. Worktree:
`C:\Users\abel\.codex\worktrees\p2p-resume-genesis-fix\nexus`.
Status: SOURCE_READY / STOP, 2026-10-02 02:03 UTC.
This is a new cancellation scope; the accepted prior rollback/restart proof is
preserved and was not repeated.

## Exact source claims

- `swypik-os/core/imcnetwork/adapter.go`:
  `b09170b0385c0d6c2881728a2d939d4ae5e2809a5df909ba2d822528f46da4d8`.
- New `swypik-os/core/imcnetwork/consent_monitor_test.go`:
  `3285d4e60259456532bbc5450737933ed2bde2614f08a1c2f28b50c431ae7cdf`.
- New `docs/coordination/chrome-2026-10-01/p2p-consent-cancel-handoff.md`:
  hash supplied separately after saving.

Baseline adapter was `4f1bc3b232fd7232b6ef77d5483037dbda53a1b91230fd990a7e23914bc544e5`.
The initial consent snapshot DE2E55 was not integrated: root identified lost
first Close errors and callback cleanup failures. This revision preserves both;
the original external evidence remains intact and is superseded for acceptance.
The three existing adapter/authority/rollback test files, transport, process and
Group sources are unchanged. No Main/index edits, runner changes, model/runtime
changes, stage/commit/push, secrets, private profiles, corpus, ignored weights,
Bridge, GPU, paid work or actual model/TCP trial by this owner.

## Behavior and lifecycle

NodeConfig gains optional `consent_poll_ms`. Omitted/zero selects 100 ms;
explicit values must be 10..1000 ms. Invalid policy is refused before sockets or
worker allocation. Each peer watches its own existing explicit state directory.
No authority, cryptography or peer protocol fields are added.

Public RunNode enters one monitored scope and gives its linked context to the
existing node body. Initial consent must pass before the body is called. Missing,
malformed, false opt-in, changed epoch, scope or purpose cancels that context.
Consent remains epoch exactly 1, scope synthetic-public-v1 and purpose
local-network-training. Cancellation is latched; restoring the file cannot
restart this node. A new explicit caller is required for later participation.

The existing socket Accept/Send/Receive and process adapter already respond to
context cancellation. The node now also binds its owned Group.Close directly to
context cancellation, after its sole Group.Start has completed. This ordering
avoids racing platform activation. Job termination does not wait for an executor
callback to return. The joiner returns the cached first Close outcome. It closes
exactly once on normal return too; repeated joins retain that same result. The
private Close-only interface permits discriminating error injection, not new
process authority. No planprocess implementation is changed.

The node body has a named error result and one deferred Group cleanup owner.
Before Start this owner is Group.Close; after Start it becomes the joined
cancellation closer. Worker.Close runs first on normal return, preserving the
previous healthy completion order. Startup failure, asynchronous cancellation
and normal cleanup all propagate the first Close failure. A later no-op Close
cannot replace it with nil. Worker cleanup errors are also joined. The consent
watcher is canceled/joined, then returns the initial cancellation cause joined
with callback/deferred cleanup errors. errors.Is retains each cause. Parent
deadline or prior parent cause remains distinct from consent refusal. A cleanup
error produces failure; it is never evidence that an owned process stopped.

The host's initial 100 ms idle sample now waits with the same cancelable context.
Existing synchronous consent checks before dispatch, sends and publication stay
in place. Signature, committed ancestry, sequence/lineage, recovery and replay
rules are unchanged. Watching does not replace any admission or effect guard.

## Verification

- Eleven new test functions cover policy defaults/bounds; six injected blocking
  wait revocations; healthy returns and joined watcher scopes; initial refusal;
  stable parent causes plus callback/Close errors; latched cancellation against
  a real prepared rollback intent; once-only cached normal/error joins; healthy
  owned protocol completion; actual trusted children; and production wiring.
- The trusted child is the current Go test binary, selected through explicit
  arguments and the existing scrubbed process adapter. It starts an owned
  descendant, performs CPU work, and would emit a late contribution if allowed
  to finish. Windows Job limits are real, with two processes and 256 MiB.
- Active work, blocked authenticated socket Receive, a deliberately held node
  callback, and real parent deadline all terminate/reap the owned leader, stop
  the descendant heartbeat and emit no late contribution. No model is loaded.
- Final focused tests PASS, 2.427 seconds. With a 20 ms watch, observed stop/join
  was 13.564 ms for active-work revocation and 22.973 ms for blocked Receive.
  Parent deadline cleanup was 1.308 ms after its actual deadline. The held
  callback test intentionally keeps its callback alive for two 40 ms heartbeat
  checks while proving the Job terminates before callback defers can run.
- A real prepared rollback intent remains PREPARED with unchanged active
  checkpoint, progress/sequence/lineage and no pending publication after
  observed cancellation, even when the file is subsequently restored.
- Actual owned Job cancellation with an injected reported Close failure retains
  consent cause, callback failure and Close error while separately checking
  leader reap/descendant halt. Real healthy protocol completion and expected
  root exit PASS without being converted to cleanup failure.
- Full affected OS tests PASS, `go test -count=1 -timeout 180s ./...`, 31.036
  seconds: 48 passing packages, 7 without tests; imcnetwork 6.861 seconds.
  Full `go vet ./...` PASS, 1.856 seconds.
- External snapshots provide behavioral RED: suppressing linked monitor
  cancellation fails the 400 ms injected-wait bound; suppressing direct Job
  cancellation leaves the descendant active while its node callback is held.
  Discarding first Close errors is RED on both canceled and normal joins.
  Returning cancellation cause alone is RED for dropped callback/cleanup errors.
  Shared source was not mutated for RED. Actual trials must use plain source.
- Standard and no-index whitespace results and protected source pins are in
  the final receipt. No-index exit 1 with empty diagnostics means new-file
  content differs, not a whitespace failure.

Evidence folder:
`E:\nexus-training\evidence\p2p-consent-cancel-20261002\owner-gates-cleanup-errors`.
The preceding `owner-gates` directory is preserved as historical evidence.
Race instrumentation is unavailable in this host toolchain (CGO_ENABLED=0,
no gcc executable found); it is not claimed as a passed gate.

## One bounded actual plan, pending root approval

Root will own one separately bounded healthy Main rollback/restart trial after
integration to check this new wrapper/deferred cleanup against canonical model
protocol completion. The source owner does not run it. The active-model
revocation plan below remains separate and requires root approval.

1. Root or its runner owner pins these exact source hashes and the unchanged
   canonical IMC/CLI closure, then creates one fresh external synthetic state
   and evidence directory. No overlay or historical state mutation is used.
2. Run the existing issuer/proposer CLI pair with the current signed recipe and
   both local policies consent_poll_ms=50. Use only CPU synthetic data, explicit
   existing Job/traffic limits, an absolute 115-second deadline and 10 seconds
   reserved for cleanup. Use sufficiently many bounded steps to observe active
   work; stay inside the existing maximum 64 steps.
3. Observe the owned proposer PID and its owned worker PID, without reading
   process command lines or unrelated processes. Wait for the fresh durable
   work reservation and an increase in that owned worker's CPU counter across
   two samples. Record scalar active/progress hashes before revocation.
4. Atomically replace only this fresh peer's consent with opt_in=false while
   preserving its declared scope/purpose/epoch. Record write completion time.
   Expect a distinct consent-canceled cause and peer connection refusal/EOF,
   with no subsequent adopted progress or contribution. Record node/owned worker
   exit and final scalar progress/active/pending metadata. Do not read tensors.
5. Require all known owned processes to be absent within the runner's fixed
   cleanup bound. Never infer success from expiry alone. If active work cannot
   be observed, publication is uncertain, or a process remains, record FAIL or
   UNPROVED and stop. No second trial or integration is implied by this plan.

The source owner has not executed this plan. Root must approve the concrete
runner operation and own any additional runner claim before execution.

## Limits

Polling bounds the interval between checks; Windows scheduling and filesystem
latency are not a hard real-time guarantee. A file transition reverted between
checks can be missed; observed cancellation is irrevocable for this node.
Existing before-effect checks still protect the publication boundary, which is
not made atomic with local file writes. An arbitrary callback can delay returning,
although owned Job termination is independent of that callback's return.
The owned-child/transport tests do not establish cancellation during canonical
model training, internet/two-machine behavior, mobile contribution or power-loss
durability. This is an OS lifecycle fix, not new model or permission authority.
The broader Nexus objective remains active; paid work remains blocked under the
existing expired budget window and guard policy.
