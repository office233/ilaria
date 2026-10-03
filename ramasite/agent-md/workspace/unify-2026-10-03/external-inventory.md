# Nexus Unified External Inventory & Migration Plan

**Generated:** 2026-10-03 10:32:25  
**Canonical Checkout:** `E:\nexus` (Origin: `github.com/office233/ilaria`)  
**Active Inspection Branch:** `chore/nexus-unify-20261003`  

---

## 1. Executive Summary & Category Totals

A comprehensive, read-only audit of all external repositories, workspaces, caches, and worktrees was conducted to prepare for unifying all Nexus engineering assets into `E:\nexus` while isolating non-Nexus portfolio assets.

| Category | Item Count | Total Size (MB) | Total Files | Destination Policy |
|---|---|---|---|---|
| `conversation-archive` | 1 | 9.97 MB | 33 | `ramasite/local/conversatii-claude/` (git-ignored) |
| `nexus-agent-record` | 5 | 0.82 MB | 85 | `ramasite/agent-md/<product>/` or `ramasite/agent-md/workspace/` |
| `nexus-benchmark-evidence` | 28 | 1,512.57 MB | 9,751 | `ramasite/benchmarks/<product>/` |
| `nexus-git-worktree` | 36 | 4,205.18 MB | 101,147 | Prune/remove if clean; reconcile dirty unique work before removal |
| `nexus-source` | 18 | 8,930.16 MB | 411,883 | Product roots (`ilaria/`, `swyp/`, `swypik-os/`, `swypik/`, `site/`) or `ramasite/local/sources/` |
| `nexus-tool-or-binary` | 19 | 3,252.06 MB | 18,034 | `ramasite/local/tools/` (git-ignored) or discard if rebuildable |
| `non-nexus` | 21 | 668.59 MB | 455 | Preserve in `E:\arhiva-ceo` (Meister ERP, GPT Bridge, CEO governance) |
| `unclear` | 5 | 34.39 MB | 64 | Review with user |

### Key Inventory Metrics
- **Total Top-Level Items Audited:** 133
- **Total Git Worktrees Registered:** 68 (Safe to remove: **17**, Requiring dirty reconciliation: **51**)
- **Arhiva-CEO Git History:** 10 commits, 44 tracked files (governs entire CEO portfolio, preserved outside Nexus)
- **Secrets Check:** No uncommitted `.env`, API credentials, private tokens, or SSH private keys discovered in target working trees.

---

## 2. Git Worktrees Audit (68 Registered Worktrees)

All registered worktrees from `git worktree list --porcelain` were audited for disk presence, ahead commits against `HEAD`, dirty files, and unique uncommitted work not in `E:\nexus`.

