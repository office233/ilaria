# P2P TCP Main acceptance — 2 October 2026

Status: ACCEPTED_LIMITED_SYNTHETIC_TCP_PROTOTYPE_NOT_PRODUCTION.

This is the historical 00:09 UTC acceptance. The subsequent rollback/restart
repair and current Main proof are recorded in p2p-rollback-main-acceptance.md.
Its successful continuation supersedes the rollback gap described below;
the historical receipts and source hashes are preserved.

Exactly 19 reviewed source/test claims were integrated from the dedicated
`codex/p2p-resume-genesis-fix` worktree: 12 existing files and 7 new files.
There was no snapshot overlay. The other 481 protected public inputs, branch,
HEAD and Git index were preserved; staged paths remain zero. The initial Main
test failure and prior candidate receipts remain in the evidence history.

## Result and repaired defects

The canonical tiny IMC performs real backpropagation over synthetic fixtures
through two separate OS processes using authenticated loopback TCP. Rounds 1/2
are accepted, round 3 is rejected, a replay restart is refused before worker
allocation, and new OS/worker processes continue with rounds 4/5 accepted and
round 6 rejected. Both peers persist identical session/genesis/parent/lineage
and sequence. The initial CE is 3.2246127, becomes 2.6398823 after round 2 and
2.2535920 after round 5. These fixture metrics do not establish generalization.

Repairs preserve immutable genesis, persist issuer progress before ACK, bind
publication recovery to the ControlKernel journal, and refuse uncertain
redispatch without reapplying a committed delta. Training remains explicitly
opt-in. Consent is rechecked after network waits and before dispatch/evaluation
and contribution transmission. This is admission checking, not proof of an
instantaneous interrupt during every in-flight computation.

The pilot requires exactly the two pinned issuer/proposer roles. Ordinary ACKs
carry the issuer role signature, and their identity, sequence and parent/lineage
transition are checked before persistence. A transport key alone cannot
authorize progress. Swarm's simulator refuses training contributions and earns
no reward; pre-existing lifecycle configuration and configured-simulator
accounting coverage are retained. No cryptocurrency path was added.

## Verification

- Actual Main TCP proof: 59.854s external wall / 59.672s runner, within 115s
  including a 10s cleanup reserve. All eight spawned children/output threads
  stopped; eleven observed owned PIDs were absent. All 299 Main source pins
  matched at completion and independent root review.
- Main Ilaria: 216 Python tests passed, no skips; canonical three-file
  `py_compile`, Go tests and vet passed. Eleven of twelve passing Go packages
  used the Go cache; four packages had no tests.
- Main SwypikOS: `go test -count=1 -timeout 180s ./...` and `go vet ./...` passed.
  The first Main run caught an old snapshot test assuming default Swarm enable;
  its existing explicit configuration was restored before the final gate.
- Main runner: 24 focused tests passed. Meaningful RED cases covered progress/
  PID drift and consent revoked during a network wait. Whitespace checks passed.
- Current Main Swyp compiler generated the candidate schema with 27 declarations;
  all 25 previous declarations were preserved exactly. The manifest and both
  generated DTO mirrors match the compiler output byte for byte.

## Evidence and remaining gates

Durable evidence root: `E:\nexus-training\evidence\p2p-bounded-tcp-20261002`.
Main proof: `bounded-tcp-ccbrwpjm/receipt.json`, SHA256
`5293f1f107d54836a3350ddc8d638107270401cfd8bf1ad9c1fa75a036763c46`.
Main source pins: `bounded-tcp-ccbrwpjm/source-pins.json`, SHA256
`ea96bc75b03d58b378420c737379f8ba0c438d3ca8a8b8da52203f3f33b75467`.
`root-main-integration/` contains the exact claim manifest, twelve public source
backups, protected-input receipt and final product gate logs. Earlier worktree
receipts certify their own pinned sources and remain separate from Main proof.

Rollback in a separate fresh session restores round 1's hash and CE. However,
its active pointer differs from persisted progress afterwards; subsequent
resume refuses. Rollback-to-resume is unresolved. Crash/power-loss filesystem
durability, two physical hosts, Internet discovery/NAT, adversarial membership,
large frozen evaluation/statistical thresholds and distributed 125M training
remain distinct gates. Windows Job Objects bound model workers; equivalent hard
limits for the host/build are not demonstrated. Joules/token is unmeasured.
No mobile-training, universal installation or superior-model claim follows.

The opt-in runner requires explicit interpreter, durable evidence parent and
UTC deadline; operational limits are parameters:

```text
python scripts/verify-imc-network.py --python <PYTHON> --temp-root <EVIDENCE>
  --absolute-deadline <UTC_ISO8601> --max-wall-seconds 115
  --cleanup-reserve-seconds 10 --resume-continuation --enable-synthetic-training
```

Optional `--public-library-root` names an existing installed dependency root.
The runner consumes synthetic fixtures only and does not train/promote the
production model. Brev remains preparation-only under the separate 100USD
budget; this acceptance neither allocates GPUs nor closes its billing/export
and CUDA/NCCL prerequisites. The full goal remains ACTIVE.
