# Trusted child process adapter

`Start` launches an explicitly configured absolute executable directly, using
owned stdin/stdout/stderr pipes. An optional working directory must also be
absolute. `Config` requires positive `MaxThreads` and `MemoryLimitBytes`, and
nonnegative `GCPercent`; these set `GOMAXPROCS`, `GOMEMLIMIT` and `GOGC`.
The child receives only those limits and any configured parent `SystemRoot`,
`SystemDrive`, `TEMP`, `TMP` and `TMPDIR`. Other parent environment variables
are excluded.

`SendJSON` sends one JSON document followed by LF. `ReadLine` returns one owned
JSONL payload without its delimiter and returns exact `io.EOF` after output
drains. Both are serialized and context-aware. `Config.JSONLMaxBytes` is the
per-process payload limit: zero preserves the historical 2 MiB
`MaxLineBytes` default, while explicit values may select 1 byte through the
public 9 MiB `MaxJSONLBytes` ceiling. Invalid limits are rejected before child
launch or pipe creation.

The bound is defined identically in both directions as **payload bytes only**.
For stdin this is the exact byte length of `json.Marshal(value)` before the
adapter-appended LF. For stdout this is every byte before the accepted line
terminator. Stdout accepts exactly LF (`\n`) or CRLF (`\r\n`); delimiter bytes
do not count toward the payload bound. A CR not immediately preceding LF is
payload. A non-empty unterminated EOF fragment is rejected rather than being
promoted to an implicit JSONL frame. Transport accumulation is explicitly
bounded to the configured payload plus at most one temporary CR byte needed to
recognize a split CRLF. The stdout queue remains one frame deep, retained stderr
remains limited to 8 KiB, and consumers must drain output while children run.
Overflow or cancellation terminates and reaps the owned child.

The 9 MiB constant is adapter-only capacity aligned with the public Swyp
continuation wire ceiling. It does not opt any CLI/service into larger frames
and is not evidence of 9 MiB end-to-end supervisor support; callers must set
`JSONLMaxBytes` explicitly and prove their own integrated protocol path.
`Wait` preserves unread stdout, reports the exit status and bounded stderr,
and can be interrupted through its context. Bounded backpressure intentionally
prevents unbounded buffering.
`Close` aborts remaining work, reaps the child and releases resources; it is
idempotent. Assess a normal exit through `Wait` before calling `Close`.

`OpenGroup(Limits)` is the strict supervisor containment path. The supervisor
must create this group before opening Control Kernel authority and starts every
Swyp/Ilaria child through `Group.Start`. `CPUPercent`, `MemoryBytes` and
`MaxProcesses` are aggregate OS-group limits, not Go runtime hints. If the
platform mechanism cannot be established, `OpenGroup` returns
`ErrKernelLimitsUnavailable`; the supervisor fails before capabilities can be
granted.

On Windows the group is a Job Object with `JOB_OBJECT_LIMIT_JOB_MEMORY`,
`JOB_OBJECT_LIMIT_ACTIVE_PROCESS` and `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` plus
hard CPU-rate control. Strict children are created suspended, assigned to the
Job Object before they can execute guest code, then resumed. Closing the group
terminates the complete Job process tree.

On Linux the group is a cgroup v2 child created only below an explicitly
delegated absolute `LinuxDelegatedRoot`. The global `/sys/fs/cgroup` root is
rejected, and `statfs` must identify the configured root as an actual cgroup2
filesystem before any control file is changed. The delegated root must expose
`cpu`, `memory` and `pids`; controllers are enabled only in that delegated subtree. Children use
`clone3(CLONE_INTO_CGROUP)` through Go's `UseCgroupFD`, avoiding a post-start
attachment window. `cpu.max`, `memory.max` and `pids.max` enforce the configured
group envelope. The Linux CPU quota is scaled by the logical CPUs available to
the supervisor so the configured percentage denotes the same fraction of host
CPU capacity as the Windows Job Object rate. Close uses `cgroup.kill` (with a
bounded, repeated PID fallback) and
removes the child cgroup after it is empty.

`Usage` returns process CPU, RSS and peak RSS from `core/resource` while the
child runs. CPU survives termination through `ProcessState`; Linux also
provides final peak RSS through `getrusage`, while Windows preserves sampled
peak RSS. A zero RSS after exit indicates that resident pages were released.

`Monitor(ctx, cpuLimit, rssLimit, interval)` starts sampling only for a caller
marked activity. CPU is charged from that activity's baseline; RSS bounds
apply to observed process resident/peak memory. Zero bounds mean unbounded.
Context/RSS admission is checked before dispatch. The returned idempotent stop
function performs a final check, stops sampling and reports measurement,
budget or context errors. Only one monitor may be active per process; the
adapter has no idle sampling ticker.

The sampled `Usage`/`Monitor` path remains useful for reproducible accounting,
aggregate per-plan CPU bookkeeping and diagnostics. It measures the explicitly
selected child, not the whole descendant tree, and can observe an overrun only
after sampling. `GOMAXPROCS`, `GOMEMLIMIT` and `GOGC` remain cooperative Go
runtime tuning. Neither sampling nor `GOMEMLIMIT` is described as a strict
kernel limit; the Job Object/cgroup is the strict authority. These controls are
process/resource containment for trusted first-party workers, not a complete
hostile-code filesystem/network sandbox.