| Worktree Path | Branch | Ahead Commits | Dirty Files | Safe to Remove? | Action / Blocker Details |
|---|---|---|---|---|---|
| `E:/nexus` | `chore/nexus-unify-20261003` | 0 | 728 | **NO** | KEEP (Canonical Workspace Root) |
| `C:/Users/abel/.codex/worktrees/ilaria-brev-data/nexus` | `codex/ilaria-brev-data` | 0 | 111 | **NO** | BLOCKER: Uncommitted unique work (new: ilaria/bench/imc_125m_data_inventory/candidate-inventory.json, new: ilaria/bench/myriad/pce_transfer_v1/benchmark_test.go) |
| `C:/Users/abel/.codex/worktrees/ilaria-brev-ddp/nexus` | `codex/ilaria-brev-ddp` | 0 | 102 | **NO** | BLOCKER: Uncommitted unique work (new: ilaria/bench/imc_125m_data_inventory/candidate-inventory.json, new: ilaria/bench/myriad/pce_transfer_v1/benchmark_test.go) |
| `C:/Users/abel/.codex/worktrees/ilaria-data-research/nexus` | `codex/ilaria-data-research-20261001` | 0 | 4 | **NO** | BLOCKER: Uncommitted unique work (new: ilaria/docs/research/ILARIA_TRAINING_DATA_REVIEW_2026-10-01.md, new: ilaria/docs/research/hf_dataset_metadata_2026-10-01.json) |
| `C:/Users/abel/.codex/worktrees/ilaria-incremental-inference/nexus` | `codex/ilaria-incremental-inference` | 0 | 91 | **NO** | BLOCKER: Uncommitted unique work (new: ilaria/bench/myriad/pce_transfer_v1/benchmark_test.go, differs: ilaria/forge/curate_corpus.py) |
| `C:/Users/abel/.codex/worktrees/ilaria-inference-cache-budget-fix/nexus` | `codex/ilaria-inference-cache-budget-fix` | 0 | 11 | **NO** | BLOCKER: Uncommitted unique work (differs: ilaria/forge/train_ilaria.py, new: .nexus-cache-budget-fix-baseline.json) |
| `C:/Users/abel/.codex/worktrees/ilaria-packed-matvec/nexus` | `detached` | 0 | 4 | **NO** | BLOCKER: Uncommitted unique work (new: .nexus-packed-matvec-baseline.json, new: docs/coordination/chrome-2026-10-01/ilaria-packed-matvec-handoff.md) |
| `C:/Users/abel/.codex/worktrees/imc-consent-revocation/nexus` | `codex/imc-consent-revocation` | 0 | 61 | **NO** | BLOCKER: Uncommitted unique work (differs: swypik-os/config/config.go, differs: swypik-os/core/federated/federated.go) |
| `C:/Users/abel/.codex/worktrees/imc-nccl-bootstrap/nexus` | `codex/imc-nccl-bootstrap` | 0 | 3 | **NO** | BLOCKER: Uncommitted unique work (new: docs/coordination/chrome-2026-10-01/imc-nccl-bootstrap-handoff.md, new: ilaria\bench\imc_nccl_bootstrap\probe.py) |
| `C:/Users/abel/.codex/worktrees/imc-supervisor-containment/nexus` | `codex/imc-supervisor-containment` | 0 | 2 | **NO** | BLOCKER: Uncommitted unique work (new: ilaria\bench\imc_nccl_bootstrap\containment.py) |
| `C:/Users/abel/.codex/worktrees/imc125-training-gates/nexus` | `codex/imc125-training-gates` | 6 | 1 | **YES** | SAFE: `git worktree remove` (Commits in git; clean or duplicate dirty files) |
| `C:/Users/abel/.codex/worktrees/imc1b-azure-a100/nexus` | `codex/imc1b-azure-a100` | 7 | 1 | **YES** | SAFE: `git worktree remove` (Commits in git; clean or duplicate dirty files) |
| `C:/Users/abel/.codex/worktrees/p2p-resume-genesis-fix/nexus` | `codex/p2p-resume-genesis-fix` | 0 | 76 | **NO** | BLOCKER: Uncommitted unique work (differs: swypik-os/config/config.go, differs: swypik-os/core/federated/federated.go) |
| `C:/Users/abel/.codex/worktrees/qualified-code-pilot-adapter-20261002/nexus` | `codex/qualified-code-pilot-adapter-20261002` | 0 | 26 | **NO** | BLOCKER: Uncommitted unique work (differs: ilaria/forge/train_ilaria.py, new: docs/coordination/chrome-2026-10-01/qualified-code-pilot-adapter-handoff.md) |
| `C:/Users/abel/.codex/worktrees/qualified-tokenizer-contract/nexus` | `codex/qualified-tokenizer-contract-20261002` | 0 | 34 | **NO** | BLOCKER: Uncommitted unique work (differs: ilaria/forge/train_ilaria.py, new: docs/coordination/chrome-2026-10-01/production-tokenizer-lineage-handoff.md) |
| `C:/Users/abel/.codex/worktrees/swypik-ilaria-gateway/nexus` | `detached` | 0 | 27 | **NO** | BLOCKER: Uncommitted unique work (differs: ilaria/forge/dataset_manifest.py, differs: ilaria/forge/imc_model.py) |
| `C:/Users/abel/.codex/worktrees/swypik-ilaria-reconciled/nexus` | `codex/swypik-ilaria-reconciled` | 0 | 27 | **NO** | BLOCKER: Uncommitted unique work (new: docs/coordination/chrome-2026-10-01/swypik-ilaria-reconciliation-handoff.md, differs: swypik-os\internal\planprocess\process.go) |
| `C:/Users/abel/.codex/worktrees/trainer-preflight-20261002/nexus` | `codex/trainer-preflight-20261002` | 0 | 22 | **NO** | BLOCKER: Uncommitted unique work (differs: ilaria/forge/train_ilaria.py, new: docs/coordination/chrome-2026-10-01/trainer-data-admission-order-handoff.md) |
| `C:/Users/abel/.codex/worktrees/training-launch-gates-20261002/nexus` | `codex/training-launch-gates-20261002` | 0 | 4 | **NO** | BLOCKER: Uncommitted unique work (new: docs/coordination/chrome-2026-10-01/training-launch-gate-handoff.md) |
| `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-bookish-giggle` | `office233-verified-plan-approval` | 5 | 8 | **NO** | BLOCKER: Uncommitted unique work (differs: swypik-os/core/planapproval/README.md, differs: swypik-os/core/planapproval/model.go) |
| `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-congenial-engine` | `office233-swyp-native-byte-snapshots` | 7 | 0 | **YES** | SAFE: `git worktree remove` (Commits in git; clean or duplicate dirty files) |
| `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-curly-umbrella` | `agent/curatenie-nexus` | 0 | 0 | **YES** | SAFE: `git worktree remove` (Commits in git; clean or duplicate dirty files) |
| `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-didactic-telegram` | `office233-swypik-mobile-delivery` | 2 | 10 | **NO** | BLOCKER: Uncommitted unique work (differs: swypik/mobile/src/features/ilaria/IlariaScreen.tsx, differs: swypik/mobile/src/features/ilaria/useIlaria.ts) |
| `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-fantastic-guide` | `office233-supervisor-transport-reliability` | 5 | 2 | **NO** | BLOCKER: Uncommitted unique work (differs: swypik-os/internal/planprocess/process_test.go, new: swypik-os/internal/planprocess/process_eof_test.go) |
| `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-fantastic-succotash` | `office233-swyp-self-hosting` | 9 | 11 | **NO** | BLOCKER: Uncommitted unique work (differs: swyp/cmd/swyp/language.go, differs: swyp/internal/hir/hir.go) |
| `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-fluffy-journey` | `office233-swyp-bool-storage` | 5 | 0 | **YES** | SAFE: `git worktree remove` (Commits in git; clean or duplicate dirty files) |
| `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-friendly-giggle` | `office233-kernel-task-fault-isolation` | 5 | 0 | **YES** | SAFE: `git worktree remove` (Commits in git; clean or duplicate dirty files) |
| `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-jubilant-couscous` | `office233-clean-product-integration` | 11 | 0 | **YES** | SAFE: `git worktree remove` (Commits in git; clean or duplicate dirty files) |
| `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-reimagined-goggles` | `office233-ilaria-training-and-p2p` | 5 | 3 | **NO** | BLOCKER: Uncommitted unique work (new: ilaria/forge/clean_pilot_byte_qualification.py, new: ilaria/forge/test_clean_pilot_byte_qualification.py) |
| `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-studious-eureka` | `office233-bounded-process-execution` | 5 | 13 | **NO** | BLOCKER: Uncommitted unique work (differs: ilaria/generated/swypeffects/types_gen.go, differs: swyp/protocol/effects/types_gen.go) |
| `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-turbo-couscous` | `office233-turbo-couscous` | 0 | 0 | **YES** | SAFE: `git worktree remove` (Commits in git; clean or duplicate dirty files) |
| `C:/Users/abel/AppData/Local/Temp/2/opencode/nexus-audit-2026-10-02` | `fix/audit-regressions-2026-10-02` | 0 | 0 | **YES** | `git worktree prune` (Directory missing on disk) |
| `C:/Users/abel/AppData/Local/Temp/2/opencode/nexus-audit-fixes` | `fix/audit-integrity-2026-10-01` | 0 | 0 | **YES** | `git worktree prune` (Directory missing on disk) |
| `C:/Users/abel/AppData/Local/Temp/2/opencode/nexus-continue-transport-20261003` | `agent/nexus-continue-transport-20261003` | 11 | 4 | **NO** | BLOCKER: Uncommitted unique work (differs: swypik-os/internal/planprocess/process.go, differs: swypik-os/internal/planprocess/process_test.go) |
| `C:/Users/abel/AppData/Local/Temp/2/opencode/nexus-git-order-20261003` | `integration/nexus-git-order-20261003` | 14 | 0 | **YES** | SAFE: `git worktree remove` (Commits in git; clean or duplicate dirty files) |
| `E:/arhiva-ceo/wt/repo-separation-swyp2` | `agent/repo-separation-swyp2` | 0 | 762 | **NO** | BLOCKER: Uncommitted unique work (differs: .github/workflows/ci.yml, differs: .gitignore) |
| `E:/arhiva-ceo/wt/swos-compute-fabric-m1` | `chatgpt/swos/compute-fabric-m1` | 0 | 2 | **NO** | BLOCKER: Uncommitted unique work (new: swypik-os\core\computefabric\adversarial_test.go, new: swypik-os/docs/COMPUTE_FABRIC.md) |
| `E:/arhiva-ceo/wt/swos-control-kernel-m1` | `chatgpt/swos/control-kernel-m1` | 0 | 2 | **NO** | BLOCKER: Uncommitted unique work (differs: swypik-os\core\controlkernel\event_store.go, new: swypik-os/docs/ADR_CONTROL_KERNEL_EVENT_STORE.md) |
| `E:/arhiva-ceo/wt/swos-device-synthesis-m1` | `chatgpt/swos/device-synthesis-m1` | 0 | 3 | **NO** | BLOCKER: Uncommitted unique work (differs: swypik-os\core\devicesynth\abi.go, new: swypik-os/docs/DRIVER_SYNTHESIS_SECURITY.md) |
| `E:/arhiva-ceo/wt/swos-ilaria-cognitive-m1` | `chatgpt/swos/ilaria-cognitive-m1` | 0 | 4 | **NO** | BLOCKER: Uncommitted unique work (new: cortex/cognitive_runner.go, new: cortex/cognitive_runtime.go) |
| `E:/arhiva-ceo/wt/swos-install-adapt-m1` | `chatgpt/swos/install-adapt-m1` | 0 | 1 | **NO** | BLOCKER: Uncommitted unique work (new: swypik-os\core\installadapt\control_adapter.go) |
| `E:/arhiva-ceo/wt/swos-native-kernel-seed-m1` | `chatgpt/swos/native-kernel-seed-m1` | 0 | 1 | **NO** | BLOCKER: Uncommitted unique work (new: swypik-kernel\.gitignore) |
| `E:/arhiva-ceo/wt/swos-os-platform-m1` | `chatgpt/swos/os-platform-m1` | 0 | 12 | **NO** | BLOCKER: Uncommitted unique work (differs: swypik-os/cmd/swypikd/main_linux.go, new: swypik-os/docs/NATIVE_OS.md) |
| `E:/arhiva-ceo/wt/swos-security-p0` | `chatgpt/swos/security-p0` | 0 | 5 | **NO** | BLOCKER: Uncommitted unique work (differs: swypik-os/core/agent/workspace_tools.go, new: swypik-os/docs/COMMAND_LIFECYCLE.md) |
| `E:/arhiva-ceo/wt/swos-swyp-broker-host-v1` | `agent/swyp-broker-host-v1` | 3 | 0 | **YES** | SAFE: `git worktree remove` (Commits in git; clean or duplicate dirty files) |
| `E:/arhiva-ceo/wt/swos-swyp-effects-m1` | `chatgpt/swos/swyp-effects-m1` | 0 | 9 | **NO** | BLOCKER: Uncommitted unique work (new: swyp/docs/ARCHITECTURE.md, new: swyp/docs/SEMANTIC_CORE.md) |
| `E:/arhiva-ceo/wt/swos-universal-adaptive-m2` | `feat/universal-adaptive-runtime` | 0 | 69 | **NO** | BLOCKER: Uncommitted unique work (differs: AGENTS.md, differs: swypik-os/README.md) |
| `E:/nexus-worktrees/brev-billing-terms-20261002` | `codex/brev-billing-terms-20261002` | 0 | 3 | **NO** | BLOCKER: Uncommitted unique work (new: docs/coordination/chrome-2026-10-01/brev-billing-terms-handoff.md, new: ilaria\bench\brev_billing_terms\gate.py) |
| `E:/nexus-worktrees/brev-lifecycle-guard-20261002` | `codex/brev-lifecycle-guard-20261002` | 0 | 3 | **NO** | BLOCKER: Uncommitted unique work (new: docs/coordination/chrome-2026-10-01/brev-lifecycle-guard-handoff.md, new: ilaria\bench\brev_lifecycle_guard\guard.py) |
| `E:/nexus-worktrees/brev-offer-selector-20261002` | `codex/brev-offer-selector-20261002` | 0 | 3 | **NO** | BLOCKER: Uncommitted unique work (new: docs/coordination/chrome-2026-10-01/brev-offer-selector-handoff.md, new: ilaria\bench\brev_offer_selector\README.md) |
| `E:/nexus-worktrees/claude-f-i-20261002` | `codex/claude-f-i-20261002` | 0 | 479 | **NO** | BLOCKER: Uncommitted unique work (differs: ilaria/forge/config/corpus_strategy.json, differs: ilaria/forge/production_readiness.py) |
| `E:/nexus-worktrees/copilot-final-product-20261002` | `copilot/final-product-20261002` | 2 | 0 | **YES** | SAFE: `git worktree remove` (Commits in git; clean or duplicate dirty files) |
| `E:/nexus-worktrees/copilot-kernel-first-task-20261002` | `copilot/kernel-first-task-20261002` | 5 | 0 | **YES** | SAFE: `git worktree remove` (Commits in git; clean or duplicate dirty files) |
| `E:/nexus-worktrees/copilot-swyp-runtime-20261002` | `copilot/swyp-runtime-20261002` | 4 | 0 | **YES** | SAFE: `git worktree remove` (Commits in git; clean or duplicate dirty files) |
| `E:/nexus-worktrees/group-preserving-curation-v2-20261002` | `codex/group-preserving-curation-v2-20261002` | 0 | 6 | **NO** | BLOCKER: Uncommitted unique work (differs: ilaria/forge/curate_corpus.py, differs: ilaria/forge/test_curate_corpus.py) |
| `E:/nexus-worktrees/h200-recovery-cloud-20261002` | `codex/h200-recovery-cloud-20261002` | 0 | 911 | **YES** | SAFE: `git worktree remove` (Commits in git; clean or duplicate dirty files) |
| `E:/nexus-worktrees/h200-recovery-data-20261002` | `codex/h200-recovery-data-20261002` | 0 | 911 | **YES** | SAFE: `git worktree remove` (Commits in git; clean or duplicate dirty files) |
| `E:/nexus-worktrees/imc-nccl-hardware-gate-20261002` | `codex/imc-nccl-hardware-gate-20261002` | 0 | 4 | **NO** | BLOCKER: Uncommitted unique work (new: docs/coordination/chrome-2026-10-01/imc-nccl-hardware-gate-handoff.md, new: ilaria\bench\imc_nccl_bootstrap\containment.py) |
| `E:/nexus-worktrees/nexus-takeover-20261002` | `codex/nexus-takeover-20261002` | 0 | 918 | **NO** | BLOCKER: Uncommitted unique work (differs: AGENTS.md, differs: go.work) |
| `E:/nexus-worktrees/no-crypto-runtime-20261002` | `codex/no-crypto-runtime-20261002` | 0 | 15 | **NO** | BLOCKER: Uncommitted unique work (new: swypik-os/core/azure/azure_test.go, new: swypik-os/core/azure/coordinator.go) |
| `E:/nexus-worktrees/opencode-cleanup-matrix` | `codex/opencode-cleanup-matrix` | 0 | 254 | **NO** | BLOCKER: Uncommitted unique work (differs: swypik-os/README.md, differs: swypik-os/core/appstore/appstore.go) |
| `E:/nexus-worktrees/opencode-driver-conformance` | `codex/opencode-driver-conformance` | 0 | 166 | **NO** | BLOCKER: Uncommitted unique work (differs: swypik-os/README.md, differs: swypik-os/core/appstore/appstore.go) |
| `E:/nexus-worktrees/opencode-preamble-r3` | `codex/opencode-preamble-r3` | 0 | 133 | **NO** | BLOCKER: Uncommitted unique work (new: swyp/HANDOFF_2026-09-30_SWYP_NATIVE.md, differs: swyp/README.md) |
| `E:/nexus-worktrees/production-contamination-clearance-20261002` | `codex/production-contamination-clearance-20261002` | 0 | 4 | **NO** | BLOCKER: Uncommitted unique work (new: docs/coordination/chrome-2026-10-01/production-contamination-clearance-handoff.md, new: ilaria\bench\production_contamination_clearance\README.md) |
| `E:/nexus-worktrees/production-contamination-gate-20261002` | `codex/production-contamination-gate-20261002` | 0 | 103 | **NO** | BLOCKER: Uncommitted unique work (new: ilaria/bench/imc_125m_data_inventory/candidate-inventory.json, differs: ilaria/forge/config/corpus_strategy.json) |
| `E:/nexus-worktrees/production-strategy-alignment-20261002` | `codex/production-strategy-alignment-20261002` | 0 | 14 | **NO** | BLOCKER: Uncommitted unique work (new: ilaria/bench/imc_125m_data_inventory/candidate-inventory.json, new: docs/coordination/chrome-2026-10-01/production-strategy-alignment-handoff.md) |
| `E:/nexus-worktrees/trainer-v2-migration-20261002` | `codex/trainer-v2-migration-20261002` | 0 | 103 | **NO** | BLOCKER: Uncommitted unique work (differs: ilaria/forge/config/corpus_strategy.json, differs: ilaria/forge/production_readiness.py) |
| `E:/nexus-worktrees/trainer-v2-supervision-entry-20261002` | `codex/trainer-v2-supervision-entry-20261002` | 0 | 104 | **NO** | BLOCKER: Uncommitted unique work (differs: ilaria/forge/config/corpus_strategy.json, differs: ilaria/forge/production_readiness.py) |

