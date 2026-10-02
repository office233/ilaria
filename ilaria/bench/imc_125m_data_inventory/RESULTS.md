# IMC-125M candidate data inventory

Snapshot: 2026-09-30

This report is planning evidence only. It does not approve any source for
production training and it is not a dataset manifest.

## Canonical inventory

Inventory identity:

`b90cb45f4e8269a19673c7116f28974b4aee31f23b8a2eedd80ede354694db69`

Canonical file:

`bench/imc_125m_data_inventory/candidate-inventory.json`

## Candidate capacity

- **3,042,602 unique documents**
- **5,335,195,204 text bytes**
- **1,336,841,403 conservative estimated tokens**
- **1,670,291,104 best-case estimated tokens**

Conservative lane capacity:

- general knowledge: **350.310M / 300M**
- code: **313.402M / 220M**
- mathematics: **196.223M / 145M**
- science / technical: **161.361M / 105M**
- OS / hardware / drivers: **126.616M / 100M**
- agent / tool trajectories: **113.416M / 80M**
- world / device trajectories: **75.514M / 50M**
- Romanian / multilingual: **0 / 0**

All non-zero Genesis lanes have zero conservative deficit.

## Production source plan

- plan SHA-256:
  `dd1306ab5ace5021aa77e4a1c934b3a88659d2e6c122cf12d9241e6a09984fdf`
- minimum conservative headroom: **2%**
- assessment: **ready**
- blockers: **none**

## Review packet

- packet:
  `bench/imc_125m_production_review/REVIEW_PACKET.json`
- SHA-256:
  `24a62a97a6ac6640f390bafc5c946886acc34e6e2f9d7959d7094c4f2f1c5afc`
- external decisions pending: **8**
- first-party decisions pending: **2**
- automatic approval: **never**

## Production stream pipeline

The post-review chain is now implemented through:

1. rights-gated curation with lane assignment;
2. `curated_lane_shards.py` for deterministic train/validation lane shards;
3. `encode_curated_lanes.py` for frozen-tokenizer lane streams;
4. `build_genesis_streams.py` for exact curriculum materialization.

Canonical stream targets:

- train: **1,000,000,000 tokens**
- validation: **2,097,152 tokens**
- curriculum identity:
  `3ac9c6e0a36e85151e543dfbff09c8ea319b1566b6dd77d981cab8c8f34a4432`

After human rights/ownership approval, the remaining production stages are
tokenizer freeze, curation/encoding, dataset manifest, preflight, launch manifest
and G4 training.
