# Independent P2P Main acceptance
State: PASS — integrated local synthetic prototype; no production promotion.

## Repaired independent review

The previous review proved a valid re-signature could change learning rate,
maximum delta norm and minimum improvement while keeping nonce/fence/consent.
The repaired independent PoC supplied ALL 13 legitimate issued binding fields,
rather than relying on refusal for missing fields. Eight valid re-signatures
were rejected for changed learning_rate/max_delta_norm/min_improvement/steps,
the original combined policy change, model configuration, base and fixture.
Candidate-model allocation count was zero for every refusal. Exact authorization
for variable 1/9/64-step recipes still passed; the actual adopted demo uses 16 steps.
PoC exit 0 in 4.23 seconds; no tensor/checkpoint/private-key files inspected.

OS now sends its recipe to a distinct evaluator process BEFORE proposer dispatch.
Canonical Ilaria code derives model/base/fixture/recipe identities on that pipe.
OS retains that issued contract and checks candidate metadata against it.
Evaluator retains its independently prepared identities and requires a complete
binding. No expectation is copied from the proposer envelope. Peer signatures
authenticate exact bytes; authorization and quality remain separate checks.

The product launcher no longer contains a fixed Windows user/Python install path.
--python is explicit or discovered through PATH. --public-library-root is optional,
forwarded as one argument only when provided; tests cover a path containing spaces.
Python remains isolated with -I/-B. Actual host commands explicitly configured the
existing installed public dependency root; no installation or ambient user-site
enablement. Host-specific negative Windows tests retain explicit fixture discovery.

## Exact integration and repository preservation

Exactly 8 repair claims differed from the supplemental baseline; other 7 P2P
artifacts and 450 protected dependencies matched their recorded hashes.
Immediately before copying: 4 existing Main destinations matched ORIGINAL P2P
baseline hashes; 11 destinations were absent. No conflict or whole-tree overlay.
Exactly 15 claims copied byte-for-byte. Four previous public files were backed up
under the owned temporary evidence directory. All 15 Main hashes equal the frozen
handoff snapshot below after tests. Kernel 6 frozen claims match in Main/worktree.
Canonical Forge IMC and collective_sleep source hashes also match both roots.

Main branch before/after: codex/nexus-supervisor-v3.
HEAD before/after: 06a5f39f805cf36897e05ffe306d05ed212a5a3a.
Index/staged metadata before/after: git diff --cached --raw produced no entries
at both boundaries. No stage/commit/branch/reset/clean/history operation occurred;
byte-level index hash was not captured, so no stronger index-byte claim is made.

## Independent Main gates

- Ilaria: GOWORK=off go vet ./... and go test -json -count=1 -timeout 180s ./...
  exit 0: 16 packages, 263 passed test events,1 external-corpus opt-in skip,0 failures.
- SwypikOS: same vet/test flags exit 0: 60 packages, 655 passed test events,
  2 skips,0 failures. Native kernel/unchanged full Swyp suites were not rerun.
- Python canonical IMC+peer+collective_sleep:74 passed in 62.34s, exit0.
  External corpus opt-in environment unset for gates; only public synthetic data.
- Swyp component check/compile/go: exit 0; newly generated manifest and both DTO
  mirrors byte-identical to integrated canonical artifacts, no compiler changes.
- Main git diff --check: exit 0; all 15 claims independently checked for trailing
  whitespace. No suite restarted or weakened after its success.

## Actual Main two-process adoption and rollback

Actual distinct proposer 28652 / evaluator 23660; demo exit 0, same-state replay exit 1
with replay/ledger failure, before a second dispatch.
CE before/candidate/active/rollback:
3.2246127128601074 /2.475658416748047 /2.475658416748047 /3.2246127128601074.
Evaluator consumed runtime-owned synthetic checkpoints to recompute actual active
and rollback CE; their tensor contents were not printed or manually inspected.
Base/rollback SHA:
dddbe3c373b7581aae57ba6674c65d41d0e177277f64b7c6d398840c5fcd8d71
Active SHA:
48169b987dce331ebe8073669626b9d06078dd0e41818b142be7ab0f40bef70f

Portable operator template, from swypik-os. Select an approved Python runtime and
dependency directory explicitly, and use a fresh owned state directory:

```powershell
$probePython = (Get-Command python -ErrorAction Stop).Source
$probeLibraryRoot = '<approved absolute Python dependency directory>'
$probePeer = (Resolve-Path '..\ilaria\runtime\isxprobe\peer.py').Path
$probeState = '<fresh owned absolute state directory>'
go run ./cmd/imc-peer-probe --local-probe --demo --python $probePython --public-library-root $probeLibraryRoot --peer $probePeer --state $probeState
```

