# No-crypto runtime cleanup

State: STOP/FROZEN — TARGETED GATES PASS, READY FOR SELECTIVE INTEGRATION.

Owner: current ChatGPT session.
Branch: `codex/no-crypto-runtime-20261002`.
Worktree: `E:\nexus-worktrees\no-crypto-runtime-20261002`.

Claims:

- `swypik-os/config/config.go`
- `swypik-os/core/azure/{schema.go,coordinator.go,azure_test.go}`
- `swypik-os/core/wallet/*`
- `swypik-os/core/l402/*`
- this handoff

Goal: remove the remaining shipped SWP reward/wallet and Lightning/L402
settlement behavior while keeping non-monetary compute-receipt metadata and
backward-compatible reading of legacy Azure cache files. No Myriad schema is
claimed because it is owned by the active memory takeover.

## Result

- removed `RewardPerTflop` and `SWYPIK_SWARM_REWARD_PER_TFLOP`;
- Azure keeps verified compute receipts but no `RewardSWP`, SWP balance,
  wallet projection/table, or reward column;
- old Azure cache files may still be read, but legacy `wallets` data is
  ignored and is not written back;
- `core/wallet` is now a compatibility tombstone that fails closed instead
  of shipping balances, transfers or reward crediting;
- `core/l402` is now a compatibility tombstone that fails closed instead of
  shipping Lightning/L402 invoice or settlement behavior.

The current Main dependency audit found no callers of the wallet/L402 APIs
outside their own tests, and no `RewardPerTflop` caller outside config. The
canonical current Swarm path had already moved real work to
`ExecuteVerifiedRound`; the random `ComputeMicroBatch` implementation is
test-only in current Main. Historical HEAD copies of swarm/federated in this
worktree were therefore not edited.

## Verification

- `gofmt`: applied to all changed Go files;
- `git diff --check` on claimed files: PASS;
- `go test -count=1 ./config ./core/azure ./core/wallet ./core/l402`:
  four packages PASS;
- `go vet ./config ./core/azure ./core/wallet ./core/l402`: PASS;
- baseline integrity: eight seeded files changed, five intentionally removed,
  and `go.mod`/`go.sum` stayed byte-identical.

Full current-Main SwypikOS gates must be rerun after selective integration,
because this worktree intentionally uses the historical repository HEAD plus
only the current files needed for this isolated cleanup.

No stage, commit, push, deploy, secrets, cloud allocation, model/checkpoint
access, Bridge configuration changes, or edits to other owners are authorized.
