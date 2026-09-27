# English tool-use smoke pilot

Generated with `go run ./cmd/ilaria-pilot-data` (requires a new output directory).
Contains 209 training, 25 validation, and 23 reserved test trajectories.
Calculator and conversion observations come from executing the actual Go tools;
direct responses and clarification examples are manually authored synthetic data.
No external model generated these examples.

The split is deterministic by task ID (SHA-256). Arithmetic and conversion
templates are shared across splits, so this is a pipeline smoke test, not an
independent benchmark of reasoning, product readiness, or general capability.
The test split must not be used for training or choosing checkpoints.

This pilot trains a new text LoRA adapter on the frozen BitNet language base.
It does not resume or overwrite the existing multimodal Stage 2 checkpoint.
Start with 50 optimizer steps; evaluate executed tool calls before scaling.
