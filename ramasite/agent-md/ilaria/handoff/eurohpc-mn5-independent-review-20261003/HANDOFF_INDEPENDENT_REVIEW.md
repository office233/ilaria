# Independent review of MN5 preparation adapter — 2026-10-03

Review after coordinator-confirmed coder STOP at 08:51:28 UTC. No implementation edits, Main/index/history operations, Slurm/GPU/training execution, weights/corpus reads or remote actions were performed.

## Verdict

The seven implemented files are reviewable as a preparation-only adapter pinned to detached baseline 3790d965826a9273017e5eca67e7f5d4727c4edb. Optional runtime.py and hardware.py were not created; the approved claim set was a maximum. Existing tracked sources are unchanged. Canonical launcher, metadata admission and GPU probe are reused; no model/trainer loop is duplicated.

Do not treat this as current-Main execution compatibility or MN5 qualification. Coordinator-supplied G4 static review identified the current Main trainer f5e748bb... and new first-party/resume contracts; this reviewer did not duplicate that Main trainer diff audit.

## Findings

- P2, integration blocker: eurohpc/contract.py lines 262–263 enforce a training key set without first-party attestations/root; lines 270–271 also fix the six path keys. Synthetic probes show proposed first_party_attestations and first_party_root inputs are rejected. Current trainer first-party options cannot be represented when needed. Coordinate schema/launcher ownership before repinning and testing against current Main; do not silently add argv or modify canonical trainer contracts in this lot.
- P2, integration blocker: eurohpc/prepare.py lines 126–142 copy the baseline canonical trainer suffix unchanged. A synthetic resume retains its SHA256 in reference metadata but generated argv contains --resume and omits --resume-sha256. Baseline imc_125m_launch.py lines 159–160 explains this. G4 reports current Main requires the hash argument for resume, so that reference argv is incompatible with current-Main resume. This is a baseline integration gap, not evidence that this inert adapter trained or bypassed admission.

## Independent checks

One affected test invocation using existing C:/Python312/python.exe, no installation/download, no cache/pyc: forge/test_eurohpc.py plus forge/test_imc_125m_launch.py. Result: 111 passed in 3.59s, exit 0, no skips. Git Bash parser was available; tests validate only shell syntax and synthetic semantics, not Slurm acceptance or GPU/NCCL behavior.

Independent synthetic probes confirmed preparation mode, execution REFUSED, allocation_authorized false, inert script active lines only set -eu and exit 78, and both execute entry points reject even nonexistent config/root inputs. The affected suite covers one/multi-node accounting, upward billing rounding, remaining/reserved/per-job bounds, rank mapping/rendezvous, unsafe JSON/config/path/link cases, explicit text-byte pins and missing/stale/FAIL evidence.

HEAD stayed 3790d965. Fourteen implemented/test-dependency text SHA256 pins remained identical before/after. Tracked git diff --check exited 0. All seven new claimed files produced no whitespace diagnostics under git diff --no-index --check; those commands exited 1 because the new files differ from /dev/null. Raw statuses are preserved in diff-check.receipt.json rather than claimed as exit 0.

## Limits and next boundary

Confirmed functional scope is local plan/accounting/strict-input/refusal generation. No hardware inventory was executed; its test probe is synthetic. Source-closure replay, data/tokenizer/heldout/contamination qualification, MN5 account/QoS/storage/software/balance, NCCL, runtime containment/log/TERM/reap and promotion remain unavailable or blocked. Main integration requires an explicit current-trainer pin and affected compatibility retest after the ownership handshake. API cost/guardian/STOP enforcement belongs to the coordinator and is not independently certified here.

Evidence: before.json, after.json, pytest.stdout.log, pytest.receipt.json, compatibility-probes.stdout.json, diff-check.receipt.json and independent-review.receipt.json in this directory. STOP.
