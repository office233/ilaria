# IMC NCCL hardware-family gate

State: STOP/FROZEN — LOCAL/LINUX GATES PASS, READY FOR SELECTIVE INTEGRATION.

Branch: codex/imc-nccl-hardware-gate-20261002
Worktree: E:\nexus-worktrees\imc-nccl-hardware-gate-20261002

Claims are limited to:

- ilaria/bench/imc_nccl_hardware_gate/gate.py
- ilaria/bench/imc_nccl_hardware_gate/test_gate.py
- ilaria/bench/imc_nccl_hardware_gate/README.md
- this handoff

The accepted imc_nccl_bootstrap sources are read-only dependencies and remain
byte-identical:

- probe.py:
  b4a8b09d36d45449b440dfc393f1ae20f9ab204747a705d98f961e83e3cdc704
- containment.py:
  2f211d79b9e92c6e32f864e4d37d1e8bf7568c38fb2f0a0ad41d25278cfd7894

This separation is intentional: qualified_pilot.py pins those exact historical
bytes, so the new H100/H200/B200 route does not edit or reinterpret them.

## Hardware contract

The new content-addressed hardware contract binds:

- the accepted Brev offer-selection SHA;
- exact offer type/provider/cloud and GPU family;
- exactly 8 GPUs;
- minimum bytes of VRAM per GPU;
- minimum compute major;
- BF16 requirement;
- strict full-NVLink-mesh requirement.

Allowed GPU families are H100, H200 and B200. WORLD remains exactly 8 and backend
must be NCCL.

The live H100 dry-run contract is:

- selection:
  d45f3b1145f3320d4889ee4f3e91d97e1cae3ba2378c08cc5bac70f5370a5f85
- offer: oci.h100x8.sxm
- expected family: H100
- gpu_count: 8
- minimum VRAM/GPU: 85,899,345,920 bytes (80 GiB)
- minimum compute major: 9
- BF16: required
- full NVLink mesh: required
- contract:
  3d0ef6ebaa0bb2e0e18396176fc9b8d3645d683b113c4b33f4c179a2e53b1918

This is a dry-run binding only. It does not establish that the Brev catalog label
maps to a particular physical OCI shape.

## Execution proof semantics

Execute mode is Linux-only and runs a single world-8 torchrun identity phase under
the existing reviewed subreaper/pidfd Supervisor.

Before importing Torch/CUDA, every rank performs a live containment assertion.
The Supervisor binding pins:

- hardware contract SHA;
- this exact gate.py path and SHA;
- exact rank-worker argv SHA.

The assertion is accepted only for a live descendant owned by the current
Supervisor scope. A separate CPU torchrun probe verified the actual PyTorch worker
argv form on both ranks as:

sys.executable, -u, script, args...

The GPU phase requires:

- exactly 8 visible CUDA devices;
- exact rank/local-rank/device-index placement;
- eight unique stable GPU UUIDs;
- expected GPU family in every device name;
- configured VRAM/capability/BF16 minima;
- NCCL world size 8;
- exact integer all-reduce sum 28.

Rank 0 captures nvidia-smi topo -m. The parser requires exactly GPU0..GPU7 rows.
For a strict full mesh, every off-diagonal token must be an NV<number> link;
PHB/SYS/PIX/PCIe fallbacks are rejected. The raw topology text is persisted and
the parent reparses it independently; the normalized topology receipt must match
the replay exactly.

No model/trainer phase is part of this gate.

## Verification

- New hardware-gate targeted suite: 25/25 PASS on Windows.
- Same targeted suite: 25/25 PASS on pinned Linux CPU runtime.
- Hardware gate + existing NCCL bootstrap + canonical IMC regressions:
  132 passed, 8 platform-specific skips.
- py_compile: PASS.
- LSP/Pyright on both new Python files: 0 diagnostics.
- Ilaria GOWORK=off go test -count=1 -timeout 180s ./...: PASS,
  8 test-bearing packages.
- Ilaria go vet ./...: PASS.
- Existing probe.py and containment.py hashes remained unchanged.
- H100 live-selection dry-run: PASS on Windows and Linux;
  gpu_proof=false, training_performed=false, allocation_authorized=false.
- CPU torchrun argv probe: both ranks confirmed the -u worker form used by the
  containment worker_argv_sha256 binding.

Evidence:
E:\nexus-training\evidence\imc-nccl-hardware-gate-20261002

No GPU/CUDA/NCCL execution, Brev create/delete/copy, paid compute, Terms
acceptance, secret read, Bridge/config mutation, stage, commit, push or deploy
occurred. Actual world-8 GPU proof remains an external post-allocation gate.
