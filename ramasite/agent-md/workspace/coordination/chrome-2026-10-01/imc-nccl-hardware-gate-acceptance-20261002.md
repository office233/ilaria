# IMC NCCL hardware-family gate — Main acceptance — 2026-10-02

State: ACCEPTED/INTEGRATED — GPU EXECUTION STILL UNVERIFIED.

Integrated create-only claims:

- ilaria/bench/imc_nccl_hardware_gate/gate.py
- ilaria/bench/imc_nccl_hardware_gate/test_gate.py
- ilaria/bench/imc_nccl_hardware_gate/README.md
- docs/coordination/chrome-2026-10-01/imc-nccl-hardware-gate-handoff.md

The accepted historical supervisor remains unchanged:

- imc_nccl_bootstrap/probe.py
  b4a8b09d36d45449b440dfc393f1ae20f9ab204747a705d98f961e83e3cdc704
- imc_nccl_bootstrap/containment.py
  2f211d79b9e92c6e32f864e4d37d1e8bf7568c38fb2f0a0ad41d25278cfd7894

This preserves the source pins hard-coded by qualified_pilot.py and
qualified_pilot_v2.py.

## Live H100 fallback binding

Offer-selection identity:
d45f3b1145f3320d4889ee4f3e91d97e1cae3ba2378c08cc5bac70f5370a5f85

Hardware-contract identity:
3d0ef6ebaa0bb2e0e18396176fc9b8d3645d683b113c4b33f4c179a2e53b1918

Bound offer: oci.h100x8.sxm

Required runtime proof:

- NCCL world 8
- exactly 8 visible CUDA devices
- eight unique GPU UUIDs
- H100 on all ranks
- >= 80 GiB VRAM per GPU
- compute major >= 9
- BF16 on all ranks
- all-reduce sum 28
- nvidia-smi topo -m with exactly GPU0..GPU7
- strict full NVLink/NVSwitch mesh: every off-diagonal GPU peer token must be NV*
- parent independently reparses the persisted raw topology text
- process tree is controlled by the accepted pinned Linux subreaper/pidfd Supervisor

Each rank performs a live containment assertion before importing Torch/CUDA. The
assertion binds the hardware contract SHA, this gate.py SHA/path and the exact
rank-worker argv SHA. A local CPU torchrun readback confirmed the real rank argv
form uses sys.executable, -u, script, args consistently across ranks.

The live contract passed dry-run on Windows and Linux. Dry-run never imports CUDA,
never starts NCCL and reports gpu_proof=false, training_performed=false and
allocation_authorized=false.

## Fresh Main verification

- hardware gate + historical bootstrap + canonical IMC: 307 passed, 8
  platform-specific skips
- targeted hardware gate on pinned Linux runtime: 25/25 PASS
- py_compile: PASS
- LSP/Pyright: 0 diagnostics
- Ilaria GOWORK=off go test -count=1 -timeout 180s ./...: PASS
- Ilaria go vet ./...: PASS

Evidence:
E:\nexus-training\evidence\imc-nccl-hardware-gate-20261002

No GPU/CUDA/NCCL execution, Brev create/delete/copy, paid compute, Terms
acceptance, secret read, Bridge/config mutation, stage, commit, push or deploy
occurred.

This gate removes the code-level H200-only blocker without claiming the selected
H100 host has passed it. Actual world-8 GPU/topology proof remains a post-allocation
gate and the current offer selector still reports allocation_ready=false until
billing terms, exact physical topology mapping and deployment Terms are verified.
