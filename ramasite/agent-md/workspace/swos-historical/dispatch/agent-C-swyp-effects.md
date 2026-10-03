# SWOS M1 — Agent C: Swyp effects/capabilities semantics

WORKTREE EXCLUSIV: E:\CEO\wt\swos-swyp-effects-m1
BASE: cc688dd
Lucrezi numai în modulul swyp/.

Citește:
- E:\CEO\specs\mission-swypikos-ilaria.md
- E:\CEO\projects\swos\analysis\00-master-plan.md
- E:\CEO\projects\swos\analysis\04-ilaria-swyp.md
- E:\CEO\wt\swos-swyp-effects-m1\AGENTS.md
- swyp\README.md, docs/SEMANTIC_CORE.md, docs/ARCHITECTURE.md

Auditul era pe 96290fa; inspectează live cc688dd.

## Invariant
Pure Core rămâne determinist și fără ambient authority. Effect declaration != capability. Capability este referință opacă furnizată de SwypikOS; guest code nu poate fabrica authority. Swyp descrie effects/tasks; SwypikOS broker execută ulterior.

## Implementare
1. Extinde Core IR cu reprezentare versionată strictă pentru effects și required capabilities, sau echivalent bine justificat.
2. Strict validation: duplicate/unknown/malformed fail closed; stable/canonical representation.
3. Toate programele pure existente rămân compatibile.
4. Syntax frontend doar minimală și testată dacă e necesară.
5. Verifier/prepare/report marchează pure vs effectful; Core executor NU execută host effects.
6. Docs: EffectRequest/EffectResult + Tool ABI v1 boundary cu SwypikOS capability broker.
7. Negative tests pentru capability fabrication/unknown effect + round-trip/backward compatibility.
8. Nu implementa syscall/FFI/network/fs direct în VM.

Scope writes: swyp\internal\coreir\**, swyp\internal\swyplang\**, swyp\docs\**, swyp\examples\**.

## Gemini accelerator
provider_status; dacă Antigravity/Gemini 3.8 Flash AVAILABLE, MAXIM 5 antigravity_submit read-only pentru design critique/schema review/test generation. Dacă unavailable, continui.

## Reguli
Nu citi data/cuda/.env/secrets. Nu commit/push/deploy. gofmt + diagnostics. Final din swyp: go vet ./... și go test -count=1 -timeout 180s ./...; git diff final.

Raport final: semantic contract nou, compatibility, ce trebuie ulterior în SwypikOS broker.
