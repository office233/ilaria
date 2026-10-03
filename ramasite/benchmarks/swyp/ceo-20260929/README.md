# Historical Swyp benchmark cases

These screened compiler cases, harness scripts, assembly observations and dated
reports were preserved from CEO. They are useful regression and research inputs,
not a replacement for the current compiler and not current performance claims.

`SOURCES.json` records each original CEO-relative path, raw SHA256 and length.
Original directory names are retained so reports and their cases stay associated.
Repeated source bytes are identified in that manifest; Git deduplicates identical
blobs without erasing dated evidence. Raw digests describe the local import;
repository text normalization still follows `.gitattributes`.

The import excludes compiler executables, caches, installation archives, logs,
worktree implementations and private coordination material. The complete original
CEO repository and unintegrated work are preserved separately, not committed here.

## Manual reproduction

Review the original report's toolchain, flags, inputs and CLI assumptions first.
Older source syntax and server commands may differ from the current Swyp release.
Do not execute every archived harness automatically.

For a selected compatible case:

1. Copy its source folder into a **new** run directory under
   `ramasite\benchmarks\swyp\build` (ignored build output).
2. Enter the current `swyp` product module, set `GOWORK=off`, and build
   `.\cmd\swyp` with `go build -o <absolute-run-directory>\swyp.exe`.
3. Compile C references with the flags recorded in the dated report.
4. Run the selected Python harness from the new run directory.

The two server `bench.py` scripts specifically expect `swyp.exe` beside the
script and generate local cache/executable outputs. Supply that freshly built
binary; do not reuse a historical executable or write outputs into product roots.
Reproduction requires compatible CLI behavior and the reported host/toolchains;
preserving source is not evidence that old measurements reproduce today.
