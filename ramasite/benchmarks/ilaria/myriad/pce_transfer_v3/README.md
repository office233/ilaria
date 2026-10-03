# PCE Transfer v3 — sealed-test benchmark

Status: validation tuning only. **The test split is sealed.**

Files:
- `skills_trainval.jsonl`: training states + two validation paraphrases.
- `skills_test.jsonl`: sealed skill test prompts.
- `anchors_trainval.jsonl`: known skills used for anti-forgetting.
- `anchors_test.jsonl`: sealed anchor test prompts.
- `policy.json`: immutable tuning policy and validation gate.
- `manifest.json`: SHA-256 identity for every frozen artifact.

The tuner `forge/pce_transfer_v3.py` has no code path to the sealed test files.

Workflow:
1. run all frozen tuning seeds;
2. run `forge/pce_transfer_v3_gate.py`;
3. only if validation gate passes, create a signed/frozen validation record;
4. open the test split once with a separate finalization tool;
5. never retune v3 after seeing final test results.

This benchmark exists because v2 demonstrated that one validation paraphrase did
not reliably predict untouched test behavior.
