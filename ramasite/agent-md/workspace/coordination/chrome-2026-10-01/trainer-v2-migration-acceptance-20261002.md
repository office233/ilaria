# Clean code pilot v2 trainer migration acceptance

State: INTEGRATED / LOCAL GATES PASS / REAL TRAINING NOT AUTHORIZED.

Selective integration source:
`E:\nexus-worktrees\trainer-v2-migration-20261002`,
branch `codex/trainer-v2-migration-20261002`.

The Main precondition for `ilaria/forge/train_ilaria.py` was
`1b8622444d94dc946d5d8011470fda25888d5651745d049684c232b21c5f0dfb`.
All three new paths were absent before integration. The four frozen claims were
copied byte-for-byte and re-read from Main:

- `ilaria/forge/train_ilaria.py`:
  `568494437fd3eb419ee502f5d9e352b9828ffd6ca494e5741d29dc4a2aa4a4ed`
- `ilaria/forge/qualified_pilot_v2.py`:
  `e15294b4f0f54b0dfb0e64b9a045287042b2513513569854901a7fda33018de1`
- `ilaria/forge/test_qualified_pilot_v2.py`:
  `0c4134f6a56117afcd6e232c20eb1fce7b44310a00102c796a9392d687570b40`
- `docs/coordination/chrome-2026-10-01/trainer-v2-migration-handoff.md`:
  `11e49c10758b20f26e6ed9478814c8600acaefbbd363e345bdde2d3ccda3e664`

Post-integration Main verification:

- canonical py_compile gate: PASS;
- affected Python tests including IMC: 301 passed in 83.17 s;
- `GOWORK=off go test ./...`: 12 packages passed, zero failed;
- `GOWORK=off go vet ./...`: PASS;
- tracked `git diff --check`: PASS;
- new-file no-index whitespace checks: no diagnostics.

The real clean-v2 artifact set also passed the new byte/provenance validator,
but no real launch decision was synthesized or auto-approved. The adapter
retains `promotable=false` and `allocation_authorized=false`; H200 launch
still requires the remaining independent operational/data/cloud gates.

Evidence root:
`E:\nexus-training\evidence\trainer-v2-migration-20261002`.

`LIVE_STATE.md` and `RESTART_HERE.md` were intentionally not edited here
because they remain claimed by the active Nexus takeover owner.
