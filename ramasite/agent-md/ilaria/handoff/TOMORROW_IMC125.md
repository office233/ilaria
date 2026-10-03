# TOMORROW — IMC-125M GENESIS

Start here: `docs/handoff/2026-09-30-imc125-genesis-colab.md`

1. Verify workspace/branch; do not clean/reset the dirty worktree.
2. Run `.\\.colab-cli-venv\\Scripts\\colab.exe version`.
3. Run `.\\.colab-cli-venv\\Scripts\\colab.exe sessions`.
4. Complete the NEW Google phone 2FA challenge. Do not reuse old challenge numbers.
5. Run `colab usage` + `colab sessions`.
6. Prefer H100 -> A100 -> existing G4 Blackwell (~95 GiB VRAM, BF16).
7. Verify/upload bundle `data/colab/ilaria-live-training-bundle.zip`, SHA256 `483d30799a858a7cc18ef6ee9c85d58de1ee4ca1691a1841e5a2776787fbeab9`.
8. Remote GPU preflight + critical tests.
9. Build real per-lane token inventory for the English-first 1B target.
10. Fill deficits with unique, provenance-preserving sources; do not manufacture quota by repetition.
11. Freeze real English-first IlariaLex-65K.
12. Encode lane streams and materialize exact curriculum.
13. Build immutable dataset manifest and pass production readiness/preflight.
14. Launch IMC-125M ternary seed 7 to full horizon with persistent SHA-pinned checkpoints.
15. Evaluate; then run matched full-precision seed 7 before deciding on seeds 11/19.

Locked target mix: 300M general + 220M code + 145M math + 105M science/technical + 100M OS/hardware/drivers + 80M agent/tool + 50M world/device + 0 Romanian = 1B tokens.
