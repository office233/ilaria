# IMC training supervisor containment — candidate STOP

Dedicated branch codex/imc-supervisor-containment, HEAD 06a5f39f805cf36897e05ffe306d05ed212a5a3a.
Exact four claims: probe.py, test_probe.py, new containment.py, this handoff in ilaria/bench/imc_nccl_bootstrap/.
Baseline/pre-edit source and RED proof are durable at E:/nexus-training/evidence/imc-supervisor-containment-20261002.
Baseline SHA256 26a94c6750822c9f74782bc0d41880ea40b05538977b8ae0d93139ef0b18e85f; original Temp evidence is preserved.
Source pins for root release:
- probe.py b4a8b09d36d45449b440dfc393f1ae20f9ab204747a705d98f961e83e3cdc704
- containment.py 2f211d79b9e92c6e32f864e4d37d1e8bf7568c38fb2f0a0ad41d25278cfd7894
- test_probe.py 721868b671d1262a4980ef1848923839edb7098328042372386fb53a24e0ec58

Problem/proof: PyTorch's public SubprocessHandler starts POSIX ranks with start_new_session=True.
Old supervisor checked only launcher PG. Real WSL RED: launcher475 exited; detached rank476 kept heartbeat while old receipt claimed PASS/cleanup_verified. Harness killed/reaped its own rank through a pidfd.
Each new phase uses an isolated Linux PR_SET_CHILD_SUBREAPER helper, verified pidfd signals, held process identities and recursively discovered OWN child/task lists only.
No unrelated /proc enumeration, process profiles, credentials or global services; Windows execution refuses rather than falling back to PG-only cleanup.
TERM then KILL applies to held pidfds; reparented setsid ranks are adopted/reaped. Scope-empty proof requires kernel waitpid ECHILD plus observed exit identities and helper exit.
PID starttimes/pidfd exits are checked before recursive discovery; error/cap cleanup independently kills direct kernel-owned children, reaps/adopts, catches per-child disappearance and remains FAIL when metadata is incomplete.
Outer client death triggers helper PDEATHSIG/EOF cleanup. Helper independently enforces cumulative UTC/monotonic deadlines including reserved cleanup.
Caps: 1,024 process records, 4,096 owned task threads, 8MiB workload logs, 4KiB child frames, 512KiB scope receipts; argv bounded and newline/NUL injection refused.
Environment contains an explicit runtime-path/tool allowlist and bounded thread settings; arbitrary secrets/PYTHONPATH/LD_PRELOAD/controller variables are absent.

Public API: Supervisor(limits, containment_binding=None); strict_capability() performs real bootstrap and returns imc-supervisor-capability-v1 / linux-subreaper-pidfd-v1 / exact source_sha256 / verified kernel fields.
Qualified binding: config_identity_sha256, absolute worker_source_path, worker_source_sha256, worker_argv_sha256 (SHA256 compact JSON UTF8 exact rank argv). Three-field binding permits normal bounded scope, but cannot grant live child admission.
Child hook: containment.assert_current_containment(expected_config_identity=..., expected_source_sha256={'probe.py':...,'containment.py':...}, expected_worker_source_sha256=..., expected_worker_source_path=..., required_remaining_seconds=...).
IMC_CONTAINMENT_SOCKET is a public address, not a credential. Helper uses SO_PEERCRED PID/UID, retained pidfd/starttime/descendant membership and actual owned /proc cmdline hash; an unrelated caller with the address and config hash is refused.
Reply binds helper/peer identities, source pins, canonical worker/config/rank argv, issued launcher argv, deadline_unix and hard_end_monotonic. Root compares pins before release; caller readiness booleans cannot substitute the live assertion.
Scope receipt format imc-supervised-scope-v1 records exit/reap identities, metadata_complete, no_children_verified, cleanup_verified, helper exit, stop/error and bounded log count.
PASS guarantees zero launcher exit plus verified scope cleanup/budget/source status, not independent success of every rank or model quality; canonical phase/checkpoint/NCCL validation remains separate.

Checks before test-only refix: affected Windows file 87PASS/8LinuxSKIP (3.28s); native Linux eight cases PASS/87deselected (12.66s), probe/helper pins unchanged.
Root Main replay preserved at supervision-p2p-admission-20261002/main-supervisor-native.log:7PASS/1FAIL; cap fixture read an empty PID file because cleanup interrupted launcher publication.
Refix removes PID-file timing dependence: a second discovered process triggers cap=1; assertions require kernel ECHILD/no_children, negative launcher exit/reap, helper exit0, scope-error and metadata/cleanup remaining false. No product containment changes.
Final test-only refix: affected Linux cap case 1PASS/94deselected (2.16s), eight native cases 8PASS/87deselected (12.87s); durable owner-pid-publication-* evidence and logs retained.
Native cases cover detached ranks after natural/SIGKILL launcher exit; stalled CPU timeout; live canonical argv admission; unowned peer and wrong argv refusal; tiny-cap error cleanup; outer-parent death with all owned children reaped.
Affected three-source py_compile and tracked/no-index whitespace checks passed. Test artifacts/caches are owned Temp or the durable evidence directory.
Linux full affected file:84PASS/11FAIL (18.70s), solely legacy checkpoint tests importing Windows Torch and missing libtorch_global_deps.so. These failures are preserved, not relabeled/skipped or repaired with downloads.
Existing native Python /usr/bin/python3 3.14.4; pytest uses existing pure Python /mnt/c/Python312/Lib/site-packages, plugin autoload disabled. No Linux Torch/model/GPU/NCCL8/H200 proof.
Broader Ilaria mandatory gates are not claimed: this HEAD checkout's imc_model.py/train_ilaria.py/go.mod differ from current Main public snapshots. Root owns canonical closure reconciliation/full gates; no old source overlay or corpus copying used.
Initial STOP preserved Main probe89053fb9/tests cd221f72/index321f80fa; root subsequently integrated approved sources. At this test-only refix STOP Main probe/helper match pins above, Main test remains0d65b42d; no Main writes by this owner. Models/trainer/package/metadata/old receipts remain untouched; preexisting swyp/swyp.cmd normalization remains untouched.
Limit: this is trusted-workload supervision, not a hostile-code sandbox/cgroup. External SIGKILL of the helper itself, privileged escape and uninterruptible kernel tasks cannot receive a verified cleanup receipt.
No training, model execution, GPU/cloud/allocation, install/download, Bridge, git stage/commit/push/Main integration occurred.
FREEZE / STOP; root independent review and native replay required before shared adapter release.
