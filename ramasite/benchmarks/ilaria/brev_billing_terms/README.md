# Brev billing-terms gate

Read-only validation of billing evidence for exactly one selected offer.

This module does not access the Brev account, change Auto Recharge, allocate
resources, read payment methods, or execute cloud actions. It consumes a reviewed
content-addressed evidence packet plus a strict budget policy.

A billing packet is ready only when all of these are explicit and fresh:

- exact selection/offer/provider/cloud binding;
- USD TOTAL_PER_VM hourly quote matching the selected catalog offer;
- verified billing start phase;
- explicit billing granularity;
- provider documentation that deletion ends charges;
- bounded maximum storage, egress and taxes/other costs;
- current Auto Recharge status verified and disabled;
- official/current source references.

The gate rounds compute cost upward to the configured billing quantum, reserves
a separate ancillary budget, and fails if either compute exceeds the compute
budget, ancillary maxima exceed the reserve, or projected all-in spend exceeds
the human-authorized total.

Official documentation can establish general Brev lifecycle semantics, but it
cannot substitute for organization-specific Auto Recharge state or offer-specific
storage/egress/tax evidence. Missing information remains a blocker.
