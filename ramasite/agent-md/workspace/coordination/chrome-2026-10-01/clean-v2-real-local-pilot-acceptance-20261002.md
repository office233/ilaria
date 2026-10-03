# Clean v2 real local pilot — acceptance evidence

Verified 2026-10-02.

Scope: local **NON_PROMOTABLE_CODE_ONLY_SCALE_VALIDATION** only. This does not
authorize production promotion, H200/NCCL allocation, Brev spend, or replacement
of the production dataset.

## Verified

- The accepted v2 adapter is present in Main with SHA-256
  `b3eb5b7a88341f12a956d5c2d02e2249baa9b8a1472647f6039e7ebe8b95e515`.
- The canonical trainer used by the pilot is
  `568494437fd3eb419ee502f5d9e352b9828ffd6ca494e5741d29dc4a2aa4a4ed`.
- The reviewed Linux supervisor sources remain:
  `probe.py=b4a8b09d36d45449b440dfc393f1ae20f9ab204747a705d98f961e83e3cdc704`,
  `containment.py=2f211d79b9e92c6e32f864e4d37d1e8bf7568c38fb2f0a0ad41d25278cfd7894`.
- Real clean-code-v2 package:
  `030cf1ef1100e8ea97b0824b7567fc58883ba97c1fe72d16afe7183d1fa56c67`.
- Real clean corpus:
  `5d7a32b384c4cefa02f5b78e5e738b85efa3139ba9e9b36ba1623651a1ff4d94`.
- Tokenizer:
  `886356ad480e727742822b3faf0517b76c5e957c0a92f955565bf4609bec29b5`.
- Independent replay retained zero exact tokenizer-sample/heldout overlap and
  zero normalized-body overlap.

## Real local execution

A content-addressed local-only decision and launch packet were created after
revalidating the exact package, corpus, tokenizer binding, rights/evidence locks,
train/validation streams and independent replay.

The canonical trainer then ran under the reviewed Linux tree supervisor using
the existing pinned CPU runtime:

- world size: 2
- backend: Gloo
- optimizer steps: 2
- global training tokens: 16
- data: real public clean-code-v2 train + validation
- sealed split selected for training: **false**
- GPU/NCCL: **not used**
- paid compute: **false**
- promotion/allocation: **false**
- cleanup/no-children: **verified**
- independent post-run readback: helper and all observed worker PIDs absent

The run metadata binds package, corpus, decision and launch identities and remains
`NON_PROMOTABLE_CODE_ONLY_SCALE_VALIDATION`.

Primary proof:
`E:\nexus-training\evidence\clean-v2-real-local-pilot-20261002\real-local-proof.json`.

Scope receipt:
`E:\nexus-training\evidence\clean-v2-real-local-pilot-20261002\scope-receipt.json`.

Independent PID readback:
`E:\nexus-training\evidence\clean-v2-real-local-pilot-20261002\independent-process-exit-readback.json`.

## Main gates after integration

- `python -m pytest -q forge/test_qualified_pilot_v2.py`: **14 passed**
- `GOWORK=off go test -count=1 -timeout 180s ./...`: PASS
- `GOWORK=off go vet ./...`: PASS

## Remaining blockers

This proof is intentionally tiny and code-only. It does not qualify the full
multi-lane production mixture, establish semantic benchmark independence, prove
125M/1B quality or convergence, validate 8×H200 NCCL, prove cloud export/deletion
or authorize any paid allocation. Those remain separate gates.

No stage, commit, push, deploy, cloud allocation, Colab mutation, Bridge/config
mutation, secret read, or external model job occurred.
