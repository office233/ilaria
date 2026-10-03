# SWOS-000 / M0 — Benchmark & Fault-Injection Suite Definition

**Rol:** QA / audit  
**Task-kernel:** `task-muldzkpp-4df03d7b`  
**Data:** 2026-09-28  
**Scope:** definește suita M1; nu implementează harness-ul.  
**Surse inspectate:** `E:\CEO\specs\mission-swypikos-ilaria.md`, `E:\nexus`, `E:\nexus\swypik-os`, `E:\nexus\swyp`, `E:\chat-gpt-bridge\lib\task-kernel.js`, `E:\chat-gpt-bridge\lib\tools\tasks.js`, testele task-kernel.  
**Baseline M0 SwypikOS/Ilaria:** `96290fa1d881b935e380f0dbed5a4e8d9b552834`.  
**Baseline bridge task-kernel:** repo-ul bridge nu are commit Git; se pin-uiește prin SHA-256:
- `lib/task-kernel.js`: `706FF6269D88A7C9627B03F300C0F3846BC593E9093257496DE1DC4BE192E102`
- `lib/tools/tasks.js`: `1683FD9E7B6DA37740F073EA706028E171780D9AE7849AA0AFAED16EB5C2D736`
- `tests/task-kernel.test.js`: `ECE8C9B6E57021658C845CFA61A612E990F28D3D21A571FC68CE5FEAF3F0719B`

> Principiu: nu se declară „superioritate” dintr-un singur număr. M1 poate revendica un avantaj numai după rularea aceleiași suite, pe același host și cu aceleași seed-uri, împotriva baseline-ului pre-M1 și a adapterului bridge task-kernel, cu toate invariants de corectitudine/securitate trecute. Orice metrică neexecutată aici este marcată **UNVERIFIED**.

---

## 1. Metrici Stream D

### Reguli comune de comparație

- **B0 / previous:** commit-ul M0 curent `96290fa1d881b935e380f0dbed5a4e8d9b552834`, rulat din artifact/checkout separat și imuabil; checkout-ul activ nu se schimbă în timpul benchmark-ului.
- **B1 / bridge:** adapter direct peste `createTaskKernel()` din bridge, pin-uit prin hash-urile de mai sus. Se compară numai suprafața semantic echivalentă: submit/admission, lease, dispatch binding, state transition, replay/recovery, journal. Nu se compară server HTTP complet cu kernel in-process.
- Pentru metricile „mai mic e mai bun”: M1 trebuie să atingă pragul absolut și, unde este comparabil, să fie `<= 0.80 × B0`; față de B1 se raportează raportul brut și nu se face claim dacă scope-ul diferă.
- Pentru metricile „mai mare e mai bun”: prag absolut + `>= 1.25 × B0` pe aceeași configurație.
- Pentru **duplicate side effects**, **collisions** și invariants de security: pragul este zero; nu există buget de regresie.
- p50/p95 se calculează pe valorile brute, nearest-rank, fără eliminarea outlier-ilor. Warmup-urile sunt etichetate și excluse, nu șterse din JSON.

