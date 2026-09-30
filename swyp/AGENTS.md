# AGENTS.md — Swyp Lang

Swyp is the semantic and verification layer of the platform.

Owns parser/checker, Semantic Core IR, contracts, capabilities/effects,
verification, synthesis, component schemas and FFI declarations.

It must remain deterministic and independently buildable. Model access is
optional; no correctness property may depend on an LLM being available.

Required gate:

```powershell
go vet ./...
go test -count=1 ./...
```

Do not import Ilaria or SwypikOS internal implementation packages. Integrate
through stable schemas/protocols.
