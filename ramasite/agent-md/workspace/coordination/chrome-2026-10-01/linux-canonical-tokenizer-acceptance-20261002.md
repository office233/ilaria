# Linux canonical trainer and tokenizer metadata — 2026-10-02

The canonical IMC trainer ran successfully through the reviewed Linux supervisor,
without injecting admission or replacing the training loop. This is preparation
evidence for the bounded H200 pilot; the real dataset remains unqualified.

Root evidence: `E:\nexus-training\evidence\linux-qualified-pilot-runtime-20261002`.
The new isolated WSL runtime uses Python3.14 and Torch2.14.0+cpu; no global install,
CUDA package, pretrained model or paid compute. Official wheel index and delivery
probe, each downloaded wheel/hash, installation reports and the resolved lock are
retained. The package source is the [official CPU index](https://download.pytorch.org/whl/cpu/torch/).
Total wheel bytes237,141,520; runtime preparation40.78s after the documented
delivery-host correction. This runtime is a CPU proof, not an H200 image.

`canonical-cpu-proof.json`: PASS at04:00:19UTC,8.00s. Exact released trainer,
IMC architecture and supervisor pins; two CPU ranks, two steps,16 global tokens.
The Gloo backend follows the pinned canonical CPU/world2 branch. Fresh synthetic
32-token streams and a0.5M-parameter IMC fixture only; no sealed stream exists.
The checkpoint and run metadata agree on source/launch/geometry and NON_PROMOTABLE.
Scope return0; three owned process identities exited, helper exited, kernel
ECHILD/cleanup verified. No supervisor monkeypatch or caller readiness flag.
The separate focused Linux replay passed24 tests; one Windows-only case skipped.

One additional canonical run verified timeout during actual training. Its new
synthetic train stream is a deterministic1..32 uint16 tile,80,000tokens/160,000B;
all synthetic metadata was re-bound, bounds10,000steps/80,000tokens/20s, evaluation
at10,000only. At04:11:33UTC the proof PASSed15.42s, with a real finite loss at
step0 and last logged step1000. The workload scope failed as expected at its
deadline; return1, cleanup/ECHILD/helperexit verified, three owned identities and
helper independently absent, driver children empty, no checkpoint/export.
`canonical-cpu-timeout-proof.json` preserves every check and the source pins.
This proves local trainer shutdown; it does not delete a billed Brev instance.

Tokenizer audit owner STOP/FROZEN; both reports in
`E:\nexus-training\evidence\tokenizer-lineage-readonly-20261002` accepted after root
rehash of28 unique named public inputs, zero drift before registry updates.
Freeze/sample metadata, rights and source-lock identities match. Nine sources/
19 tokenizer sample inputs have no proven pilot train-group/exclusion binding.
The current v1 adapter additionally omits the required first-party attestation
map/root. Existing source approvals remain intact; this metadata-only audit
confers no new approval or denial and did not inspect payload bytes.

The proposed separate tokenizer contract is a draft, unimplemented/unapproved.
Next qualification must independently establish observed tokenizer sample and
pilot-group/benchmark exclusions, actual package bytes, applicable existing rights
and first-party attestation bindings. Preserve all frozen artifacts and pending
decisions; do not manufacture train groups to fit the current v1 adapter.

The100USD plan remains one8-H200 VM, at most120 billable minutes including
provision/startup/bootstrap/export/deletion,76.80USD at the old38.40USD/h quote
plus23.20USD reserve. Refresh price and billing terms before allocation. Actual
8-rank CUDA/NCCL, real-data qualification, export outside the disposable VM and
remote deletion independent of this PC remain unverified. No VM was created.
Fresh read-only `brev ls --json` returned the known schema, workspaces:null/exit0;
readback recorded04:07:17UTC. Branch/HEAD/index and frozen inputs preserved.
Goal remains ACTIVE and complete scope preserved; Bridge and G4 untouched.
