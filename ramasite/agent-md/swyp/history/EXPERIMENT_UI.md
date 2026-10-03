# Static versus dynamic layout experiment

This is a six-element Go geometry toy, not a Swyp UI backend or GPU benchmark.
Its own approximated text metrics and a chosen 44-pixel target-size policy are
used to score layout. These checks are not a WCAG compliance audit.

Run: `go run ./experiments/layout`

The fixed geometry fails some resize, German-text and font-scaling scenarios.
The dynamic geometry passes the toy checks in all five supplied scenarios.
This supports recomputing input-dependent geometry when inputs change. It does
not prove that this layout engine handles general scripts, shaping, accessibility,
complex widgets or all viewport sizes.

Actual output is in NON_LLM_EXPERIMENT_RUNS.txt. Reported ns/op values measure
only this tiny geometry routine while other work may be running. They exclude
rendering, fonts, GPU transfer, event handling and platform integration, so do
not establish a production frame rate or a CPU-versus-GPU performance result.

Proposed Swyp direction: precompute invariant resources and constraints, cache
computed layout, and invalidate on relevant changes. Vulkan/Metal/WebGPU
backends and the native widget/event/accessibility systems are not implemented.
