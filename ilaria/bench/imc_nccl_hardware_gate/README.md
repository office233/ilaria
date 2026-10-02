# IMC NCCL hardware gate

This is a hardware identity/topology proof for a selected eight-GPU offer. It is
separate from the historical H200-only bootstrap because the accepted clean-v2
supervisor pins the old probe.py byte-for-byte.

The new gate verifies:

- one explicit content-addressed offer-selection binding;
- exactly eight visible CUDA devices and torchrun ranks;
- NCCL world size 8 and a real all-reduce across all ranks;
- unique stable GPU UUIDs and rank/local-rank/device-index placement;
- the exact GPU family required by the contract (H100, H200 or B200);
- minimum VRAM per GPU, compute capability and BF16 support;
- nvidia-smi topo -m rows GPU0..GPU7;
- optional strict full NVLink/NVSwitch mesh: every off-diagonal peer token must
  be an NV* link, never PHB/SYS/PIX/PCIe fallback;
- strict Linux subreaper/pidfd process-tree cleanup by reusing the pinned
  imc_nccl_bootstrap Supervisor/containment sources unchanged.

Dry-run is the default. Execute mode performs only the NCCL hardware proof. It does
not train IMC, allocate cloud compute, approve a dataset, accept Terms, authorize
promotion, or verify provider billing.

A catalog label such as oci.h100x8.sxm is never accepted as topology proof. The
topology gate must pass on the actual allocated host before any training phase.