---

## 3. Deep Dive: `E:\arhiva-ceo`

`E:\arhiva-ceo` is an independent Git repository (`master`, dirty) containing 77 top-level entries.

### A. Tracked Commits & Governance Boundary
The 10 tracked commits govern multi-project operations (Meister ERP, GPT Bridge, Therapium Movies, Nexus, Swypik). None of the tracked files are exclusively Nexus code. All top-level management files (`CONSTITUTION.md`, `PLAYBOOK.md`, `OS.md`, `PORTFOLIO.md`, `org/`, `memory/`, `runs/`) belong to generic company-level administration and **must stay in `E:\arhiva-ceo`**.

### B. Benchmark Directories vs `ramasite/benchmarks`
As verified during the audit:
- **94 benchmark evidence files** were already screened and committed into `ramasite/benchmarks/swyp/ceo-20260929` (63 files) and `ramasite/benchmarks/swypik-os/ceo-resource-20260929` (31 files).
- The leftover files inside `E:\arhiva-ceo\swyp-*-bench*` and `swypik-resource-bench*` consist of compiled test executables (`.exe`, `.test`, `swyp-linux-*`) and runtime run logs (`run-balanced/data/`). These are regenerable build artifacts.
- **Recommendation:** Mark all 35 benchmark directories in `E:\arhiva-ceo` as `discard: regenerable/duplicate` since the historical evidence is already safely in `ramasite/benchmarks/`.

