# PCE Transfer v1

Frozen synthetic benchmark for the first Myriad teaching experiment.

The task strings intentionally use invented devices, error codes and rules so a
model cannot rely on ordinary factual pretraining. Each task defines a verified
source-cell experience, a held-out recall prompt, and a minimal expected answer.

Protocol:
1. Evaluate Cell B from a fixed checkpoint before transfer.
2. Convert Cell A's verified experience into a signed PCE.
3. Cell B verifies signature, lineage and privacy, then compiles replay data.
4. Cell B performs a bounded replay update.
5. Re-evaluate the same held-out prompts.

Primary metric:

TransferGain = post_replay_accuracy - pre_replay_accuracy

The control receives the same optimizer-step budget with unrelated replay data.
This benchmark is frozen once IMC transfer experiments begin.
