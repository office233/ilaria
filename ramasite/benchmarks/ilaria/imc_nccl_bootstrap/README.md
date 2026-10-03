# Bounded synthetic IMC / NCCL bootstrap

Status: IMPLEMENTED_LOCAL_GPU_EXECUTION_UNVERIFIED. This is a non-promotable
synthetic stage probe, not production admission, a new model architecture,
cloud authority, monetary controller, remote deletion proof or IMC-125M forecast.
Dry-run is the default. No CUDA/NCCL/H200 execution has been performed locally.

Only the canonical forge model, trainer and training-state code implement training.
Pass an explicit read-only `--forge-root` and a source manifest with format
`imc-probe-source-pins-v1` and `files` mapping local Python relative paths to
lowercase SHA256. It must cover exactly `source_closure(forge_root)`: static local
Python imports rooted at train_ilaria.py, imc_model.py and training_state.py.
This pins that closure before/after every phase, not external libraries, dynamic
imports or global installed dependencies. Pin those in the remote environment too.

Example interface (replace paths and use a fresh deadline):

```text
python probe.py --forge-root /readonly/ilaria/forge --source-pins /public/pins.json
  --output /existing-parent/NEW-probe --absolute-deadline 2030-01-01T01:00:00Z
  --max-wall-seconds 180 --phase-timeout-seconds 45 --teardown-seconds 5
  --threads 1 --precision fp32
```

Add `--execute` only on Linux. Output must not exist; symlink parents are rejected.
One cumulative monotonic/UTC budget includes fixture preparation, four GPU jobs,
two separately supervised CPU checkpoint phases and cleanup. The parent reads only
capped 64KiB checkpoint result JSON; checkpoint loads and comparison run in CPU
workers with CUDA visibility disabled. Timeout, worker failure or malformed result
fails closed and preserves the CPU phase cleanup observation. Each child receives
its own process group.
TERM/KILL escalation reaps the parent and checks group absence even on normal exit.
Unverified cleanup fails closed. Descendants escaping the owned process group are
outside this mechanism: use an OS cgroup/sandbox for stronger resource containment.
No memory/disk cgroup limit is claimed. Threads, phases and checkpoint/JSON input
size caps are explicit; logs and CUDA memory are not hard capped.

The identity stage requires eight distinct H200 UUIDs, 80GiB minimum per device,
compute capability >=9, BF16 support, NCCL world eight, correct rank/device placement
and an actual all-reduce. Missing UUID support fails; no index-only substitute.
The canonical trainer runs full six steps, pause three, resume to six with unchanged
LR horizon. An entry wrapper only bounds process-group collective timeout and checks
NCCL/world identity; it does not duplicate the model, optimizer or training loop.
It explicitly forwards the selected fp32/bf16 precision to canonical main; hidden
collective timeouts must be positive and finite before any Torch import.
Fixtures follow the canonical CPU tests (40-token vocabulary, two 32-wide layers,
context16, microbatch4, accumulation2); smoke opt-in never admits external corpora.
Expected final counters: step6, 6144 tokens, eight rank RNG states.

Only BITWISE_EXACT_PASS returns success. NUMERICAL_CONTINUITY_ONLY exits nonzero
and does not certify exact resume. GPU reductions/TF32/kernel selection can cause
bitwise differences despite coherent continuation; tolerance is not an exactness
guarantee. Output throughput includes process startup/evaluation/checkpoint saving
and describes only this tiny stage. Full-size recipe throughput needs another probe.

Local tests use CPU tensors and fake processes. They do not certify Linux process
cleanup, GPU identity, NCCL performance, hardware availability or cloud termination.
Torch references: https://docs.pytorch.org/docs/2.14/distributed.html,
https://docs.pytorch.org/docs/2.14/elastic/run.html,
https://docs.pytorch.org/docs/2.14/notes/randomness.html.