### C. `_cloud-transfer` (668 MB)
- `chat-gpt-bridge.tgz` (179 MB): Backup bundle of ChatGPT Bridge project (**non-nexus**, stay in `arhiva-ceo`).
- `Swypik.tgz` (279 MB): Backup bundle of original `E:\Swypik` repository. All product source is already cleanly imported into `swypik/commerce`, `swypik/mobile`, and `site/`.
- `nexus.tgz` (210 MB): Backup bundle of Nexus. Redundant with Git repository.

### D. `tools/` (2,558 MB)
- Contains complete MinGW64 GCC toolchain, NASM assembler, and QEMU x86_64 emulator used for Swypik-OS UEFI kernel and native compiler builds.
- **Proposed Destination:** Move into git-ignored `ramasite/local/tools/`.

### E. `wt/` Non-Worktree Snapshots
- `swyp-hir-p3-20260929` (50.92 MB, 276 files): Contains 90 unique Swyp compiler files not in current `swyp/`. Proposed: `ramasite/agent-md/swyp/history/swyp-hir-p3-snapshot/`.
- `swypik-os-swyp-broker-20260929` (2.47 MB, 297 files): Standalone effect broker snapshot. Proposed: `ramasite/agent-md/swypik-os/history/swyp-broker-snapshot/`.
- `swyp-broker-integration-20260929` (0.00 MB, 1 file): Integration `go.work` wrapper.

