# Brev multi-GPU offer selector

State: STOP/FROZEN — LOCAL/LINUX GATES PASS, READY FOR SELECTIVE INTEGRATION.

Claims are only the new ilaria/bench/brev_offer_selector package and this handoff.
No cloud call, trainer, GPU preflight, budget policy, lifecycle guard, data pipeline
or existing configuration file is modified by this lot.

## Contract

The selector consumes a timestamped catalog snapshot plus an explicit policy and
never calls Brev itself. It requires one catalog entry with exactly the requested
GPU count, so eight independent one-GPU instances can never be aggregated into a
fake eight-GPU host.

Ranking is policy-driven. The live policy used for the current proof is:
H200 -> H100 -> B200, required count 8, minimum 80 GiB VRAM/GPU, minimum compute
capability 9, 2 billable hours, 100 USD authorization, 23.20 USD reserve, zero
prior spend. Within one family lower projected total-VM compute cost wins.

The catalog price is treated as the whole VM hourly quote and is never multiplied
again by GPU count. This selector does not attempt to infer storage, tax, egress or
billing granularity. Those belong to a separate billing-terms gate.

preferred_candidate is not allocation authority. allocation_ready requires all
three external booleans: billing terms verified, physical topology verified and
deployment Terms accepted. The module always emits allocation_authorized=false.

## Live catalog proof

Fresh official Brev CLI v0.6.335 catalog snapshot at
2026-10-02T09:29:02.046250Z:

- H200 entries: 1; it is one GPU, not eight.
- B200 entries: 0.
- H100 entries: 5.
- No exact 8xH200 single catalog entry exists.
- Preferred budget-eligible fallback: OCI oci.h100x8.sxm, one catalog entry with
  8xH100, 80 GiB/GPU, 640 GiB total VRAM, capability 9, 2048 GiB RAM,
  28.44 USD/hour.
- Two planned compute hours: 56.88 USD.
- Compute budget after 23.20 USD reserve: 76.80 USD.
- allocation_ready=false because billing terms, physical topology and Terms remain
  unverified.
- selection SHA-256:
  d45f3b1145f3320d4889ee4f3e91d97e1cae3ba2378c08cc5bac70f5370a5f85.
- Evidence:
  E:\nexus-training\evidence\brev-offer-selector-20261002\selection.json.

The OCI catalog record reports arch "-" and no disk_price_per_gb_mo. These are
deliberately not filled by inference; they remain part of the external verification
before allocation.

## Verification

- Targeted selector tests: 13/13 PASS on Windows.
- Same targeted selector tests: 13/13 PASS on pinned Linux runtime.
- Selector + canonical IMC regression set: 33/33 PASS.
- Ilaria GOWORK=off go test ./...: PASS, 8 test-bearing packages.
- Ilaria go vet ./...: PASS.
- py_compile: PASS.
- LSP/Pyright on both Python files: 0 diagnostics.

No Brev create/delete/copy, GPU allocation, paid compute, Terms acceptance, secret
read, Bridge/config mutation, stage, commit, push or deploy occurred.
