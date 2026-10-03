# Brev offer selector — Main acceptance — 2026-10-02

State: ACCEPTED/INTEGRATED — READ-ONLY SELECTION ONLY.

Integrated claims:

- ilaria/bench/brev_offer_selector/selector.py
- ilaria/bench/brev_offer_selector/test_selector.py
- ilaria/bench/brev_offer_selector/README.md
- docs/coordination/chrome-2026-10-01/brev-offer-selector-handoff.md

The integration was create-only and byte-pinned from branch
codex/brev-offer-selector-20261002. No pre-existing Main file was overwritten.

## Fresh live catalog result

Official Brev CLI v0.6.335 catalog captured at
2026-10-02T09:29:02.046250Z:

- H200 entries: 1, but only 1 GPU.
- B200 entries: 0.
- H100 entries: 5.
- Exact 8xH200 single-entry offer: absent.
- Preferred budget-eligible fallback under the explicit policy:
  OCI oci.h100x8.sxm, 8xH100, 80 GiB/GPU, 640 GiB total VRAM,
  capability 9, 2048 GiB RAM, 28.44 USD/hour.
- 2 planned compute hours: 56.88 USD.
- Budget after the preserved 23.20 USD reserve: 76.80 USD.
- allocation_ready=false.
- blockers: billing_terms_unverified, physical_topology_unverified,
  deployment_terms_not_accepted.
- allocation_authorized=false.

Selection identity:
d45f3b1145f3320d4889ee4f3e91d97e1cae3ba2378c08cc5bac70f5370a5f85.

Evidence:
E:\nexus-training\evidence\brev-offer-selector-20261002\selection.json

## Main verification after integration

- selector tests Windows: 13/13 PASS
- selector tests pinned Linux runtime: 13/13 PASS
- Ilaria GOWORK=off go test -count=1 -timeout 180s ./...: PASS
- Ilaria go vet ./...: PASS
- py_compile: PASS
- LSP/Pyright: 0 diagnostics

No Brev create/delete/copy, GPU allocation, paid compute, Terms acceptance,
secret read, Bridge/config mutation, stage, commit, push or deploy occurred.

The selector is not an allocation controller. The next cloud gates are external:
bind the exact catalog offer to verified physical topology, verify billing and
ancillary charges/granularity, and obtain explicit deployment Terms acceptance.