---

## 4. Deep Dive: `E:\nexus-sources` & `E:\nexus-training`

### `E:\nexus-sources` (~6.0 GB, ~393,000 files)
Contains licensed upstream OS code used by `ramasite/benchmarks/ilaria/licensed_os_code_acquisition/acquire.py` for training corpus extraction:
- `apache-nuttx-locked` (490 MB, 27,806 files) -> `ramasite/local/sources/apache-nuttx-locked/` (git-ignored)
- `freebsd-locked` (1,944 MB, 115,704 files) -> `ramasite/local/sources/freebsd-locked/` (git-ignored)
- `staging` (3,331 MB, 229,300 files) -> `ramasite/local/sources/staging/` (git-ignored)
- `zephyr` (194 MB, 20,908 files) -> `ramasite/local/sources/zephyr/` (git-ignored)
- JSON manifests (`apache-nuttx-locked.licensed.json`, `freebsd-locked.licensed.json`, `zephyr.*.json`) -> `ramasite/docs/ilaria/licensed_sources/`
- `benchmarks` (38 MB: AI2 ARC, GSM8k, HumanEval, TruthfulQA) -> `ramasite/benchmarks/ilaria/eval-benchmarks/`

### `E:\nexus-training` (~4.6 GB, ~30,400 files)
- `evidence` (1,236 MB) -> `ramasite/benchmarks/ilaria/training-evidence/`
- `integration-receipts` (0.16 MB) -> `ramasite/agent-md/ilaria/integration-receipts/`
- `mobile-native-tools-20261002` (497 MB) -> `ramasite/local/tools/mobile-native/`
- `new-public-20261001` (2,921 MB) -> `ramasite/local/training-data/`

