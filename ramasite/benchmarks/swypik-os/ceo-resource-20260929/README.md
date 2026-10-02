# Historical SwypikOS resource evidence

These dated resource reports and samples were preserved byte-for-byte from the
CEO benchmark directories. `SOURCES.json` records original relative paths, raw
SHA256 values and lengths. No executables, user data, runtime logs or installed
tools are included.

This is historical process CPU/RSS evidence, not a current performance gate,
an energy measurement or a universal device-memory guarantee. Host load, binary
identity, resource profile and readiness semantics differ between runs. Early
runs may predate corrected font-ready detection; inspect each report before
comparing a field labelled steady or idle.

Where recorded, retain the original `git_revision`, `git_dirty`, executable
SHA256, profile, run timestamps and sample arrays. A dirty-build report must not
be presented as evidence for a different clean release.

For a new measurement, use the current independent harness from the Nexus root:

```powershell
powershell -File ramasite\benchmarks\swypik-os\scripts\benchmark-resources.ps1
```

Its output belongs in a fresh directory under
`ramasite\benchmarks\swypik-os\results`, not beside the product sources.
Do not overwrite these historical reports when collecting a new run.
