# Nexus / Ilaria bridge

This package implements the `Name`, `Match`, `Execute` interface inspected in
`D:/nexus/cortex/tools.go`. It invokes one explicitly configured Swyp executable
with the fixed `worker` argument, sends bounded JSON on stdin and checks the
returned source hash. It does not invoke Ilaria, a shell or generated source.

The actual worker internally evaluates only synthesized bounded arithmetic.
Source and its versioned operation graph are returned as a candidate; no file
is written, no service is started, and no running code is replaced.

Integration at Nexus's tool-registry construction point can use:

```go
tool, err := nexusbridge.NewTool(`D:\swyp lang\bin\swyp.exe`)
if err != nil { return err }
registry.Register(tool) // registry is a *cortex.ToolRegistry
```

Import path: `swyp-lang/bridge/nexus` (package name `nexusbridge`). A local module
replacement for `swyp-lang` is required when building Nexus; registration and
that dependency have deliberately not been installed into the Nexus checkout.
The adapter is independently tested with the real Swyp executable. Live Nexus
registration remains an integration step, not a completed deployment.

The Nexus `Tool` contract permits fallback when `Execute` returns false. A host
requiring a strictly model-free `swyp:` route must handle that failure explicitly
instead of falling through to neural inference. The adapter itself never calls a model.

An explicit request is `swyp: {"examples":[{"x":0,"y":0},{"x":1,"y":1}],
"validation":[{"x":2,"y":4}]}`. The JSON must be on one logical string.

Nexus SDRs may be used to route tasks or retrieve specifications in future. They
do not currently decode into executable operations. The inspected `/v1/chat`
endpoint belongs to BitNet inference and is not the model-free synthesis path.
