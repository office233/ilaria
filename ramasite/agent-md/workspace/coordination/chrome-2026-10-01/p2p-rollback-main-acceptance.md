# P2P rollback and restart — Main acceptance, 2 October 2026

Status: ACCEPTED_LIMITED_SYNTHETIC_TCP_PROTOTYPE_NOT_PRODUCTION.

The canonical tiny IMC now trains over authenticated loopback TCP, restores a
committed ancestor, and continues from that restored checkpoint after fresh OS
and worker processes restart. Main's actual run accepted rounds 1/2, rejected
3, performed signed rollback 4, accepted resumed rounds 5/6, and rejected 7.
Both peers retain the same durable session, genesis, parent, lineage and sequence.
The replay restart was refused before worker allocation.

## Repairs and review

Rollback consumes its own Control Kernel node, lease and intent. Its issuer-role
certificate binds the complete before/after/target progress, ancestor intent,
nonce, consent epoch, lease fence and deadline. The target requires immutable
checkpoint integrity, a real committed publication, and exact current and
preceding history/request bindings. Ordinary training lineage remains distinct.
Consent is checked before and after blocking synchronization and ACK admission.
Committed recovery completes metadata without retraining; uncertain recovery
restores the prior parent, retains evidence and refuses redispatch.

The first actual run passed rollback but failed when resumed training produced
the exact bytes of a previously committed checkpoint. Its hash-addressed event
index incorrectly treated a new sequence as an immutable-record conflict.
The correction uses separate immutable committed-N records; checkpoint hashes
may repeat while event identity remains unique. Ancestor selection uses an
explicit sequence cutoff and refuses conflicting, malformed, legacy or
unjournaled records. The original failed receipt remains unchanged.

Independent source and validator review passed. Behavioral regressions include
pointer-only restart, uncertain-result promotion, repeated checkpoint commits,
and a real signed receipt with an inconsistent journal fence. The incorrect
implementations fail these checks; the corrected implementation passes.

## Integration and evidence

Exactly six approved claims were copied after owner STOP and current-hash
verification: adapter.go, the new rollback_resume_test.go, the bounded TCP runner,
its tests, and the two owner handoffs. Three existing public files were backed
up; no worktree overlay was copied. Another 497 pinned public inputs, Main HEAD,
branch and Git index were preserved; staged paths remain zero.

Affected Main gates: 54 OS packages PASS, seven without tests, full go vet PASS,
57 runner tests PASS, syntax and whitespace PASS. The unchanged Ilaria and Swyp
gates were not repeated. Actual Main proof: 45.157 seconds within a 115-second
allowance including a 10-second cleanup reserve. All six spawned children and
output drains stopped; eight observed owned PIDs were absent. All 300 Main
source pins remained stable. The canonical IMC source remains
650f4cad06d80760a03fa4396bb2cce27364bd596b8002f39ec02d595205274c.

Evidence root: E:\nexus-training\evidence\p2p-rollback-resume-20261002.
Main acceptance receipts are under root-main-integration:

- integration.json: exact before/after hashes and selective backups.
- main-gates/receipt.json: SHA256
  873a21f833d6eaccf963fab4b2e493524fb062ac8e2fc358e6891cbd105d2142.
- main-actual/bounded-tcp-8f2ei7u0/receipt.json: SHA256
  9c6ff103dd29c14fa7b4a7fb0828bbfc23c113a353429890ef3cd88ebbab6949.
- The accompanying source-pins.json: SHA256
  aeeee04af01c013a9a13c7881565187978b76ae84fd002997a7ea166f7ea4a15.
- main-actual/main-actual-stop.json: SHA256
  87a59cd7ae41663424210eb5fbc368dd3f572d0e7b4b619041dc69c2e862cd8c.

The separate corrected worktree proof took 37.109 seconds. Its receipt
24e1f6663d35b1d9cfb23987e260aec778dee97eea8909acadf0e17deda11a67
does not substitute for the Main proof. The original failed receipt
c3a5215e6401c13caa3cc2791d0ae4adf709c6c857595688deb14791e30377a2
is retained independently.

## Limits and next work

This is a tiny synthetic model on one Windows host. Fixture CE improved from
3.2246127 to 2.6398823, rollback restored 2.9212317, and resumed training reached
2.4114845. These values do not establish generalization or production quality.
Two physical hosts, Internet operation, aggregation/Sybil defenses, 125M scale,
mobile training, sealed independent quality tests and power-loss durability
remain unproved. Worker Job Objects provide resource containment; a complete
host/build security sandbox is not established. Consent checks occur at
admission/effect boundaries, not every instruction of an in-flight calculation.
Old state without versioned history is refused rather than silently migrated.

Issuer-worker CPU samples were 3.953125 and 4.328125 seconds; measured RSS was
approximately 286 MB. These samples exclude proposer and build totals. Energy
is unmeasured, so no efficiency or universal-device claim follows from this run.

Android preparation separately passed offline CNG, typecheck and lint in a new
app worktree. The original app remains unchanged. Java is verified; SDK license
approval, SDK installation, Gradle compilation, APK and device tests are pending.
Generated native sources are not an installable APK or an AI integration proof.

No GPU was allocated, training controller changed, model promoted, cryptocurrency
path added, or Bridge component touched. Brev's fresh read-only quote is
38.40 USD/hour for one eight-H200 VM; its instance list was empty at 01:16 UTC.
The 100 USD plan reserves at most 120 billable minutes, estimating 76.80 USD
compute plus 23.20 USD reserve. Billing terms, a new execution window, remote
deletion/export and the selected qualified dataset remain allocation gates.
The complete user objective remains ACTIVE.
