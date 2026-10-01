# Historical standalone workflows

These YAML files preserve the former standalone SwypikOS workflow definitions.
GitHub only executes workflows under the repository root's `.github/workflows`;
their old product-local location was inactive in the Nexus monorepo. Active
cross-product verification now lives in the root workflow.

`native-windows.yml` documents native GUI/console PE validation, package manifests
and artifact capture. `verify.yml` documents the separate RAM-only Linux ISO and
diskless BIOS/UEFI QEMU checks. They are reference material, not CI execution
evidence. Useful packaging and VM checks can be added to root CI as explicit
jobs without maintaining a second conflicting verification pipeline.
