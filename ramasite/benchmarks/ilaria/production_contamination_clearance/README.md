# Production contamination clearance

This package creates evidence for the production-readiness contamination gate. It
does not create datasets, train tokenizers, approve rights, promote models or
authorize compute.

There are deliberately two implementations:

- scan.py performs the producer scan and emits
  ilaria-production-contamination-scan-v1.
- verify.py does not import scan.py. It reparses every input, rehashes corpus,
  tokenizer sample and selection ledger bytes, independently recomputes all
  counters, compares the producer scan, and only then can emit
  ilaria-production-contamination-clearance-v1.

A clearance is emitted only when all five required checks are exact integer zero:

- train_validation_exact_overlap
- tokenizer_heldout_exact_overlap
- tokenizer_heldout_normalized_overlap
- dataset_benchmark_shingle_overlap
- group_overlap

Canonical semantics are reused rather than redefined:

- normalized document identity: data_audit.document_sha256
- benchmark contamination: data_audit.shingle_hashes with the input-bound width
  (production policy is width 12)
- tokenizer exact fragment: CR/LF -> space, strip, append one LF, matching
  production_tokenizer_lineage
- content identities: data_contract.canonical_json_sha256

The input package must explicitly provide train, validation and sealed JSONL
artifacts. Every corpus row must contain non-empty text and an explicit group
field chosen by the input manifest. The verifier never invents or derives a group
identity. Tokenizer selection metadata, ledger and sample are byte/hash checked;
ledger emitted byte ranges must cover the sample exactly.

Benchmark artifacts in the package must match the benchmark artifacts already
bound by production readiness. Heldout evidence always includes the production
validation stream binding, all validation package artifacts, at least one sealed
artifact, and the frozen benchmark artifacts.

Operational limits cap row sizes, ledger row sizes, files and documents. Both
passes use temporary SQLite indexes so production-scale hash sets do not need to
be retained as Python object graphs.

Important limits:

- lexical word-shingle exclusion does not prove semantic/paraphrase independence;
- source-origin replay for tokenizer selection remains the production tokenizer
  lineage validator's authority; this package validates sample/ledger byte
  consistency and heldout separation;
- a clearance is valid only for its exact dataset/tokenizer/freeze/benchmark
  binding and exact heldout inventory;
- allocation_authorized and promotion_authorized are always false.

Current project state: the mechanism is implemented and interoperates with the
active production-readiness validator, but no production clearance is emitted
because the clean full production dataset manifest/tokenizer/freeze/sealed package
does not yet exist.