---

## 5. Items Needing User Decision

1. **Large External Training Source Trees (6.0 GB in `E:\nexus-sources`):**
   - *Option A (Recommended):* Move the trees to `ramasite/local/sources/` (git-ignored) and commit only the metadata JSON manifests and `acquire.py` scripts to Git.
   - *Option B:* Keep `E:\nexus-sources` external as a persistent read-only training reference volume.

2. **Large Scraped Training Dataset (2.9 GB in `E:\nexus-training\new-public-20261001`):**
   - *Option A (Recommended):* Move into `ramasite/local/training-data/` (git-ignored).
   - *Option B:* Archive to cold storage or external drive.

3. **Compilers and Toolchains (2.55 GB in `E:\arhiva-ceo\tools`):**
   - *Option A (Recommended):* Relocate to `ramasite/local/tools/` to allow self-contained building of Swypik-OS UEFI kernels and Swyp native compilers.
   - *Option B:* Keep them in a dedicated machine-wide tools path outside any repository.

4. **Uncommitted Unique Work in Worktrees (49 Worktrees with Blockers):**
   - Need authorization to batch-commit or stash unique uncommitted files onto their respective topic branches so the worktrees can be cleanly deleted.

---

## 6. Proposed Step-by-Step Migration Plan

### Phase 1: Reconcile & Prune Safe Worktrees
1. Run `git worktree prune` to unregister deleted worktrees (`nexus-audit-2026-10-02`, `nexus-audit-fixes`).
2. Remove proven-clean and duplicated worktrees (`git worktree remove`):
   - `E:/arhiva-ceo/wt/swos-swyp-broker-host-v1`
   - `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-congenial-engine`
   - `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-curly-umbrella`
   - `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-fluffy-journey`
   - `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-friendly-giggle`
   - `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-jubilant-couscous`
   - `C:/Users/abel/.copilot/repos/copilot-worktrees/nexus/office233-turbo-couscous`
   - `C:/Users/abel/AppData/Local/Temp/2/opencode/nexus-git-order-20261003`
   - `E:/nexus-worktrees/copilot-final-product-20261002`
   - `E:/nexus-worktrees/copilot-kernel-first-task-20261002`
   - `E:/nexus-worktrees/copilot-swyp-runtime-20261002`
   - `E:/nexus-worktrees/h200-recovery-cloud-20261002`
   - `E:/nexus-worktrees/h200-recovery-data-20261002`