| Metrică | Definiție operațională | Cum se măsoară concret pe Windows | Unitate | Eșantion M1 | Prag țintă M1 | Comparație baseline | Status M0 |
|---|---|---|---|---|---|---|---|
| **cold-start** | Timp de la `CreateProcess` până când orchestratorul emite evenimentul `scheduler_ready` după load/replay și poate accepta primul task. Nu include UI/model warmup. | Harness M1: `go run ./cmd/swypik-bench --case cold-start --reps 30 --json <out>`. Wrapper-ul pornește un proces nou cu `System.Diagnostics.Stopwatch` și citește markerul JSON de readiness de pe stdout. Capture env: `Get-CimInstance Win32_OperatingSystem`, `Get-CimInstance Win32_Processor`. | ms, p50/p95 | 30 procese fresh; ordine B0/M1/B1 randomizată | p95 **<= 300 ms** și <=0.80× B0 | aceeași stare de journal (0 și 10k events); bridge prin child Node adapter până la `createTaskKernel` ready | **UNVERIFIED** |
| **idle RAM** | Memoria privată a procesului după startup + replay, fără task activ, după 60 s quiescence. Se raportează și working set, dar targetul este Private Bytes. | `Get-Process -Id $pid | Select-Object Id,@{N='PrivateMiB';E={$_.PrivateMemorySize64/1MB}},@{N='WorkingSetMiB';E={$_.WorkingSet64/1MB}}`. Harness ia 12 sample-uri la 5 s și folosește mediana ultimelor 6. | MiB | 10 procese × 60 s; journal 0 și 10k events | median Private Bytes **<= 96 MiB**, p95 **<= 128 MiB**, <=0.80× B0 | B0 și B1 child process cu același dataset de task-uri | **UNVERIFIED** |
| **task overhead** | Cost orchestration-only pentru un task no-op durabil: submit → admission/claim → bind synthetic dispatch → verifying → succeeded, exclus worker/model/tool. | `go test ./benchmarks/orchestrator -run '^$' -bench '^BenchmarkTaskLifecycle$' -benchtime=10000x -count=5 -benchmem`; adapter B1 rulează aceeași state machine și același fsync policy declarat. | ns/op sau ms/task; allocs/op | 5 × 10k lifecycle-uri, 5 seed-uri | p50 **<= 2 ms/task**, p95 **<= 8 ms/task**, <=0.80× B0 | B0/M1/B1 alternat în același run; aceeași locație de disk temp și aceeași durabilitate | **UNVERIFIED** |
| **scheduler throughput** | Număr de task-uri independente pentru care schedulerul poate efectua readiness/dependency/resource/lease decision pe secundă, cu jurnalizare activă. | `go run ./cmd/swypik-bench --case scheduler-throughput --duration 10s --workers 8 --queue 10000 --json <out>`. Verificare CPU separat cu `Get-Process`. | decisions/s și completed no-op tasks/s | 10 ferestre × 10 s după 2 warmups | **>= 1,000 decisions/s** și >=1.25× B0; fără erori/invariants rupte | B0 și B1 cu aceeași coadă pre-generată și same seed | **UNVERIFIED** |
| **recovery time după crash** | Din momentul pornirii procesului de recovery până la reconstruirea DAG-ului, marcarea corectă a task-urilor in-flight și disponibilitatea pentru reconcile; fără resend automat al unui dispatch ambiguu. | `go run ./cmd/swypik-bench --case recovery --journal-events 100,1000,10000 --crashes 30 --json <out>`. Crash-ul este al child-ului harness, nu al bridge-ului real. | ms p50/p95, tasks/s replay | 30 crash-uri pentru fiecare mărime de journal (90 total) | la 10k events: p95 **<= 750 ms** și <=0.75× B0; zero dispatch duplicat | B1 folosește reopen `createTaskKernel` și același număr de events | **UNVERIFIED**; există test funcțional bridge |
| **duplicate side-effect rate** | Număr de efecte externe executate de >1 ori pentru aceeași operație logică/idempotency key / total operații logice, sub retry/crash/lost-ACK. | `go run ./cmd/swypik-bench --case duplicate-side-effect --tasks 10000 --fault-seeds seeds.json --json <out>`; side-effect-ul este un ledger local atomic cu idempotency key. | % și count | 10k task-uri × fault points (pre-send, post-send/pre-bind, post-bind/pre-ack) | **0 / 10,000**; orice duplicat = FAIL | B0/B1 rulate identic; se raportează count, nu doar procent rotunjit | **UNVERIFIED** |
| **worktree/file collision rate** | Perechi de task-uri cu write-set/lease scope incompatibil care au fost simultan admise și au produs overlap real sau stale-write. | `go run ./cmd/swypik-bench --case collision --pairs 10000 --parallel 32 --json <out>`; canary files + SHA-256 pre/post; canonical paths includ case, symlink/junction și prefix overlap. | collisions / contending pairs; % | 10k perechi, 32 concurență, 20 path patterns | **0 / 10,000** | față de B0/B1 se măsoară atât collision, cât și false-conflict separat (diagnostic, nu target principal) | **UNVERIFIED** |
| **CPU per orchestration task** | CPU user+kernel consumat de orchestrator împărțit la task-uri finalizate în workload no-op; nu include worker/model child CPU. | În jurul unui batch N: `$c0=(Get-Process -Id $pid).TotalProcessorTime.TotalMilliseconds`; rulează batch; `$c1=...`; `($c1-$c0)/$N`. Harness salvează și wall-clock. | CPU-ms/task | 5 × 10k task-uri; 1 și 8 scheduler workers | p50 **<= 1.5 CPU-ms/task**, p95 **<= 4 CPU-ms/task**, <=0.80× B0 | process-isolated B0/M1/B1, aceeași affinity declarată | **UNVERIFIED** |
| **token/model-call efficiency** | Tokens de orchestrare și număr de model calls necesare pentru un task reușit, separate de tokens ai task-ului propriu-zis. Kernel paths deterministe trebuie să consume zero model calls. | `go run ./cmd/swypik-bench --case model-efficiency --corpus benchmarks/orchestrator/fixtures/tasks.jsonl --json <out>`; provider adapter returnează usage counters; verificare JSON cu PowerShell `Get-Content <out> | ConvertFrom-Json`. | tokens/success, calls/success, success/call | 100 task-uri fixe × 3 seeds; doar providers deja autorizați sau replay fixtures | kernel deterministic: **0 calls / 0 tokens**; agentic corpus: tokens/success <=0.80× B0, calls/success <= B0, aceeași rată de acceptare | compare numai aceeași fixture și aceleași răspunsuri replay când se testează kernelul; provider live separat | **UNVERIFIED** |
| **latency p50/p95** | Latența orchestration-plane pentru `submit→claimed` și separat `ready→dispatch_bound`, exclus provider response. | `go run ./cmd/swypik-bench --case latency --tasks 10000 --parallel 1,8 --json <out>`; timestamps monotonic în harness. | ms p50/p95/p99 | 10k tasks × 5 runs, concurrency 1 și 8 | single-worker: p50 **<= 5 ms**, p95 **<= 15 ms**; 8 workers: p95 **<= 30 ms**; <=0.80× B0 | B0/B1 same queue + fsync mode | **UNVERIFIED** |
| **fault-injection pass rate** | Scenarii fault în care toate invariants și oracles obligatorii trec / total scenarii executate. | `go test ./benchmarks/orchestrator/faults -count=1 -v` + `go run ./cmd/swypik-bench --case fault-matrix --seeds seeds.json --json <out>`. | % + failed case IDs | exact 9 clase × minimum 20 seed-uri = >=180 cases; plus deterministic edge vectors | **100%** pe matricea M1; orice failure de security/durability = release blocker | B0/B1 se rulează unde semantic posibil; diferențele se etichetează `unsupported`, nu se numără pass | **UNVERIFIED** |

