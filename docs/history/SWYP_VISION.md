# Swyp: the requested AI language vision

Version 0.3 update: inline intent expansion, separate repair candidates and an HTML/JavaScript scalar target are implemented. See [the workflow and its tested limits](SWYP_AI_WORKFLOW.md). Real-model generation remains unverified while Ilaria is offline; the table below is the earlier 0.2 planning baseline.

The supplied Omni conversation is a product vision for **Swyp Lang**, not evidence of implemented mechanisms or performance. This document translates its goals into testable requirements.

| Desired experience | Current status | Next acceptance criterion |
| --- | --- | --- |
| Natural language becomes a working program | Optional Ilaria draft adapter; static validation; saved source. Model service is offline. | Real-model evaluation on held-out tasks using independent behavior tests. |
| Fast development and native production | Interpreter and scalar C/GCC native backend. | Broader semantic parity, feature coverage, build and application latency measurements. |
| Clear errors and repairs | English diagnostics with source positions; names/types/return checks. | Structured diagnostics, candidate patches as diffs, tests and rollback. |
| One codebase across devices | Windows amd64 tested. | Separate web/mobile/Linux targets, API contracts, accessibility and deployment tests. |
| Generated standard modules | Not implemented. | A finite curated library with contracts, tests, version locks and provenance. |
| Faster training | Real two-parameter CPU gradient descent. | Tensor/GPU integration and matched-quality comparison with optimized frameworks. |
| Adaptive optimization | GCC optimizes generated C. | Profile-guided choices and validated transformations with measured tuning costs. |

Natural-language tasks must produce explicit requirements and source artifacts. “Compress by 30%” could refer to dimensions, quality or bytes. Type checking cannot resolve that ambiguity. Future inline intent directives should expand into pinned, editable modules with the request and generator version recorded; they should not generate a different application on every build.

SMS, email, payment, database and cloud modules need real configured providers and interfaces. Generated code cannot create an account, credentials or delivery guarantee merely by describing them. Test provider adapters with local fixtures before external actions.

A repair system can detect some errors and suggest changes. It cannot guarantee that every logical bug, race, outage or resource exhaustion disappears. Formal methods prove specified properties under assumptions; simulation or neural predictions alone are not proofs. Automatic production mutation is not part of the current design.

“Below hardware,” “zero cost for every program,” “infinite library,” “80% cost reduction,” and “perfect first attempt” need definitions and evidence before becoming engineering claims. The supplied concept also does not establish the first AI-oriented language in history.

Next: evaluate the draft adapter with an explicitly configured Ilaria service; introduce structured diagnostics and repair previews; add arrays and library boundaries with ownership/bounds rules; demonstrate a real optional UI component; then measure tensor work against optimized CPU/GPU implementations. The compiler will not silently provision or replace the model.
