# Brev offer selector

Read-only catalog policy for the temporary multi-GPU validation window.

The selector never calls Brev and never creates an instance. It consumes a captured,
timestamped catalog plus an explicit policy. It considers only one catalog entry with
the required GPU count, so eight unrelated 1-GPU instances are never aggregated into
an apparent 8-GPU host.

Ranking is explicit policy, not hidden model preference. H200 can stay first while
the fallback ordering between B200 and H100 is supplied explicitly by the policy.
Within one family the lower projected compute cost wins. VRAM, compute capability,
GPU count and total compute budget must all pass.

Budget is evaluated from the catalog's total VM hourly quote multiplied by the
planned billable hours; it is never multiplied again by GPU count. A separate reserve
and prior spend are subtracted from the authorized budget before eligibility.

preferred_candidate is not allocation authority. allocation_ready also requires
separate proof that billing terms and ancillary costs are understood, physical
topology is verified, and deployment Terms were explicitly accepted. Even then this
module always emits allocation_authorized=false; actual allocation remains an
operator action behind the independent budget and lifecycle gates.