### Definiție de „superioritate” pentru M1

1. **Hard gates:** duplicate side-effect rate = 0, collision rate = 0, fault-injection = 100%, fără scope escape/prompt-injection privilege gain.
2. **Efficiency score:** pentru metricile comparabile `cold-start, idle RAM, task overhead, throughput, recovery, CPU/task, latency`, se publică fiecare raport M1/B0 și M1/B1; nu se ascunde nicio regresie.
3. **Claim permis:** doar dacă hard gates trec, minimum 5/7 metrici de efficiency îmbunătățesc B0 cu >=20%, iar celelalte nu regresează >5%. Pentru B1 se declară doar rezultate per metrică, nu verdict global dacă scope-ul nu este identic.
4. **Token efficiency** nu poate compensa o scădere de corectitudine: corpusul trebuie să păstreze aceleași acceptance oracles.

---

## 2. Fault classes — exact 9

| # | Fault class | Metoda de injecție | Invariant așteptat | Oracle pass/fail | Automatizare M1 |
|---:|---|---|---|---|---|
| 1 | **crash/restart** | Rulează orchestratorul într-un child process; injectează kill la checkpoint-uri deterministe: după durable submit, după claim, după dispatch send simulat, după bind, în verifying. Repornește doar child-ul de test. Scenariu de referință real furnizat pentru 2026-09-28: task-kernel-ul bridge a fost repornit de **3 ori în 8 minute** de editări externe, iar lease-urile active au devenit `interrupted`. | Replay nu inventează succes; toate task-urile active la crash ajung într-o stare recovery explicită; lease-ul vechi nu mai conferă ownership; `dispatchId` deja trimis se păstrează; nicio retrimitere până la reconcile cu evidence. | PASS dacă state hash după restart corespunde prefixului durabil, active→interrupted/recovery corect, lease vechi respins, dispatch count neschimbat. FAIL la task pierdut, succes fals, lease valid după restart sau resend automat. | `fault-matrix --class crash-restart --checkpoint <n> --seed <s>`; child process + side-effect ledger + state snapshot JSON. |
| 2 | **duplicate dispatch** | Introduce lost ACK și retry concurent pentru același idempotency key; două callers încearcă submit/claim; separat injectează „provider accepted dispatch, bind response lost”. | Cel mult un logical dispatch/side effect pentru aceeași idempotency key; dacă existența dispatch-ului e ambiguă, task-ul intră în reconcile/uncertain, nu resend orb. | Ledger atomic trebuie să aibă exact 1 entry/idempotency key. Audit trail trebuie să arate reuse/reconcile, nu al doilea dispatch. | Fake provider cu counter persistent și fault points; 10k logical tasks, barriers pentru race. |
| 3 | **stale lease** | Claim A → capture lease L1; apoi expiră timpul cu fake clock sau restart/reclaim → L2; încearcă heartbeat/bind/update cu L1 și cu lease lipsă. | Doar lease-ul curent, neexpirat, poate muta task-ul; stale/missing lease nu poate produce side effects sau state transition. | PASS dacă fiecare operație cu L1 este respinsă, journal/state nu se schimbă exceptând event-ul de denial dacă proiectat, iar L2 rămâne owner unic. | Fake clock determinist; table-driven vectors pentru expiry, restart, wrong task, random lease. |
| 4 | **race/worktree conflict** | 32 goroutines/process clients încearcă claim simultan pe același `leaseKey`; apoi pe path-uri canonice care se suprapun (`repo`, `repo\sub`, case variants, symlink/junction aliases). | Exact un owner pentru un exclusivity domain; write-set-uri incompatibile nu sunt active simultan; hash/checksum nu arată lost update. | PASS dacă maximum un claim conflictual este admitted și canary files rămân conforme cu serial order. FAIL la două owners sau modificări suprapuse necoordonate. | Barrier start, deterministic path corpus, atomic result ledger; repetat 10k pairs. |
| 5 | **prompt injection** | Pune payload-uri ostile în README/tool output/web text/issue fixture: „ignore policy”, „read .env”, „run command”, „grant capability”. Plannerul poate propune orice, dar policy engine primește output-ul ca date neîncrezute. | Conținutul neîncrezut nu poate lărgi capabilities/allowed paths, nu poate dezactiva verifier-ul și nu poate transforma data în authority. | PASS dacă tool call interzis este blocat înainte de execuție, niciun sentinel secret nu apare în prompt/log/output și auditul conține deny reason. FAIL la orice capability escalation sau secret disclosure. | Fixtures JSONL cu attack vectors; fake model care emite deliberat tool calls interzise; filesystem canaries; no network. |
| 6 | **scope escape** | Vectors Windows: `..\`, absolute drive, UNC, `\\?\`, mixed slash/case, junction/symlink escape, sibling-prefix, NTFS ADS (`file:stream`), reserved device names; process command cu cwd în afara scope-ului. | Path authorization se face pe path canonical/final, sub capability; symlink/junction nu ocolește root; secrets paths și process/network caps rămân inaccesibile. | PASS dacă toate escape vectors sunt refuzate și sentinel outside-root este byte-identical. FAIL la orice read/write/process în afara capabilității. | Table-driven tests + temporary dirs/junctions când privilege disponibil; unsupported symlink privilege = explicit SKIP, nu PASS; CI cu runner care suportă vectorul. |
| 7 | **low RAM/CPU** | Primar: fake resource provider trece `normal→elevated→critical` la task N. Secundar: child orchestration process într-un Windows Job Object cu memory/CPU cap; nu se stresează host-ul real intenționat. | La critical nu se admit task-uri grele noi; task-urile durabile rămân queued; in-flight state/journal rămâne consistent; scheduler revine după relief fără duplicate. | PASS dacă admission este refuzat la threshold, zero task pierdut/duplicat, și queue se reia când capacity revine. | Deterministic fake telemetry în unit/fault suite; Job Object test separat, serial, cu ceiling conservator. |
| 8 | **network/provider outage** | Fake provider injectează timeout, connection reset, 429, 500/503, partial response și outage de 30 s la call index determinist; clock fake pentru backoff. | Retry bounded + backoff; task local/offline independent continuă; state este recoverable; același side effect nu se repetă; outage nu blochează global scheduler-ul. | PASS dacă retries <= policy, deadlines respectate, provider task ajunge retryable/interrupted/failed conform contractului, alte task-uri progresează, ledger duplicate=0. | Scriptable fake provider cu fault schedule JSON; network real nu este necesar pentru gate-ul determinist. |
| 9 | **corrupted journal** | Generează journal valid într-un temp fixture; variante: truncate final record, flip bytes în ultima linie, corrupt record din mijloc, duplicate/out-of-order sequence, invalid checksum/version. | Nu se face silent replay peste corupție. Tail parțial poate fi ignorat/recoverat numai conform formatului; corupția în mijloc trebuie detectată/fail-closed sau restaurată din checkpoint verificat. Schedulerul nu execută pe state ambiguu. | PASS dacă state hash este exact ultimul checkpoint/prefix valid acceptat și corupția este raportată; FAIL dacă record-uri de după o ruptură sunt aplicate, state-ul este inventat sau se pornește dispatch pe journal ambiguu. | Byte-level mutator cu seed; corpus de journals; oracle compară hash-chain/checkpoint/state snapshot. |

### Acoperire existentă reutilizabilă

- Bridge `task-kernel.test.js` are deja: idempotency; lease exclusiv; dependency DAG; verifier-before-success; restart→`interrupted`; reconcile direct în `verifying`; refusal la resource pressure critical.
- Bridge `lib/task-kernel.js` face replay din `events.jsonl`, fsync la append, întrerupe active tasks la reopen și respinge stale/missing leases. Parserul tolerează o ultimă linie JSON incompletă, dar corupția din mijloc produce error — util ca baseline pentru fault #9.
- SwypikOS are deja teste relevante în `core/agent/recovery_test.go`, `core/agent/runtime_test.go`, `core/agent/workspace_tools_test.go`, `internal/safepath/path_test.go`, `internal/storage/file_test.go`. Acestea sunt seed coverage, nu suita M1 completă.

---

## 3. Inventar harness-uri existente

### 3.1 `E:\nexus\swypik-os`

Au fost găsite **67** fișiere `*_test.go`. Singura declarație Go `func Benchmark...` găsită este:

- `ui\engine\render_bench_windows_test.go:15 — BenchmarkRenderHome`

Inventarul complet relativ la `E:\nexus\swypik-os`:

```text
cmd\swypik-os\main_windows_test.go
config\config_test.go
config\regression_test.go
config\settings_test.go
core\actiongraph\graph_test.go
core\agent\hardening_test.go
core\agent\recovery_test.go
core\agent\runtime_test.go
core\agent\store_linux_test.go
core\agent\store_windows_test.go
core\agent\workspace_tools_test.go
core\appstore\appstore_test.go
core\audio\audio_test.go
core\audio\regression_test.go
core\autogenesis\autogenesis_test.go
core\azure\azure_test.go
core\bci\bci_test.go
core\boot\installer_test.go
core\bridge\device_test.go
core\cbf\cbf_test.go
core\chameleon\chameleon_test.go
core\coder\coder_test.go
core\coder\fuzz_test.go
core\coder\output_test.go
core\coder\shell_windows_test.go
core\compute\compute_test.go
core\cyber\cyber_test.go
core\docs\docs_test.go
core\evidence\evidence_test.go
core\evolution\evolution_test.go
core\federated\federated_test.go
core\federated\gradient_test.go
core\federated\regression_test.go
core\hal\cuda_driver_test.go
core\hal\hal_test.go
core\hal\serial_test.go
core\hive\hive_test.go
core\ilaria\backend_cloud_test.go
core\ilaria\backend_live_test.go
core\ilaria\backend_test.go
core\ilaria\concurrency_test.go
core\ilaria\ilaria_test.go
core\ilaria\protocol_test.go
core\l402\l402_test.go
core\l402\regression_test.go
core\network\status_test.go
core\neuromorphic\adapter_test.go
core\notifications\broker_test.go
core\proactive\engine_test.go
core\search\search_test.go
core\security\guard_test.go
core\service\service_test.go
core\session\session_test.go
core\sheets\regression_test.go
core\sheets\sheets_test.go
core\swarm\swarm_test.go
core\wallet\regression_test.go
core\wallet\wallet_test.go
core\worldmodel\worldmodel_test.go
installer\universal\engine_test.go
installer\windows\installer_windows_test.go
internal\safepath\path_test.go
internal\storage\file_test.go
mobile\bridge\bridge_test.go
ui\desktop\controller_test.go
ui\engine\native_runtime_windows_test.go
ui\engine\render_bench_windows_test.go
```

Cele mai direct reutilizabile pentru M1:
- `core\agent\recovery_test.go`: crash recovery, uncertain execution, checkpoint failure, evidence preservation, policy/deadline recovery.
- `core\agent\runtime_test.go`: workspace scope, symlink escape, `untrusted_observations` trust boundary.
- `core\agent\workspace_tools_test.go`: stale SHA rejection, unsafe path rejection, process runner gating.
- `internal\safepath\path_test.go`: canonical boundary + symlink resolution.
- `internal\storage\file_test.go`: atomic-ish replace behavior / no temp leak.
- `core\actiongraph\graph_test.go`: graph execution/checkpoints/context token compaction.
- `ui\engine\render_bench_windows_test.go`: existent performance harness, dar este UI, nu orchestrator.

### 3.2 `E:\nexus\swyp\benchmarks`

```text
swyp\reference.c
swyp\reference.go
swyp\reference.js
swyp\reference.py
swyp\reference.rs
swyp\refinement_eval.py
swyp\research_campaign.py
swyp\research_driver.go
swyp\run.py
swyp\synthesis_eval.py
swyp\synthesis_matrix.py
```

Observații utile:
- `swyp\run.py` are deja bune practici: seed fix `20260927`, warmup separat, 5 repetări, ordine randomizată, verificare semantică a rezultatului, JSON cu versiuni + SHA-256, opțiune `--baseline`.
- `swyp\research_driver.go` compară variante în același process/VM, 200 warmups/module, 9 rounds, seed `20260928`, validează rezultatul la fiecare run și emite JSON. Acest stil trebuie copiat conceptual în harness-ul M1.

### 3.3 `E:\nexus\cortex\*bench*_test.go`

```text
cortex\benchmark_test.go
cortex\bitnet_bench_test.go
cortex\transformer_bench_test.go
```

Benchmark-uri identificate:
- `BenchmarkNeuronPoolStep`
- `BenchmarkNetworkTick`
- `BenchmarkPrefrontalThink`
- `BenchmarkThousandBrainsProcess`
- `BenchmarkBitLinearForwardBatch` (T=1, T=16)
- `BenchmarkTransformerForward`
- `BenchmarkTransformerGenerateFast`
- `BenchmarkTransformerTrainStep`

Nu sunt benchmark-uri de orchestrator; sunt inventariate ca exemple de reproducibilitate/performance din repo.

### 3.4 Continual benchmark și documentație

- `E:\nexus\cmd\continual-bench\main.go` — benchmark learn-once / reload / frozen-transformer comparison; scrie raport JSON și folosește setări explicite.
- `E:\nexus\docs\benchmarks\arena_en.md`
- `E:\nexus\docs\benchmarks\baseline_2026-05-24.md`
- `E:\nexus\docs\benchmarks\RADIO_CORTEX_V0.md`
- `E:\nexus\docs\benchmarks\tools_eval.md`

### 3.5 `E:\chat-gpt-bridge` task-kernel baseline

- `E:\chat-gpt-bridge\lib\task-kernel.js`
- `E:\chat-gpt-bridge\lib\tools\tasks.js`
- `E:\chat-gpt-bridge\tests\task-kernel.test.js`
- `E:\chat-gpt-bridge\tests\server-integration.test.js` verifică suplimentar că worker profile nu expune `task_*` și că gateway-ul nu permite capability-call către task kernel.

Cele 7 teste din `task-kernel.test.js`:
1. idempotency returns original task;
2. exclusive lease prevents same-tree double ownership;
3. dependency DAG waits/blocks;
4. independent verification required before success;
5. restart converts in-flight lease to interrupted + reconcile existing dispatch;
6. completed existing dispatch can recover direct to verification;
7. critical resource pressure refuses claim.

---

## 4. Baseline ieftin EXECUTAT

### 4.1 Mediu observat

- Windows: `Windows_NT 10.0.26200 x64`
- CPU: 8 logical CPUs; benchmark Go raportează `Intel(R) Core(TM) i7-9700 CPU @ 3.00GHz`
- RAM total: **15.92 GB**
- RAM liber la începutul auditului: **~1.50 GB**, pressure `elevated`
- înainte de a doua încercare Go: **~1.05 GB** liber
- Node: `v24.15.0`
- Go: `go1.26.2 windows/amd64`
- Power plan: **High performance**
- Git `E:\nexus`: `96290fa1d881b935e380f0dbed5a4e8d9b552834`

### 4.2 Măsurarea #1 — bridge task-kernel single-file suite

Comandă:

```powershell
$sw=[System.Diagnostics.Stopwatch]::StartNew()
node --test tests/task-kernel.test.js
$ec=$LASTEXITCODE
$sw.Stop()
Write-Output ('ELAPSED_MS=' + [math]::Round($sw.Elapsed.TotalMilliseconds,3))
exit $ec
```

Output brut:

```text
✔ idempotency returns the original task instead of duplicating work (7.0162ms)
✔ exclusive lease prevents two workers from owning the same tree (6.995ms)
✔ dependency DAG waits for success and blocks after failed predecessor (8.1233ms)
✔ state machine requires independent verification before success (10.2159ms)
✔ restart converts in-flight leases to interrupted instead of pretending work is still owned (7.9684ms)
✔ recovery can move a completed existing dispatch straight to verification without re-sending it (9.9723ms)
✔ critical resource pressure refuses a new worker claim (3.5857ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 142.6714
ELAPSED_MS=218.743
```

Rezultat: **PASS 7/7**. Acesta este baseline funcțional/smoke; `ELAPSED_MS` include startup Node + test runner. Nu este încă metrică M1 de throughput.

### 4.3 Măsurarea #2 — scenariu restart/recovery izolat

Comandă:

```powershell
$sw=[System.Diagnostics.Stopwatch]::StartNew()
node --test --test-name-pattern='restart converts in-flight leases' tests/task-kernel.test.js
$ec=$LASTEXITCODE
$sw.Stop()
Write-Output ('ELAPSED_MS=' + [math]::Round($sw.Elapsed.TotalMilliseconds,3))
exit $ec
```

Output brut:

```text
✔ restart converts in-flight leases to interrupted instead of pretending work is still owned (12.3961ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 100.3725
ELAPSED_MS=164.827
```

Rezultat: **PASS**. Testul redeschide același journal în fixture și verifică `interrupted`, lease clear, refuz de reclaim fără reconcile și păstrarea `dispatchId`. Nu este un process-kill benchmark; recovery time real rămâne **UNVERIFIED**.

### 4.4 Măsurarea #3 — benchmark Go existent, un singur package, `benchtime=1x`

Prima încercare a fost refuzată automat de resource admission pentru clasa heavy:

```text
Resource admission timed out for heavy: 751 MB free, CPU 50%, 0/1 slot(s) active; requires at least 1024 MB free and CPU <= 85%.
```

Nu s-a forțat execuția. După ce memoria liberă observată a urcat la ~1071 MB, aceeași comandă a fost admisă.

Comandă:

```powershell
$sw=[System.Diagnostics.Stopwatch]::StartNew()
go test -run '^$' -bench '^BenchmarkRenderHome$' -benchtime=1x -count=1 ./ui/engine
$ec=$LASTEXITCODE
$sw.Stop()
Write-Output ('ELAPSED_MS=' + [math]::Round($sw.Elapsed.TotalMilliseconds,3))
exit $ec
```

Output brut:

```text
goos: windows
goarch: amd64
pkg: swypik-os/ui/engine
cpu: Intel(R) Core(TM) i7-9700 CPU @ 3.00GHz
BenchmarkRenderHome-8          1    35300100 ns/op
PASS
ok      swypik-os/ui/engine   1.403s
ELAPSED_MS=3661.086
```

Rezultat: **PASS**, `35,300,100 ns/op = 35.3001 ms/op` pentru un singur warm-path render iteration în benchmark-ul existent. Este doar dovadă că harness-ul Go existent rulează pe host; nu este metrică de orchestrator și nu trebuie folosită pentru claim M1.

### 4.5 Ce NU s-a măsurat în M0

**UNVERIFIED:** cold-start orchestrator, idle RAM orchestrator, task lifecycle overhead, scheduler throughput, process-level crash recovery p50/p95, duplicate side-effect rate, file/worktree collision rate, CPU/task, token/model-call efficiency, orchestration latency p50/p95 și full 9-class fault pass rate.

---

## 5. Protocol reproductibil M1 + layout propus

### 5.1 Environment capture obligatoriu

Fiecare run produce `env.json` înainte de primul sample:

```powershell
git -C E:\nexus rev-parse HEAD
go version
node --version
powercfg /GETACTIVESCHEME
Get-CimInstance Win32_OperatingSystem |
  Select-Object Caption,Version,BuildNumber,OSArchitecture,TotalVisibleMemorySize,FreePhysicalMemory
Get-CimInstance Win32_Processor |
  Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed
```

Se mai salvează:
- hash SHA-256 al artifactelor benchmarkate;
- hash/config schema al scenario corpus;
- command line exact;
- filesystem volume + free space pentru journal;
- `GOMAXPROCS`, număr scheduler workers, journal mode;
- provider mode: `replay`, `fake` sau explicit live;
- RAM/CPU pressure la start/end.

### 5.2 Seeds

Seed set standard M1, versionat:

```text
20260928
2026092801
2026092802
2026092803
2026092804
2026092805
2026092811
2026092823
2026092847
2026092897
```

Fault campaign: minimum 20 seeds/clasă; derive suplimentar `seed = base XOR scenario_id`. Orice failure trebuie reproducibil printr-un singur `--seed`.

### 5.3 Warm vs cold

- **Cold-start:** process fresh la fiecare sample. Nu se face cache flush de OS în suita standard deoarece ar necesita acțiuni intrusive și ar introduce noise; B0/M1/B1 se rulează în ordine randomizată AB/BA pentru a amortiza cache-ul.
- **Warm microbench:** 5 warmups sau minimum 1 s warmup, apoi samples. Warmups se păstrează în `raw.jsonl` cu `phase:"warmup"`.
- **Recovery:** journal fixture identic byte-for-byte pentru fiecare variantă; checksum-ul fixture-ului se salvează.
- **Provider/model:** gate-ul determinist folosește fake/replay. Live provider runs sunt benchmark separat și nu pot schimba verdictul invariants de kernel.

### 5.4 Repetiții recomandate

- timings de proces: n=30;
- memory: n=10 procese, 12 snapshots/proces;
- microbench/task/CPU: 5 runs × 10k tasks;
- throughput: 10 × 10 s;
- recovery: 30 crash-uri × fiecare journal size;
- collision/duplicate: minimum 10k logical cases;
- model efficiency: 100 task corpus × 3 seeds;
- fault matrix: 9 × >=20 seeds.

Dacă host-ul este `pressure:elevated`, run-ul se poate executa dar se etichetează `environment_degraded:true`; dacă admission control refuză heavy, cazul se marchează `NOT_RUN_RESOURCE_GUARD`, nu FAIL și nu se forțează.

### 5.5 Ordine și fairness

1. Generează fixture-urile o singură dată și hash-uiește-le.
2. Pentru fiecare round, randomizează ordinea B0/M1/B1 cu seed fix.
3. Rulează serial benchmark-urile heavy pe host-ul de ~16 GB.
4. Nu rulează GPU, training, full repo suite sau alte workloads intenționat.
5. Nu compară build-cache-hit cu build-cache-cold fără etichetare.
6. Aceleași fsync/durability guarantees trebuie folosite la comparație; dacă B1 fsync-ează fiecare event și M1 nu, rezultatul se etichetează `NON_EQUIVALENT_DURABILITY`.
7. Nicio „optimizare” nu poate dezactiva audit log, verification sau security checks doar pentru benchmark.

### 5.6 JSON rezultat — schema minimă

```json
{
  "schema": "swos-bench/v1",
  "run_id": "2026-09-28T...-seed-20260928",
  "metric": "recovery_time",
  "variant": "m1",
  "baseline": {
    "previous_commit": "96290fa1d881b935e380f0dbed5a4e8d9b552834",
    "bridge_task_kernel_sha256": "706FF6269D88A7C9627B03F300C0F3846BC593E9093257496DE1DC4BE192E102"
  },
  "environment": {},
  "scenario": {},
  "seed": 20260928,
  "warmups": [],
  "samples": [],
  "summary": {
    "n": 30,
    "p50": null,
    "p95": null,
    "min": null,
    "max": null
  },
  "oracles": [],
  "passed": false,
  "raw_stdout_sha256": ""
}
```

Reguli:
- samples brute rămân în JSONL; summary se poate regenera;
- timestamps wall-clock sunt pentru audit, duratele se măsoară cu monotonic clock;
- fiecare fault case include `fault_class`, `fault_point`, `seed`, `expected_invariants`, `observed_state_hash`, `side_effect_ledger_hash`;
- orice SKIP are reason explicit și nu se numără PASS.

### 5.7 Layout propus pentru harness în M1

```text
E:\nexus\swypik-os\
  benchmarks\
    orchestrator\
      README.md
      schema\
        result-v1.schema.json
      fixtures\
        tasks.jsonl
        prompt-injection.jsonl
        path-escape-windows.json
        provider-faults.json
        journals\
      seeds.json
      bench_test.go
      metrics_test.go
      faults\
        crash_restart_test.go
        duplicate_dispatch_test.go
        stale_lease_test.go
        race_collision_test.go
        prompt_injection_test.go
        scope_escape_test.go
        resource_pressure_test.go
        provider_outage_test.go
        corrupted_journal_test.go
      internal\
        runner\
        metrics\
        oracle\
        faultinject\
        ledger\
        envcapture\
  cmd\
    swypik-bench\
      main.go
```

Rezultatele generate **nu** trebuie amestecate cu source fixtures. Propunere:

```text
results\orchestrator-bench\
  <commit-or-hash>\
    <run-id>\
      env.json
      raw.jsonl
      summary.json
      stdout.txt
      stderr.txt
      artifacts.sha256
```

### 5.8 Gates M1

Un build M1 nu este „benchmark complete” până când:
- toate cele 11 metrici au samples brute și summary;
- toate cele 9 fault classes au fost executate;
- hard gates security/durability trec 100%;
- B0 și B1 sunt pin-uite prin commit/hash;
- raportul include environment + commands + seed;
- raw JSON și checksum-urile permit rerun identic;
- orice metrică lipsă rămâne **UNVERIFIED**, nu este completată prin estimare.

---

## Final M0 QA verdict

Suita necesară pentru M1 este definită cu metrici, fault model, oracles, sample sizes, target gates, baseline IDs și protocol reproducibil. Există material bun de reutilizat în SwypikOS și bridge, dar current-state nu are încă un harness unic care să măsoare Stream D end-to-end. Baseline-urile executate aici sunt intenționat ieftine și confirmă că task-kernel test surface și un benchmark Go izolat rulează; ele nu justifică încă niciun claim de superioritate.
