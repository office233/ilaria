# Repair experiment — rejected for integration

Antigravity produced `experiments/repair/main.go` but its session ended with API
error 500. Codex ran the prototype independently. Its eight toy checks print
success, but review found that those checks do not establish the stated guarantees.

Concrete defects:

- Matching an expression on a finite set is labeled `Semantics-Preserving`.
  In case 5, `(x+2)/x` becomes `2-(x*(x-2))`. At x=3 they produce 5/3 and -1.
- Budget exhaustion is labeled `Unsatisfiable`, which is unjustified.
- A budget of 2000 reports 2002 candidates, and a budget of 20 reports 21.
- Algebraic cancellations can change float64 rounding and exception behavior.
- Observational signatures use 10 significant digits, merging distinct floats.

The prototype is retained as an explicitly rejected research artifact. It is
not imported by the compiler or CLI and must not be used to apply repairs.
Its output is historical experimental evidence, not a proof report.

A replacement should use the tested synthesis budget machinery, report matches
as example-only, preserve unknown/exhausted separately from proved impossible,
and require a contract for any change in error behavior. No general autonomous
repair or semantic equivalence checker was integrated in this iteration.
