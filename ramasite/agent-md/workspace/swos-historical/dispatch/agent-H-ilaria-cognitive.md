# ILARIA M1 — Cognitive Lifecycle Integration

WORKTREE EXCLUSIV: E:\CEO\wt\swos-ilaria-cognitive-m1
BASE: a5a8175. Nu lucra în E:\nexus main.
Respectă integral E:\CEO\wt\swos-ilaria-cognitive-m1\AGENTS.md. Nu citi data/, cuda/, weights, .env sau secrete.

Citește:
- E:\CEO\specs\mission-swypikos-ilaria.md
- E:\CEO\projects\swos\analysis\00-master-plan.md
- E:\CEO\projects\swos\analysis\04-ilaria-swyp.md
- cortex/organism.go
- cortex/hippocampus.go
- cortex/working_memory.go
- cortex/semantic_memory.go
- cortex/attention.go
- runtime-ul BitNet/Runner și cmd/ilaria-serve/chat/swyp relevant.

OWNER GOAL: Ilaria este organism cognitiv, NU simplu LLM. BitNet/modelul este cortex de limbaj/inferență.

Construiește primul lifecycle coerent, fără al doilea chatbot:
1. Definește LanguageCortex interface independent de model concret:
   Generate/Reason/ToolTurn cu request/response typed, model/version identity și bounded context.
2. Definește CognitiveState/TurnContext:
   goal/task identity, attention focus, working-memory refs, episodic recall refs, semantic recall refs, prior outcomes.
3. Creează un CognitiveRuntime/OrganismRuntime adapter care:
   - pregătește contextul din Organism/memories/attention;
   - apelează LanguageCortex;
   - produce structured decision/tool proposal;
   - primește Outcome/Evidence;
   - actualizează episodic/semantic/working-memory prin APIs existente, fără duplicare de stores.
4. Nu înlocui Organism cu RAG. Retrieval este mecanism auxiliar.
5. Nu permite modelului să execute tools direct; output-ul este proposal pentru SwypikOS/Swyp authority plane.
6. Persisted cognitive identity/version: schema/version IDs and deterministic metadata, fără a salva hidden chain-of-thought.
7. Trajectory event format: observable input/context refs, proposal, tool request IDs, external evidence/result, verifier outcome, final response/outcome.
8. Tests:
   - memory recall influences next turn;
   - attention/working memory bounded;
   - outcome is stored/consolidated;
   - model identity/version captured;
   - tool proposal cannot execute directly;
   - restart serialization round-trip of cognitive state metadata;
   - no hidden CoT field in trajectory schema.
9. Provide adapter around current BitNet Runner where feasible without reading weights or launching training; otherwise define compile-tested interface seam and exact remaining wiring task.
10. Docs/ILARIA_COGNITIVE_RUNTIME.md explaining organism vs language cortex vs OS authority.

Scope write should stay in cortex/**, a narrow internal adapter package if necessary, and docs relevant to Ilaria. Avoid broad cmd rewiring unless tests prove it safe.

Gemini MAX 5 read-only if available for cognitive architecture critique, memory lifecycle and eval design. Tu ești singurul autor.

Final: gofmt; go test -count=1 -race ./cortex; go vet ./...; go test -count=1 -timeout 180s ./...; git diff --check.
No training, no global installs, no commit/push/deploy.