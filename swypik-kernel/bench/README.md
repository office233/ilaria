# OS-base benchmark harness skeleton

`benchmark-schema-v1.json` is the shared record shape for the Swypik-owned seed and the isolated Linux reference candidate.
The four initial comparable metrics are boot latency, IPC round-trip latency, memory overhead, and fault-recovery latency.

`benchmark_harness.c` only emits a versioned NDJSON record from supplied measurements. It does not invent measurements.
The build script emits one `placeholder` record with zeroes so downstream tooling can validate the shape before QEMU is available.
A real benchmark runner must replace those values with measured evidence and set `status` to `measured`.