This template removes personal host paths; it is not a hash-locked environment.
A dependency lock with hashes and a clean-host reproduction remain required
before claiming portability. The original successful host invocation is evidence
for that host only; this template has not been rerun as a new demonstration.

## Limits

Local trusted 16-token random-initialized IMC fixture only. Windows hard group
limits configured 1 GiB / 25% CPU / max 2 processes with a 120s deadline; actual model peak RSS
remains uninstrumented and CPU saturation unmeasured. No Internet swarm, IMC1B,
IlariaLex65k, pilot, hardware portability, hostile filesystem, physical power-loss,
distributed revocation/concurrent external state writer or superiority claim.
Crash recovery covers local abrupt-process tests, not machine power failure.
Demo rollback is mandatory own-state cleanup; no production artifact promoted.
No Forge/training/controller/Colab/config/keys/private data/weights source changes.

## Evidence and frozen hashes
Completed at UTC: 2026-10-01T13:43:35.0057014Z
Evidence directory: C:\Users\abel\AppData\Local\Temp\nexus-p2p-main-20261001-8d2c577189ec4586bf29795cf4f6131e
Logs: ilaria-vet.log, ilaria-test.jsonl, os-vet.log, os-test.jsonl, pytest.log, schema-{check,compile,go}.log, demo.json, replay.log, verification-summary.json, diff-check.log.

Retention update, 2026-10-01: 18 explicitly listed public logs/scalar metadata
files (836,573 bytes) were copied with matching SHA-256 hashes to
`E:\nexus-training\evidence\p2p-local-20261001-134335`; see
`retention.manifest.json`. Runtime state, checkpoints, tensors and keys were
excluded. This preserves existing evidence beyond Temp cleanup; no demo was
rerun and no claim is made about power-loss durability. The separate current
runtime observation is not proof of the original run's dependency environment.

- ilaria/specs/myriad.swyp: bbed71836741ce742a3a53a858b9608dca88791eb927aaed2037ead609356421
- ilaria/specs/myriad.manifest.json: f55be33b5dc8e3cb2bfaa00f7a743c4ab0dc0a5794fa8fb12703f0f52b0affbc
- ilaria/generated/myriad/types_gen.go: 0ca37f338e517b2a7ade6357dd553dc5edfc85232beb037eac885ba2b9490a74
- swypik-os/generated/myriad/types_gen.go: 0ca37f338e517b2a7ade6357dd553dc5edfc85232beb037eac885ba2b9490a74
- ilaria/runtime/isxprobe/contract.go: 8d401732299e9779985aaa3e78f41a4ca2a7c324ff97e2efce466accda3fa756
- ilaria/runtime/isxprobe/contract_test.go: 5546186c6b60386d384fc60722661e3d8892f4af7152bdb7abc5bb0bef3aaa9d
- ilaria/runtime/isxprobe/peer.py: e657632cbaa2b2e7738529c3ecb93ade41958de5fe50be5d345f1be6feafa06e
- ilaria/runtime/isxprobe/test_peer.py: 61da4eeaa6db5efa5ae648d77f81cd765716d3a23b0c491a8699c8778d11c880
- ilaria/runtime/isxprobe/__init__.py: 24d6d9a8461710514640dd15207cbeb2d80a0c7fdea5a884c395bef42c72ad70
- swypik-os/cmd/imc-peer-probe/main.go: 0408c13d2a6d68474367203e49c8a1c058870ff10a66c9bd462bc9266ec752f0
- swypik-os/cmd/imc-peer-probe/main_test.go: 5588b60f544426970d1f2e0024767ef295269c714ad69d357c0f845f5d5179c6
- ilaria/docs/audit/p2p-imc-two-peer-probe.md: 6e525c44c105f6bfec971a4845a6c7504246a6e3e6e4b68be2f478c340fb7bd7
- docs/coordination/chrome-2026-10-01/worker-oc-3-p2p.md: 64ade9ee00d56a6dc47a552d5b7eb5982183a48c52b5f8616feb5c2c121adad0
- ilaria/bench/myriad/pce_transfer_v1/benchmark_test.go: 90013b5af9d8ec7b6d0f860809cf4e8dbd5044a98b43b6d6b584c0d719bdbc9e
- ilaria/bench/myriad/pce_transfer_v1/benchmark_public_fixture_test.go: db6c772537c7e92ddebdc12185ffb08c89f06cae6b1d6d62988e68c87698381a
