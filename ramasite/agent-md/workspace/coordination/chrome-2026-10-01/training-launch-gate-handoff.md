# Training data qualification gate

This work adds a metadata-only qualification contract for an explicitly bounded
IMC experiment. It neither trains nor allocates compute. The dedicated branch is
`codex/training-launch-gates-20261002`, based on public source HEAD
`06a5f39f805cf36897e05ffe306d05ed212a5a3a`. Main, the older data worktree, the frozen
package, trainer, rights configuration and inventory are preserved.

The gate distinguishes `code-only-pilot` and `production`. A reviewed pilot does
not require the production eight-lane mixture, retains `NON_PROMOTABLE`, and
cannot satisfy the production scope. A production review additionally requires
a pinned canonical readiness report, full canonical curriculum metadata, dataset
metadata bindings and a separate canonical dataset/tokenizer-freeze validation
receipt. No data qualification authorizes model promotion or compute allocation.

The versioned metadata contract consists of four content-addressed records:

- `ilaria-training-data-qualification-v1` binds dataset identity and file hash,
  producer hash, source revisions and provenance hashes, current rights/evidence
  and source locks, tokenizer and split metadata, group assignment, validation
  receipt, sealed evaluation-only use, and positive step/token/wall limits.
- `ilaria-training-data-launch-decision-v1` binds that exact qualification and an
  explicit `APPROVE_PILOT` or `APPROVE_PRODUCTION` decision with reviewer/reference.
  The generator creates `PENDING` only.
- `ilaria-training-group-assignment-v1` records the SHA-256 identity of each
  source group in train, validation and sealed. Group lists must be nonempty,
  unique and disjoint; pilot counts must match the frozen package. Counts or a
  `group_disjoint: true` assertion cannot substitute these lists.
- `ilaria-training-data-validation-receipt-v1` pins separately performed byte
  integrity and provenance verification to the exact dataset, streams, source
  provenance, rights, producer and group assignment. It requires an external
  reviewer/reference. Production also pins canonical validator source and
  tokenizer-freeze identity. The generator labels this receipt `PENDING`.

Current rights are checked through existing canonical `require_approved_rights`
and `require_approved_evidence`; the CLI also uses the canonical evidence/lock
validator. Hashes and qualification booleans grant no rights. These records are
review artifacts, not authentication credentials: the release process must
verify the human decision and recorded external validation. This tool does not
recompute corpus bytes, source quality, semantic benchmark independence or group
membership from texts.

The actual frozen code package remains unchanged: package identity
`54dbb183953b8bec3461c35d47050557df5ee016e03b6a162a10d1236da4bfcc`, file hash
`8a606282daf8c53ebd040b3aff6d54cc08bdd0dd99d5ab72a0cfdaf08c991f22`, and producer
snapshot hash `d0e31bc3dc0c8624d58fc20af3d91dcd53fbbcd7dcb3bedecf06c5e27c5a78ce`.
Its manifest and three stream metadata files were the only package inputs read.
No texts, token tensors, tokenizer payload, benchmark texts, old G4 corpus,
weights or private files were read. Counts remain 33,852,096 train, 7,907,468
validation and 14,701,949 sealed tokens, with 361/58/67 groups (486 total).

The final pending templates are in
`E:\nexus-training\evidence\training-launch-gates-20261002\actual-pilot-pending-final`.
The group identities and independent validation metadata are still missing, the
experiment bounds are unset, and the launch decision remains pending. No rights
or source-quality approval was created. Completing those review artifacts is a
separate authorized metadata task; it must not modify the frozen package.

The existing canonical trainer rejects this custom pilot package because it
accepts only `ilaria-dataset-manifest-v1`. The new report therefore preserves
`trainer_adapter_ready=false` and `launch_ready=false`, even for a synthetically
complete pilot qualification. The missing qualified-pilot adapter is explicit;
`--allow-unmanifested-data` is not a pilot adapter. Any eventual wiring must run
before `set_device`, `init_process_group`, model/optimizer construction and
training. Moving the existing canonical trainer preflight is owned separately
by the root task. This work changes no trainer arguments or schemas.

Validation uses synthetic metadata. The canonical-only baseline rejects a fully
reviewed synthetic code-pilot metadata package before corpus access (RED). The
new scope gate admits that exact review metadata as non-promotable, with launch
still blocked (GREEN). Tests also reject valid-hash absent rights/provenance,
sealed-group overlap, heldout training selection, metadata drift and incomplete
production readiness/curriculum. Receipts are under
`E:\nexus-training\evidence\training-launch-gates-20261002`.

Remote export, deletion policy, allocation window and Brev terms remain separate
launch gates. The existing plan remains at most USD 100, USD 38.40/hour and two
hours; this metadata work does not approve or change it. No GPU, paid job,
download, cloud operation, stage or commit occurred. Root review is required
before Main integration or native/training release.
