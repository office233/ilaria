# Synthetic adversarial probes for the Ilaria P2P quality gate

This benchmark exercises only the canonical local IMC proposer/evaluator with a tiny, deterministic, synthetic fixture. It adds no validator and changes no production threshold. The cases check whether the existing evaluator rejects (1) a sign-inverted real backprop update and (2) a real-gradient update that lowers measured evaluation cross-entropy while reducing measured anchor accuracy. Both must leave the active metrics unchanged and emit no checkpoint.

The benchmark requires the explicit public canonical checkout path and verifies the three source SHA-256 pins in `manifest.json` before importing anything. No corpus, pilot checkpoint, model weights, network transport, peer authentication, or production training is accessed. Results cover quality-gate behavior only; they do not establish statistical generalization or distributed/network safety.

Run the receipt-producing probe from this directory:

```powershell
python run.py --canonical-root E:\nexus --output E:\nexus-training\evidence\p2p-quality-adversarial-20261001\receipt.json
```

Run the tests with the same pinned source checkout:

```powershell
$env:ILARIA_CANONICAL_ROOT = 'E:\nexus'
python -m pytest -q test_quality_adversarial.py
```

The runner refuses to overwrite a receipt path that already exists. Choose a fresh output path for each run.
