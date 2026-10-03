# Brev billing-terms gate

State: STOP/FROZEN — LOCAL/LINUX GATES PASS, READY FOR SELECTIVE INTEGRATION.

Branch: codex/brev-billing-terms-20261002
Worktree: E:\nexus-worktrees\brev-billing-terms-20261002

Claims:

- ilaria/bench/brev_billing_terms/gate.py
- ilaria/bench/brev_billing_terms/test_gate.py
- ilaria/bench/brev_billing_terms/README.md
- this handoff

The module is strictly offline/read-only. It does not access Brev account settings,
payment methods, credentials, Auto Recharge controls or any provider API.

## Contract

The evidence packet is content-addressed and bound to the exact offer selection,
offer type, provider/cloud and USD TOTAL_PER_VM hourly quote.

A packet is ready only when it contains fresh, explicit evidence for:

- billing start phase;
- billing granularity;
- deletion stopping all future charges;
- bounded maximum storage cost;
- bounded maximum egress cost;
- bounded maximum taxes/other cost;
- current Auto Recharge state verified disabled;
- current source references for the selected quote and general Brev billing rules.

The gate never treats a per-GPU quote as a whole-VM quote. It rounds compute cost
up to the supplied billing quantum, keeps compute and ancillary reserve separate,
and rejects if compute exceeds the compute budget, ancillary maxima exceed the
reserve, or all-in projected spend exceeds the human-authorized total.

Official docs.nvidia.com references are schema-checked; organization-specific
state cannot be substituted by documentation.

## Current H100 assessment

Bound selection:
d45f3b1145f3320d4889ee4f3e91d97e1cae3ba2378c08cc5bac70f5370a5f85

Offer: oci.h100x8.sxm
Quote: 28.44 USD/hour TOTAL_PER_VM
Authorization: 100.00 USD
Reserved for ancillary uncertainty: 23.20 USD
Planned window: 7200 seconds

Current evidence uses only:

- the captured live offer-selection receipt;
- NVIDIA Brev official GPU instance documentation stating Running consumes
  compute charges and Deleted has no continuing charges;
- NVIDIA Brev official Billing/Console documentation describing compute/storage
  reporting and Auto Recharge controls.

No organization billing page or payment setting was read.

Current assessment:
7f7b850ed38db76a6fd3bd9a76fde0bde5a871ffe463081bcbf3738e4027df52

ready=false with exactly these blockers:

1. billing_start_unverified
2. billing_granularity_unverified
3. storage_cost_unverified
4. egress_cost_unverified
5. taxes_other_cost_unverified
6. auto_recharge_status_unverified

Deletion billing semantics are the one general provider behavior marked verified
from official documentation. The remaining fields are deliberately not inferred.

Evidence:
E:\nexus-training\evidence\brev-billing-terms-20261002

## Verification

- Billing targeted suite: 20/20 PASS on Windows.
- Same suite: 20/20 PASS on pinned Linux runtime.
- Billing + canonical IMC regression set: 40/40 PASS.
- py_compile: PASS.
- LSP/Pyright: 0 diagnostics.
- Ilaria GOWORK=off go test -count=1 -timeout 180s ./...: PASS,
  8 test-bearing packages.
- Ilaria go vet ./...: PASS.

No provider mutation, cloud allocation, paid compute, payment/account read,
Terms acceptance, secret read, Bridge/config mutation, stage, commit, push or
deploy occurred.
