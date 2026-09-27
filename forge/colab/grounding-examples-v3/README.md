# Grounding stage v3

781 training / 189 validation rows. Behavior v2 replay plus actual Go calculator
failures, missing-source-unit clarification followed by real conversion, honest
unsupported-action responses, and text-only drafting. No network, email, file
deletion, or external action tool executes in the generator.

Generate tool examples with `go run ./cmd/ilaria-grounding-data`, then combine
with `python -m forge.colab.build_grounding_data`. Both require new output
directories. All observations in new tool trajectories are actual Go ChatTool
results. The new final answers are synthetic, reviewed templates.

Keep clarification and its completed conversation in the same split. Values
and document subjects differ across training/validation, but templates and
action types are shared; validation is a smoke metric, not a broad benchmark.
The 35 existing regression prompts and 16 newly frozen challenge prompts are
excluded. No Romanian vocabulary examples were added; this stage targets
English tool grounding, not multilingual capability.

Warm start from behavior v2 step100, new optimizer, rank16/alpha32, lr5e-5,
batch1/accum8, 250 optimizer steps, checkpoint every50, separate Drive run.
