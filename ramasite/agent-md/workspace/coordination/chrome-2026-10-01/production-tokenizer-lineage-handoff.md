# Production tokenizer exact selection lineage — 2026-10-02

Owner state: **STOP/FROZEN for independent acceptance and selective integration**.
Worktree `C:\Users\abel\.codex\worktrees\qualified-tokenizer-contract\nexus`,
branch `codex/qualified-tokenizer-contract-20261002`; branch/HEAD/index unchanged.
Exclusive four claims: `ilaria/forge/production_tokenizer_pipeline.py`, new
`production_tokenizer_lineage.py`, new `test_production_tokenizer_pipeline.py`,
and this handoff. Every previous qualified-tokenizer claim is protected.
Exact before/after hashes, bytes and protected baseline comparison are in
`E:\nexus-training\evidence\production-tokenizer-lineage-20261002\owner\source-pins.json`.

New production input reports use `ilarialex-production-inputs-v2`. Canonical
IlariaLex vocabulary 65536, sample/coverage/freezing v1 schemas, ordered external
source traversal, CR/LF replacement with spaces, strip plus one LF, and whole
document target crossing remain unchanged. Attested files remain byte-identical
whole-file copies. Old tokenizer/sample/freeze artifacts are neither modified
nor retrained. The pipeline requires an exclusive new output directory.

Every input record binds content-hash-named selection JSONL and sealed selection
metadata. Metadata binds sample filename/hash/bytes/document count, generator
source pins, exact raw manifest hash and source identity, canonical scalar source
provenance, selection policy, operational limits and ledger hash/bytes/count.
Each external ledger entry binds raw shard filename/index/hash, physical line
and byte interval, raw-line and canonical-row hashes, row identity, canonical
`data_audit.document_sha256`, safe scalar item/path provenance from the canonical
curation whitelist, and exact emitted-fragment hash/UTF-8 byte interval. Receipts
contain no text or arbitrary/nested row metadata. First-party entries bind the
existing attestation file/identity/scope, explicit source root and attested path,
canonical document hash and the unchanged emitted bytes. No global transitive
alias-component/group IDs, source approvals or promotion claims are generated.

Public helpers: `write_external_sample`, `write_first_party_sample`,
`validate_selection`. Replay uses caller-supplied source authority, revalidates
existing rights/evidence/locks or first-party packet, reconstructs every selected
row/fragment, and compares ledger plus sample incrementally. Rehashing fabricated
ledger metadata does not satisfy exact replay. All declared source identities
and shard paths are checked before shard reads; rights approval precedes any
materialization. Safe-path checks reject traversal, cross-platform absolute
paths, duplicate shards and symlinks. Existing validators remain authoritative;
there are no new legal, recipient, region or source-review rituals.

`materialization_limits` is an explicit caller argument or the source plan's
`tokenizer_materialization_limits` object: positive integers `max_row_bytes`,
`max_document_bytes`, `max_ledger_row_bytes`, `max_metadata_bytes`. Limits are
bound in selection metadata and input report. Physical JSONL and ledger reads
are bounded before parsing; document buffers and first-party decoding are capped.
Selected rows are never accumulated in memory. Auxiliary memory is bounded by
source metadata, one capped document/ledger row and canonical hash-helper buffers
(the existing helper reads chunks of 8 MiB). Existing authority validators load
their reviewed metadata. **Peak RAM and energy were not measured**; bounded
design is not a runtime low-RAM/energy receipt. Inputs must stay immutable while
generating/replaying. Atomic helpers protect individual outputs, not a multi-file
transaction: row refusal cleans unpublished temporaries; later publication I/O
failure may leave completed files, which cannot be overwritten on retry.

Original historical source identities must still be recovered independently.
Later pilot manifests cannot substitute for the original FreeRTOS/Zephyr sample
lineage. This implementation does not qualify the old real freeze, prove
evaluation independence, allocate compute or alter the from-scratch IMC goal.

## Owned direct materialization and replay recipe

Run with the prepared WSL CPU Python, passing the integrated Forge directory and
a new exclusive owned fixture directory. This recipe calls real materialization
and replay helpers without injection; it does not train any tokenizer or model.

```python
import json, sys
from pathlib import Path
forge, root = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
sys.path.insert(0, str(forge))
from test_production_tokenizer_pipeline import fixture, LIMITS
from production_tokenizer_lineage import (
    write_external_sample, write_first_party_sample, validate_selection)
root.mkdir(parents=False, exist_ok=False)
f = fixture(root)
# Explicit owned-fixture limits: row/document 8192, ledger row 16384,
# metadata 131072 bytes. These are test parameters, not production defaults.
record = write_external_sample(f["manifest_path"], root / "direct.txt", 1,
    source_name="tinystories", **f["authority"])
meta = validate_selection(root / record["selection"]["filename"],
    expected_input=record, source_manifest_path=f["manifest_path"], **f["authority"])
owned = write_first_party_sample(root / "direct-native.swyp",
    source_name="first_party_contracts", attested_path="native.swyp",
    attestation_path=root / "attestation.json", source_root=f["first_root"],
    materialization_limits=LIMITS)
validate_selection(root / owned["selection"]["filename"], expected_input=owned,
    attestation_path=root / "attestation.json", source_root=f["first_root"],
    materialization_limits=LIMITS)
assert record["documents"] == owned["documents"] == 1
(root / "direct-proof.json").write_text(json.dumps({
    "scope": "owned-synthetic-materialization-replay", "external": record,
    "first_party": owned, "tokenizer_trained": False,
    "real_data_qualified": False, "allocation_authorized": False}, indent=2) + "\n")
```