### Phase 2: Ingest Unique Standalone Assets into `E:\nexus`
1. **Opencode Automation Scripts:**
   - `C:\Users\abel\AppData\Local\Temp\2\opencode\nexus-git-order-go-linux.sh` -> `E:\nexus\ramasite\scripts\`
   - `C:\Users\abel\AppData\Local\Temp\2\opencode\nexus-git-order-go-windows.ps1` -> `E:\nexus\ramasite\scripts\`
   - `C:\Users\abel\AppData\Local\Temp\2\opencode\nexus-public-source-scan.py` -> `E:\nexus\ramasite\scripts\`
   - `C:\Users\abel\AppData\Local\Temp\2\opencode\nexus-transport-*.sh` -> `E:\nexus\ramasite\scripts\`
   - `C:\Users\abel\AppData\Local\Temp\2\opencode\nexus-git-order-pr.md` -> `E:\nexus\ramasite\agent-md\workspace\`
2. **Historical Source & Agent Records from `E:\arhiva-ceo`:**
   - `E:\arhiva-ceo\swyp-execute-before-fastblock.go` -> `E:\nexus\ramasite\agent-md\swyp\history\`
   - `E:\arhiva-ceo\projects\swos\` -> `E:\nexus\ramasite\agent-md\workspace\swos-historical\`
   - `E:\arhiva-ceo\specs\mission-swypikos-ilaria.md` -> `E:\nexus\ramasite\agent-md\workspace\`
   - `E:\arhiva-ceo\_move_logs\` -> `E:\nexus\ramasite\agent-md\workspace\migration-history\`
   - `E:\arhiva-ceo\_conversatii-claude\` -> `E:\nexus\ramasite\local\conversatii-claude\` (merged)
3. **Historical Component Snapshots in `E:\arhiva-ceo\wt`:**
   - `E:\arhiva-ceo\wt\swyp-hir-p3-20260929` -> `E:\nexus\ramasite\agent-md\swyp\history\swyp-hir-p3-snapshot\`
   - `E:\arhiva-ceo\wt\swypik-os-swyp-broker-20260929` -> `E:\nexus\ramasite\agent-md\swypik-os\history\swyp-broker-snapshot\`
4. **Training Receipts & Evaluation Assets:**
   - `E:\nexus-training\integration-receipts\` -> `E:\nexus\ramasite\agent-md\ilaria\integration-receipts\`
   - `E:\nexus-training\evidence\` -> `E:\nexus\ramasite\benchmarks\ilaria\training-evidence\`
   - `E:\nexus-sources\benchmarks\` -> `E:\nexus\ramasite\benchmarks\ilaria\eval-benchmarks\`
   - `E:\nexus-sources\*.licensed.json` -> `E:\nexus\ramasite\docs\ilaria\licensed_sources\`

### Phase 3: Relocate Machine-Local Tools & Heavy Data (Git-Ignored)
1. `E:\arhiva-ceo\tools\` -> `E:\nexus\ramasite\local\tools\` (~2.55 GB)
2. `E:\nexus-training\mobile-native-tools-20261002\` -> `E:\nexus\ramasite\local\tools\mobile-native\` (~497 MB)
3. `E:\nexus-sources\apache-nuttx-locked\`, `freebsd-locked\`, `staging\`, `zephyr\` -> `E:\nexus\ramasite\local\sources\` (~6.0 GB)
4. `E:\nexus-training\new-public-20261001\` -> `E:\nexus\ramasite\local\training-data\` (~2.9 GB)

### Phase 4: Commit Blocked Worktrees & Remove Outside Folders
1. For each remaining worktree with uncommitted work, commit its dirty files to its local branch.
2. Execute `git worktree remove` on all external worktrees.
3. Safely delete outside directories (`E:\nexus-sources`, `E:\nexus-training`, `E:\nexus-worktrees`, `C:\Users\abel\.copilot\repos\copilot-worktrees\nexus`).
4. Keep `E:\arhiva-ceo` containing only non-Nexus CEO portfolio documents.