For a refusal proof use another exclusive fixture directory, construct
`fixture(path, rows=[{"text": "x" * 1000}])`, set only its authority's
`max_row_bytes=64`, and call `write_external_sample`. Expect `ValueError` before
JSON parsing, with no published sample, selection sidecar or leftover temporary.
Unsafe second-shard paths and pending rights similarly reject before any shard
or attested source read. Existing outputs reject and remain byte-identical.

## Validation and ownership

Logs/commands/counts/dependency versions are in external `owner/checks.json`.
First targeted run: 19 passed, exit 0. Affected tokenizer/freeze/coverage,
first-party and mandatory IMC model checks are captured in `affected-tests.log`.
Syntax and ordinary `git diff --check` receipts are captured separately; seeded
untracked claims additionally receive no-index whitespace checks (expected diff
exit 1, zero whitespace diagnostics). No failing test receipt was discarded.

The pipeline assembly test explicitly mocks `train` with an owned synthetic
tokenizer fixture to verify the 65536 call, sidecar bindings and unchanged freeze
v1 construction. It is **not tokenizer training, full-pipeline or real-data
qualification proof**. All other materialization/replay tests exercise the real
helpers. No stress suite, GPU/cloud jobs, installs, secrets, real corpus/tokenizer
payloads, weights, Bridge/G4, Main edits or staging/commits were performed.
Independent acceptance owns Main integration, Go checks, direct owned proof,
LIVE updates and any subsequent operational work. No owner work remains except
requested review repairs.

## Independent source-acceptance repair handoff v2

At **2026-10-02 06:02 UTC**, independent acceptance session
`ses_f04d0f514ffe0FGWQjhip6ZIx3` owns the explicit requested repairs in this
dedicated frozen worktree. Official active API readback found only root and this
session; no historical owner/writer was active. All original four pins and 37
protected baseline sources matched before repairs; Main remained unmodified.
Historical `owner/source-pins.json` and `owner/checks.json` are not rewritten.

Four discriminating regression cases failed against the original source: Git
provider mismatch reached a shard read; an unlisted first-party candidate was
read before refusal in both write and replay; selection metadata-size refusal
left published output. Minimal source repairs now bind Git provider/config to
the approved immutable lock, check requested attested-path membership before any
first-party payload read, and validate complete receipt metadata before either
stream publishes. Normalization, ordering, vocabulary and freeze schemas remain
unchanged. Individual publication I/O failures remain non-transactional as
disclosed above; exclusive output ownership and immutable inputs are required.

Versioned pins, exact four-claim diff, original snapshots, regression failures,
new check logs, protected/Git comparisons and acceptance handoff live exclusively
under `E:/nexus-training/evidence/h200-recovery-code-acceptance-20261002`.
The new pins are `source-pins.v2.json`; only those reviewed exact claims may be
integrated through the unchanged canonical helper with a new plan and backups.
The final status is in `acceptance-receipt.json`, not inferred from this handoff.

Direct synthetic proof called the real external and first-party writers plus
incremental replay: 3 external documents / 45 bytes, one byte-identical attested
file / 30 bytes. Seven canonical refusal cases passed, including limits,
pending rights, unsafe second shard, unlisted attested path, unchanged existing
outputs and sealed hardlink admission refusal. Synthetic fixture tree cleanup
passed; no raw payload was retained in evidence. No helper/admission was mocked
in that direct proof. The pipeline assembly test still mocks tokenizer training
and is not real training proof. Heldout/evaluation exclusions remain the exact
independent contract's authority; selection receipts do not approve any dataset.

FullGoal remains **ACTIVE**, solely from-scratch IMC: IMC-125M validation before
IMC-1B = **1,000,555,520 parameters**. Real historical corpus lineage/exclusions,
real tokenizer/data qualification, H200/NCCL, Terms/window, price/billing,
independent export and remote deletion remain unresolved external gates. No
cloud, approval, LIVE/coordinator/budget, staging or Git history changes.

Service restart readback at **2026-10-02 06:06:14 UTC** discovered active sibling
`ses_f04cb64afffe0Vj8X3OnByvRYF` ("Date curate tokenizer nou") in Main. Under
the user's conflict guard, **integration is withheld**; no STOP is inferred from
timeout or restart. This does not make that data session the frozen source owner.
Main's four destination before-pins and Git identity still matched at readback.
The blocked plan is not executable by the canonical helper; root must coordinate
ownership and then create a new reviewed plan after fresh checks.

Affected validation was bounded at 230 seconds: 258 consecutive PASS reports,
zero failures, no final suite completion; receipt retained as timed out. Only the
remaining 32 collected nodes are resumed under a separate bounded command, not
the unchanged suite. Final counts/exit codes are recorded in the frozen external
acceptance receipt. The mandatory 195 IMC checks are in the completed prefix.

The unfinished-tail run also reached its 160-second bound after 22 additional
PASS reports, zero failures. Final Python evidence is **280 PASS reports and 10
uncompleted extended contract nodes**, not a full-suite PASS. All 236 original
affected checks (including 23 repaired-lineage and 195 IMC cases) reported PASS.
Acceptance is **FAIL/BLOCKED** for active-sibling integration conflict and the
incomplete extended suite. No unchanged suites are relaunched at handoff.
