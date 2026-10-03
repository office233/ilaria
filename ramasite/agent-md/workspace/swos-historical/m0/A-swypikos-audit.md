# SWOS-000 / M0 „Truth” — SwypikOS current-state audit

**Task kernel:** task-muldza3j-c881317e  
**Checkout auditat:** E:/nexus/swypik-os  
**Repo:** E:/nexus  
**Branch / HEAD verificat la început:** main / 96290fa  
**Data auditului:** 2026-09-28  
**Mod de lucru:** read-only asupra E:/nexus; singura scriere este acest raport.

## Verdict executiv

SwypikOS are astăzi un **desktop Windows nativ Go/Win32 funcțional**, un agent Ilaria integrat cu aprobări per tool, checkpoint atomic pentru run-ul curent, motor local de căutare persistent și o pistă Linux live-RAM pre-alpha. Nu este încă „Autonomous Kernel” în sensul mission: lipsesc DAG-ul durabil de task-uri, leases, capability broker autentic, verifier separat, event store imuabil, scheduler local/cloud, resource isolation și sandbox OS per-task.

Runtime-ul Windows real este mult mai mic decât suprafața repository-ului. Import graph-ul pentru cmd/swypik-os conține doar config, core/network, internal/safepath, core/agent, core/coder, core/compute, core/ilaria, core/search, core/service, ui/desktop, ui/theme și ui/engine. Majoritatea celorlalte core/* sunt prototipuri experimentale nelegate de produsul curent.

**Business invariant zero-crypto este încălcat în source tree**, chiar dacă modulele financiare nu sunt în import graph-ul desktopului actual: core/l402 implementează Lightning/sats; core/wallet implementează SWP wallet și proof-of-work rewards; core/federated și core/swarm implementează SWP rewards / proof-of-compute, iar core/swarm rulează un hash loop SHA-256; core/azure are wallet/SWP rewards; core/appstore și ui/views conțin copy pentru SWP Coins. Acestea trebuie tratate ca incompatibile cu produsul zero-crypto înainte de M1.

---

# 1. Architecture map

## 1.1 Harta proceselor și fluxurilor

~~~mermaid
flowchart TD
    U[User] --> W[cmd/swypik-os<br/>native Windows process]
    W --> UI[ui/engine<br/>Win32/GDI native shell]
    UI --> DC[ui/desktop.Controller]

    DC --> CHAT[core/ilaria.Engine]
    DC --> AG[core/agent.Manager]
    DC --> SE[core/search.Engine]
    DC --> CO[core/compute.Inspect]

    AG --> JP[core/agent.JSONPlanner]
    JP --> CHAT
    CHAT --> HB[core/ilaria.LocalBackend]
    HB -->|POST /v1/chat| IS[E:/nexus/cmd/ilaria-serve]
    IS --> CX[Ilaria cortex / BitNet runner]
    CX --> IS --> HB --> JP

    AG --> AP{user approval}
    AP -->|approved| WT[Workspace tools]
    WT --> SP[internal/safepath]
    WT --> CR[core/coder.Run]
    CR --> JO[Windows Job Object<br/>lifecycle only, user permissions]
    AG --> CK[current-run.json<br/>atomic single-run checkpoint]

    SE --> SI[persistent local search index]
    CO --> NS[nvidia-smi inventory only]

    subgraph Linux_pre_alpha
      K[stock Linux kernel + BusyBox rootfs]
      K --> D[cmd/swypikd]
      K --> S[cmd/swypik-session]
      S -->|private Unix socket HTTP| D
      D --> SV[core/service]
      SV --> AG2[core/agent<br/>read-only tools + search]
      AG2 --> HB2[core/ilaria backend]
    end

    MB[mobile/bridge] -. not wired to current cmd .-> PX[docs/search/sheets/notifications/swarm prototypes]
    IU[installer/universal] --> META[metadata-only deployment manifest]
    IW[installer/windows] --> LAUNCH[Start-SwypikOS.bat launcher only]

    EXP[other core/*] -. mostly unimported experimental/prototype code .-> W
~~~

## 1.2 Procese/binare și responsabilități

- **cmd/swypik-os** — entrypoint Windows actual. Creează workspace-ul, indexul persistent, backend-ul Ilaria, store-ul durabil al agentului și tool-urile workspace + process.run; apoi pornește UI-ul nativ. Dovadă: cmd/swypik-os/main_windows.go:182-238.
- **ui/engine** — window loop Win32/GDI/GDI+ fără Electron/WebView; încărcare fonturi embedded și input/render native. Dovadă: ui/engine/native_runtime_windows.go:11-72; ui/engine/fonts_windows.go:10-15.
- **ui/desktop** — model/controller testabil pentru tabs, chat, agent, search, files, compute și approvals. Dovadă: ui/desktop/controller.go:27-41,119-133.
- **core/agent** — runtime linear persistent cu limită de pași/durată/tool timeout, aprobare per tool, observations/events și checkpoint pentru run-ul curent. Dovadă: core/agent/runtime.go:79-125,443-460,510-619.
- **core/coder** — executor Windows cu Job Object pentru lifecycle/cancellation; rulează totuși cu drepturile utilizatorului și nu este sandbox. Dovadă: core/coder/coder.go:1-5; core/agent/workspace_tools.go:334-369.
- **core/search** — index local propriu, persistent în desktop; nu este wrapper Google/Bing/DDG. Dovadă: cmd/swypik-os/main_windows.go:187-200; core/search/search.go:303-305.
- **core/compute** — inventariază NVIDIA via nvidia-smi; nu acceptă job-uri și nu implementează coordinator protocol. Dovadă: core/compute/compute.go:1-4,32-35,64-99.
- **cmd/swypikd** — daemon Linux pre-alpha, refuză root, deschide agent store și expune API pe Unix socket privat; agentul Linux are doar ReadOnlyTools + search. Dovadă: cmd/swypikd/main_linux.go:31-79.
- **cmd/swypik-session / core/session** — client framebuffer/evdev pentru sesiunea Linux; pre-alpha, fără compositor/seat/security complete. Dovadă: core/session/session_linux.go:1-36,223-255.
- **system/rootfs** — BusyBox live-RAM; montează proc/sys/dev și tmpfs, pornește swypikd/session ca uid 1000, încearcă drivere kernel fixe și DHCP. Dovadă: system/rootfs/init:1-14; system/rootfs/etc/init.d/rcS:3-23; system/rootfs/etc/inittab:1-6.
- **mobile/bridge** — bibliotecă Go prototype; construiește Ilaria/search/swarm/etc., dar nu există binding JNI/c-shared verificat în această cale. Dovadă: mobile/bridge/bridge.go:14-33.
- **installer/universal** — probe + manifest/descriptori; declară explicit că nu instalează OS, kernel, bootloader sau servicii. Dovadă: installer/universal/engine.go:52-54,181-225.
- **installer/windows** — creează launcher batch pentru bin/swypik-os.exe; nu este OS installer. Dovadă: installer/windows/installer_windows.go:11-12,58-75.

## 1.3 Flux Ilaria

Legătura reală este:

1. cmd/swypik-os creează core/ilaria.Engine și backend-ul configurat (main_windows.go:202-214).
2. agent.JSONPlanner folosește chat.Complete; tool observations sunt transformate în prompt pentru planner.
3. core/ilaria/backend.go construiește **POST {endpoint}/v1/chat** (backend.go:94-102), acceptând doar loopback HTTP 127.0.0.1 sau HTTPS cu bearer token de minimum 32 caractere (backend.go:41-52).
4. Serverul canonic este în modulul părinte **E:/nexus/cmd/ilaria-serve**; handlerul acceptă doar POST /v1/chat și JSON limitat la 64 KiB (E:/nexus/cmd/ilaria-serve/main.go:40-112), apoi apelează cortex runner / BitNet (main.go:152-190).
5. Pentru loopback, serverul restricționează Host la 127.0.0.1 și respinge Origin/cross-site (main.go:49-56). Cloud mode cere TLS + ILARIA_API_TOKEN (main.go:140-150,192-210).

## 1.4 Data stores actuale

- **Agent:** un singur checkpoint curent current-run.json, atomic replace, max 1 MiB, exclusive writer lock; nu este event log append-only. Dovadă: core/agent/store_windows.go:17-18,38-62,126-165.
- **Agent events:** []Event este parte din Run și este rescris odată cu checkpoint-ul; sequence este local run-ului. Dovadă: core/agent/runtime.go:84-105,443-460.
- **Search:** index persistent local.
- **Windows settings/token:** settings.json separat de token; token-ul poate veni din ILARIA_API_TOKEN sau din prima linie a unui fișier token. Dovadă: config/settings.go:108-131.
- **Linux rootfs:** /run, /tmp, /home, /var sunt tmpfs în imaginea live; starea dispare la reboot în acest profil. Dovadă: system/rootfs/init:7-12.

---

# 2. Clasificarea directoarelor

## 2.1 Rubrică

- **real** — este în import graph-ul unui target actual și implementează efectiv comportamentul declarat.
- **prototype** — cod executabil/testat, dar experimental, simulat, pre-alpha sau neintegrat în runtime-ul principal.
- **stub** — API minimal/intenționat dezactivat care refuză operația.
- **dead** — nu are importer non-test în build-urile actuale și reprezintă o pistă legacy/abandonată sau duplicată.

LOC sunt aproximative, din fișiere text/code din director. „Importer” înseamnă importer non-test identificat prin scan de importuri; pentru target-urile cmd nu se aplică.

## 2.2 core/*

| Director | Clasă | Dovezi reprezentative | Teste | Importeri non-test | LOC ~ |
|---|---|---|---|---|---:|
| core/actiongraph | prototype | Checkpoints ținute doar în slice memory graph.go:74,276-291 | da | niciunul | 337 |
| core/agent | **real** | Run/limits/store runtime.go:90-125; approvals + execute 557-619 | da, 6 fișiere | cmd/swypik-os, cmd/swypikd, ui/desktop, core/service, core/session | 2750 |
| core/appstore | **dead** | catalog seed hard-coded appstore.go:37-82; include SWP coin rewards:78 | da | niciunul | 180 |
| core/audio | prototype | buffer in-memory; hardware latency not measured audio.go:85-115; capture „simulates or consumes” :135 | da, 2 | niciunul | 286 |
| core/autogenesis | prototype | driver candidate DRAFT/SIMULATED, fără transport autogenesis.go:36-38,79-81,143-174 | da | installer/universal, core/cyber | 315 |
| core/azure | prototype **ZERO-CRYPTO conflict** | wallet/SWP/proof-of-compute schema.go:43-61; wallet credited coordinator.go:94-119 | da | niciunul | 421 |
| core/bci | prototype | decoder EEG/EMG threshold-based bci.go:22-37,155-185; fără device transport verificat | da | niciunul | 253 |
| core/boot | **stub** | ExecuteDeploy refuză explicit instalarea installer.go:11-13 | da | niciunul | 16 |
| core/bridge | prototype | ADB scan real, dar fallback phone fabricat device.go:85-125; DeployToMobile doar returnează mesaj :144-152 | da | niciunul | 260 |
| core/cbf | prototype | CBF/QP numeric asupra structurilor de stare cbf.go:100-120,147-191; fără actuator transport | da | niciunul | 271 |
| core/chameleon | prototype | capability/MMIO model test-only; testul scrie registre model chameleon_test.go:27-49; fără importer | da | niciunul | 315 |
| core/coder | **real** | process executor actual, user permissions/Job Object coder.go:1-5 | da, 4 | cmd/swypik-os | 533 |
| core/compute | **real (partial)** | GPU detect real; coordinator absent compute.go:1-4,32-35,64-99 | da | ui/desktop, cmd/swypik-os | 136 |
| core/cyber | prototype | in-memory simulation, never device I/O cyber.go:43-46,120-121 | da | niciunul | 641 |
| core/docs | prototype | manager folosit numai de mobile bridge | da | mobile/bridge | 88 |
| core/evidence | prototype-support | niveluri SIMULATED/VERIFIED etc.; folosit de prototipuri | da | autogenesis, cyber, hive | 36 |
| core/evolution | prototype | mutants/benchmark numerical kernel evolution.go:20-46; doar teste, fără gates de produs | da | niciunul | 303 |
| core/federated | prototype **ZERO-CRYPTO conflict** | random simulated gradients federated.go:38-38,75-86; SWP reward :141-162,281-285 | da, 3 | core/swarm | 1206 |
| core/hal | prototype | comentariu explicit legacy inventory, nu kernel driver loader hal.go:83-89; simulations DriverSimulated :43-47 | da, 3 | autogenesis/cyber/swarm/installer | 651 |
| core/hive | prototype | ErrNoTransport și task NOT_EXECUTED hive.go:14-16,121-158 | da | niciunul | 235 |
| core/ilaria | **real** | POST /v1/chat backend.go:41-52,94-130 | da, 6 | cmd Windows/Linux, ui/desktop, mobile | 558 |
| core/l402 | **dead — ZERO-CRYPTO violation** | Lightning invoice/sats l402.go:14-18; micropayments :40; settlement :139-170 | da, 2 | niciunul | 322 |
| core/network | **real** | host network inspection; folosit în agent/service/session | da | core/agent, core/service, core/session | 15 |
| core/neuromorphic | prototype | analog adapter/latent transform adapter.go:40,163-164; fără importer | da | niciunul | 267 |
| core/notifications | prototype | broker folosit numai mobile prototype | da | mobile/bridge | 166 |
| core/proactive | prototype | acțiuni seed declarate deja executate engine.go:44-53; EvaluateContext afirmă auto-dispatch fără transport :56-68 | da | niciunul | 94 |
| core/search | **real** | engine local/persistent; desktop + service îl folosesc | da | cmd Windows/Linux, ui/desktop/engine, service, mobile | 1747 |
| core/security | **dead** | AES/debug guard guard.go:14-30, fără importer în runtime | da | niciunul | 124 |
| core/service | **real** | API local pentru Linux/desktop service; importat de cmd targets | da | cmd/swypikd, cmd/swypik-os | 195 |
| core/session | prototype | Linux framebuffer/evdev pre-alpha; target cmd/swypik-session | da | cmd/swypik-session | 428 |
| core/sheets | prototype | sheet engine folosit numai mobile prototype | da, 2 | mobile/bridge | 256 |
| core/swarm | prototype **ZERO-CRYPTO violation** | CoinsEarned/RewardPerTflop swarm.go:29-57; reward credit :117-145; SHA256 hash loop :148-187 | da | mobile/bridge | 300 |
| core/wallet | **dead — ZERO-CRYPTO violation** | SWP wallet wallet.go:19-36; plaintext private key persisted :39-88; proof-of-work reward :166-184 | da, 2 | niciunul | 308 |
| core/worldmodel | prototype | local physics/counterfactual simulator worldmodel.go:52-75; fără importer | da | niciunul | 201 |

## 2.3 internal/*

| Director | Clasă | Dovezi | Teste | Importeri | LOC ~ |
|---|---|---|---|---|---:|
| internal/safepath | **real** | path canonicalization folosită de agent/UI; workspace checks nu sunt OS sandbox | da | core/agent, ui/desktop | 52 |
| internal/storage | prototype-support | file helper folosit doar de swarm/wallet legacy | da | core/swarm, core/wallet | 55 |

## 2.4 cmd/*

| Director | Clasă | Dovezi | Teste | Consumatori | LOC ~ |
|---|---|---|---|---|---:|
| cmd/swypik-os | **real** | compune agent/search/Ilaria/UI main_windows.go:182-238 | da | executable target | 473 |
| cmd/swypik-os/winres | prototype/support **UNVERIFIED build consumption** | manifest current app, as-invoker/no elevate winres.json:7-28; icon asset prezent | nu | consum prin build tooling nu a fost găsit în import scan | 52 text + icon |
| cmd/swypikd | prototype (Linux pre-alpha) | daemon non-root, agent store + private Unix socket main_linux.go:31-79 | nu direct | executable target Linux | 105 |
| cmd/swypik-session | prototype (Linux pre-alpha) | thin entrypoint peste core/session | nu | executable target Linux | ~6 |

## 2.5 system/* — inclusiv subdirectoarele reale

| Director | Clasă | Dovezi | Teste | Consumatori | LOC ~ |
|---|---|---|---|---|---:|
| system/rootfs | prototype | live-RAM BusyBox init, tmpfs init:1-14 | nu | ISO/Linux image path | 72 total |
| system/rootfs/etc | prototype-support | inittab pornește procese ca swypik inittab:1-6; DHCP config | nu | BusyBox init | subset din 72 |
| system/rootfs/etc/init.d | prototype-support | rcS module/DHCP, diagnostic-only warning rcS:3-23 | nu | inittab | 24 |
| system/rootfs/usr | prototype-support | container pentru userland Swypik | nu | rootfs | subset |
| system/rootfs/usr/bin | prototype-support | start-swypikd setează GOMEMLIMIT și exec daemon start-swypikd:1-7 | nu | inittab/rcS | 7 + launchers |

## 2.6 ui/* — inclusiv assets subdirectory

| Director | Clasă | Dovezi | Teste | Importeri | LOC ~ |
|---|---|---|---|---|---:|
| ui/desktop | **real** | tabs/deps/controller controller.go:27-41,119-133 | da | ui/engine, cmd/swypik-os | 1228 |
| ui/engine | **real** | raw Win32/GDI runtime native_runtime_windows.go:11-72 | da, 2 | cmd/swypik-os | 3002 |
| ui/engine/fonts | **real support asset** | embedded by go:embed fonts/*.ttf fonts_windows.go:10-15; process-private loading :22-41 | indirect | ui/engine | assets, N/A LOC |
| ui/theme | **real** | design tokens palette.go:1-15; utilizate de native window | nu | ui/engine | 65 |
| ui/views | **dead — ZERO-CRYPTO UI residue** | registry legacy cu Wallet & Swarm / SWP Coins apps.go:34-63; niciun importer | nu | niciunul | 207 |

### Import graph verificat

Windows cmd/swypik-os, rezultat efectiv go list -deps filtrat:
- swypik-os/config
- swypik-os/core/network
- swypik-os/internal/safepath
- swypik-os/core/agent
- swypik-os/core/coder
- swypik-os/core/compute
- swypik-os/core/ilaria
- swypik-os/core/search
- swypik-os/core/service
- swypik-os/ui/desktop
- swypik-os/ui/theme
- swypik-os/ui/engine
- swypik-os/cmd/swypik-os

Linux cmd/swypikd + cmd/swypik-session:
- core/network, internal/safepath, core/agent, core/ilaria, core/search, core/service, core/session și cele două cmd targets.

---

# 3. Baseline build/test

Comenzile au fost **rulate efectiv** în E:/nexus/swypik-os, fără modificări.

> Notă de fidelitate: cerința menționează resourceClass="heavy", însă acțiunea run_command expusă de connector în această sesiune nu are câmp resourceClass. Comenzile au fost rulate prin run_command cu timeout suficient; alocarea „heavy” este **UNVERIFIED**, nu inventată.

## 3.1 go vet

Command:
~~~text
go vet ./...
~~~

Rezultat exact:
- **exit code: 0**
- stdout: gol
- stderr: gol
- timedOut: false

## 3.2 go test

Command:
~~~text
go test -count=1 -timeout 180s ./...
~~~

Rezultat exact:
- **exit code: 0**
- timedOut: false
- **pachete care pică: niciunul**
- **primele linii de eroare: N/A — stderr gol, niciun test failed**

Stdout:
~~~text
ok  	swypik-os/cmd/swypik-os	2.229s
ok  	swypik-os/config	0.646s
ok  	swypik-os/core/actiongraph	0.543s
ok  	swypik-os/core/agent	1.081s
ok  	swypik-os/core/appstore	0.449s
ok  	swypik-os/core/audio	0.500s
ok  	swypik-os/core/autogenesis	10.187s
ok  	swypik-os/core/azure	0.516s
ok  	swypik-os/core/bci	0.502s
ok  	swypik-os/core/boot	0.420s
ok  	swypik-os/core/bridge	0.880s
ok  	swypik-os/core/cbf	0.678s
ok  	swypik-os/core/chameleon	0.694s
ok  	swypik-os/core/coder	4.876s
ok  	swypik-os/core/compute	1.051s
ok  	swypik-os/core/cyber	0.728s
ok  	swypik-os/core/docs	0.665s
ok  	swypik-os/core/evidence	0.698s
ok  	swypik-os/core/evolution	1.540s
ok  	swypik-os/core/federated	1.767s
ok  	swypik-os/core/hal	2.561s
ok  	swypik-os/core/hive	0.635s
ok  	swypik-os/core/ilaria	1.642s
ok  	swypik-os/core/l402	0.615s
ok  	swypik-os/core/network	0.532s
ok  	swypik-os/core/neuromorphic	0.600s
ok  	swypik-os/core/notifications	0.589s
ok  	swypik-os/core/proactive	0.615s
ok  	swypik-os/core/search	1.695s
ok  	swypik-os/core/security	0.637s
ok  	swypik-os/core/service	1.354s
ok  	swypik-os/core/sheets	0.548s
ok  	swypik-os/core/swarm	0.947s
ok  	swypik-os/core/wallet	0.679s
ok  	swypik-os/core/worldmodel	0.632s
ok  	swypik-os/installer/universal	1.225s
ok  	swypik-os/installer/windows	0.630s
ok  	swypik-os/internal/safepath	0.757s
ok  	swypik-os/internal/storage	0.586s
ok  	swypik-os/mobile/bridge	0.952s
ok  	swypik-os/ui/desktop	1.208s
ok  	swypik-os/ui/engine	0.673s
?   	swypik-os/ui/theme	[no test files]
?   	swypik-os/ui/views	[no test files]
~~~

Interpretare: baseline-ul este verde, dar faptul că prototipurile legacy au teste verzi nu le transformă în capabilități reale; mai multe teste verifică explicit simulări.

---

# 4. Gap analysis — Mission Stream A și Stream E

Estimările sunt **engineering effort brut** pentru implementare + teste/hardening, în person-weeks, și se suprapun între capabilități; nu sunt calendar commitment.

## 4.1 Stream A — SwypikOS autonomous kernel

| Capabilitate mission | Stare actuală | Dovadă current-state | Efort |
|---|---|---|---:|
| Durable task graph / DAG | **parțial** | core/actiongraph are graph + checkpoints doar în memorie (graph.go:74,276-291), fără importer; agentul real este un singur run linear | 3–5 pw |
| Leases și isolation domains | **lipsește** | niciun lease manager/runtime isolation în import graph; approvals ≠ lease | 3–5 pw |
| Capability-based permissions | **parțial** | tool registry + one-shot approval runtime.go:557-574; nu există capability broker/scoped unforgeable token pentru executor | 4–7 pw |
| Event-sourced task history | **parțial** | Run.Events există runtime.go:84-105, dar checkpoint-ul este rescris current-run.json, nu append-only event store | 2–4 pw |
| Resumable/recoverable workflows | **parțial puternic** | recovery checkpoint, interrupted/uncertain semantics runtime.go:99-104,443-460; acoperă un run, nu DAG multi-task | 2–4 pw |
| Multi-agent planning + independent verification | **lipsește** | un singur Manager/Planner; „verifier” apare doar în testul prototype actiongraph, nu ca security role | 3–6 pw |
| Provider/model routing cost/latency/quality | **lipsește** | backend Ilaria unic per endpoint; niciun router/scorer multi-provider | 2–4 pw |
| Local + cloud compute scheduler | **lipsește** | compute doar detectează GPU; protocol coordinator neimplementat compute.go:32-35,95-99; azure/swarm sunt legacy prototype | 5–9 pw |
| Semantic code intelligence | **lipsește** | tool-urile reale sunt list/read/write/edit/process/search; niciun LSP/AST semantic adapter în runtime | 2–4 pw |
| Browser/native UI/device orchestration | **parțial** | native UI este real; browser orchestration și device actuation reală lipsesc; cyber/hive/autogenesis declară simulare/no transport | 5–10 pw |
| Self-evaluation/self-improvement gates | **lipsește în runtime** | core/evolution benchmarkează mutanți numeric dar este neimportat și fără gates/signed promotion | 4–7 pw |
| Deterministic replay where possible | **lipsește** | recovery evită explicit replay când side-effect-ul este uncertain runtime.go:99-101; nu există replay engine | 3–5 pw |
| Offline/local-first degradation | **parțial** | files/search/native UI funcționează local; agent/chat depind de un endpoint Ilaria disponibil, fără model local bundled de SwypikOS | 3–7 pw |
| Resource budgets CPU/RAM/GPU/IO/network per task | **parțial** | MaxSteps/Duration/ToolTimeout/MaxOutput runtime.go:108-113; GOMEMLIMIT Linux; nu există CPU/RAM/GPU/IO/network hard limits per task | 4–7 pw |
| Extensible plugin/driver model | **parțial-prototype** | tool set static; HAL/autogenesis există dar sunt legacy/candidate-only și nelegate de kernel | 4–8 pw |
| Real security boundaries | **lipsește** | process.run cu user permissions; Job Object lifecycle only; path checks nu sandbox | 6–12 pw |

## 4.2 Stream E — security architecture

| Cerință mission | Stare | Dovadă / gap | Efort |
|---|---|---|---:|
| Least privilege by default | **parțial** | Linux daemon refuză root și socket 0600; Windows executor rulează însă cu drepturile complete ale userului | 3–6 pw |
| Capability-based permissions | **parțial** | approval per tool + registered tool set; nu există capability token broker legat de OS resource handles | 4–7 pw |
| Scoped filesystem/process/network | **parțial** | safepath/root pentru file tools; process.run are doar cwd, nu confinement; network per-task necontrolat | 5–9 pw |
| Immutable audit log | **lipsește** | current-run.json este replace atomic, mutabil; events sunt în același checkpoint | 2–4 pw |
| Secrets never enter prompts/logs | **parțial** | .env/hidden paths respinse de file tool workspace_tools.go:34-45; token Ilaria nu este logat; dar process.run poate produce secrete în output, care devine Observation și poate reintra în planner prompt | 3–5 pw |
| Verifier separate from executor | **lipsește** | nu există rol/proces independent de verificare | 3–5 pw |
| Signed/versioned artifacts | **lipsește** | există hash-uri pentru conflicte/file integrity, dar niciun artifact signing/trust root în runtime M0 | 3–6 pw |
| Rollback / canary / safe self-update | **lipsește** | niciun updater/promotion pipeline M0 | 4–7 pw |
| Real process sandboxing | **lipsește** | coder.go declară Job Object = lifecycle, not sandbox; user permissions | 6–12 pw |
| Threat model + red-team tests | **parțial** | există hardening/recovery/path/prompt-boundary tests, dar nu un threat model complet pentru confused deputy, supply chain, privilege escalation și adversarial plugins | 3–6 pw |

---

# 5. Riscuri de securitate observate

## 5.1 P0 — executorul agentului nu are sandbox real

**Fapt:** process.run rulează o linie arbitrară în workspace cu drepturile utilizatorului. Workspace-ul este working directory, nu security boundary. Dovadă: core/agent/workspace_tools.go:334-369; core/coder/coder.go:1-5.

**Impact:** după aprobarea utilizatorului, comanda poate citi/scrie în afara workspace-ului, accesa rețeaua, registry/user profile și orice altă resursă permisă userului. Job Object oprește arborele de procese la cancel, dar nu reduce authority.

**M1 requirement:** executor separat cu token/capabilities și OS sandbox; Windows AppContainer/restricted token/ACL broker + Job Object limits; Linux namespaces + seccomp + cgroups + mount/network namespaces.

## 5.2 P0 — path safety este hardening, nu capability boundary

validRelativePath blochează absolute/traversal/hidden paths (workspace_tools.go:34-45), iar safepath face canonicalization. Acestea reduc accidental escape, dar nu pot opri un proces aprobat și nu sunt echivalentul unui handle-relative capability filesystem. Comentariile proiectului recunosc această limitare.

Rămâne și clasa TOCTOU/reparse-point race pentru operații path-based; M1 trebuie să folosească handle-relative operations / brokered file descriptors/handles.

## 5.3 P0 — nu există verifier independent

Planner-ul care alege acțiunea este aceeași cale logică ce consumă rezultatul. Approval-ul uman protejează side effects, dar nu este verifier automat independent. Mission cere explicit verifier separat de executor.

## 5.4 P0 — audit trail nu este imuabil

Events sunt adăugate în Run (runtime.go:84-105,443-445), dar Save rescrie current-run.json (store_windows.go:126-165). Nu există:
- append-only event log;
- hash chain / signing;
- durable history pentru mai multe run-uri;
- actor/capability/evidence provenance independent de mutable checkpoint.

## 5.5 P1 — secret handling nu este end-to-end enforced

Puncte bune:
- file tools resping componente hidden, deci .env este inaccesibil direct prin workspace.read (workspace_tools.go:34-45);
- bearer token este trimis doar HTTPS, nu loopback HTTP (backend.go:46-51,98-101);
- desktop loghează doar faptul că token-ul este configurat, nu valoarea.

Gap:
- ResolveToken citește token plain din env sau file și nu verifică explicit ACL/mode în funcția sa (config/settings.go:108-131);
- checkpoint-ul agentului poate conține plaintext observations;
- process.run aprobat poate afișa env/secrete, iar output-ul este stocat ca Observation (runtime.go:603-619) și poate intra în promptul următor.
Mission „tokens/keys never enter prompts or logs” nu este garantată sistemic.

## 5.6 P1 — checkpoint integrity ≠ immutable provenance

Windows store are exclusive LockFileEx și atomic write-through replace (store_windows.go:38-62,109-165), ceea ce este bun pentru crash consistency. Totuși, fișierul nu este semnat/chain-uit și authority-ul userului îl poate modifica offline; la corupție se face quarantine, nu trust verification.

## 5.7 P1 — Linux isolation este doar începutul

Rootfs pornește swypikd și session ca user swypik și folosește socket/runtime dirs private, ceea ce este superior unui daemon root. Totuși rcS însuși declară că production cere seat management, authentication, device permissions și compositor complet (system/rootfs/etc/init.d/rcS:10-11). Nu există namespaces/seccomp/cgroups per task.

## 5.8 ZERO-CRYPTO — incompatibilitate de business

Trebuie tratate ca **interzise pentru produsul Swypik**:

1. **core/l402** — Lightning Network, sats, HTTP 402 financial settlement: l402.go:14-18,40,64-65.
2. **core/wallet** — SWP wallet/transfers și proof-of-work rewards: wallet.go:19-36,159-184.
3. **core/federated** — Proof-of-Compute + SWP coin incentive: federated.go:89-103,141-162,281-285.
4. **core/swarm** — CoinsEarned/rewardPerTflop + background SHA-256 hash loop: swarm.go:29-57,139-187.
5. **core/azure** — WalletDocument/SWPBalance/RewardSWP și crediting: azure/schema.go:43-61; azure/coordinator.go:94-119.
6. **core/appstore** — catalog legacy promovează monetizarea CPU/GPU în SWP coin rewards: appstore.go:73-82.
7. **ui/views** — registry legacy expune „Wallet & Swarm” / „SWP Coins”: ui/views/apps.go:57-63.
8. **config** — încă are RewardPerTflop / SWYPIK_SWARM_REWARD_PER_TFLOP: config/config.go:34-35,82-83.

Important: **capability tokens** cerute de Stream E sunt primitive de securitate și nu sunt crypto-currency; acestea trebuie implementate, nu eliminate.

---

# 6. M1 „Autonomous Kernel” — P0/P1/P2 și ADR candidates

## 6.1 P0 — înainte de a numi sistemul Autonomous Kernel

1. **Durable orchestration core:** Task/DAG/Node state machine persistent, cu task IDs stabile, dependencies, retries, deadlines și explicit terminal states.
2. **Append-only event/evidence store:** history multi-run, actor/tool/capability/evidence provenance, hash-chain/checkpoint snapshots; current-run.json rămâne cel mult cache/snapshot.
3. **Lease manager + idempotency:** lease owner/expiry/renewal, fencing token, side-effect intent/commit records; reconciliere după crash fără replay orb.
4. **Capability broker:** fiecare task primește capabilități explicite filesystem/process/network/device; approvals mint/extend capability, nu pornesc direct cod cu authority completă.
5. **Real sandbox workers:** separarea orchestratorului de executori; Windows restricted/AppContainer worker + Job/limits; Linux namespace/seccomp/cgroup worker.
6. **Independent verifier:** proces/rol distinct de planner/executor, cu evidence contract și drept de reject înainte de commit/promotion.
7. **Resource governance:** CPU/RAM/GPU/IO/network budgets per task + hard cancellation/accounting.
8. **Crash/fault suite:** kill-at-every-state, disk-full, corrupted checkpoint, lease expiry, duplicate completion, timeout, network loss, verifier failure.
9. **Zero-crypto purge/isolation:** core/l402, wallet, SWP rewards/mining/hash-work paths și UI/config residues trebuie scoase din product graph și din viitoarea plugin surface.
10. **Security threat model M1:** prompt injection, confused deputy, race/TOCTOU, capability theft, supply chain, malicious plugin/tool, privilege escalation.

## 6.2 P1 — extensibilitate și intelligence

1. Provider/model router sub contractul Ilaria: latency/cost/quality/availability policy, fără a expune raw providers direct executorului.
2. Semantic code intelligence adapter: LSP/symbol/reference/diagnostics ca read capabilities separate de process.run.
3. Browser/native UI/device action adapters ca plugins brokered, cu capability manifests și verifier/evidence.
4. Signed/versioned artifact registry + trust roots + SBOM/provenance.
5. Secret broker: OS credential store, redaction/taint policy, deny secrets-to-prompt by construction.
6. Offline local Ilaria mode + explicit degraded state when model unavailable.
7. Search/crawl jobs mutate through task graph instead of side channels.
8. Telemetry/metrics pentru Stream D: task latency, retries, tool errors, resource peaks, recovery rate.

## 6.3 P2 — după ce P0/P1 sunt demonstrate

1. Local/cloud compute scheduler real și consent/budget aware.
2. Deterministic replay pentru task-uri pure; simulation replay pentru side-effect plans.
3. Self-improvement/evolution pipeline doar prin benchmark + verifier + signed candidate + canary + rollback.
4. Driver/plugin ecosystem extins cu signed manifests și compatibility matrix.
5. Safe self-update/canary channels cu rollback automat.
6. Linux persistence, seat/session management, compositor și driver matrix extinse dacă „real OS track” rămâne obiectiv strategic.

## 6.4 ADR candidates

### ADR-001 — Durable task/event storage
**Decizie:** ce este source of truth pentru DAG, leases, events și evidence?  
**Opțiuni:** SQLite/WAL cu schema append-only + snapshots; embedded KV (Badger/Pebble/Bolt) + event journal; append-only segment files + index separat.  
**Criterii:** crash consistency, single/multi-process coordination, migrations, queryability, corruption recovery.

### ADR-002 — Capability & sandbox model cross-platform
**Decizie:** cum se transformă o aprobare într-o authority minimă executabilă?  
**Opțiuni:** broker central + ephemeral worker per task; long-lived worker pools per isolation domain; OS-native sandbox abstraction.  
**Windows:** restricted token/AppContainer + Job Objects + brokered file handles/network policy.  
**Linux:** user/mount/pid/net namespaces + seccomp + cgroups + brokered FDs.

### ADR-003 — Lease/idempotency/execution semantics
**Decizie:** ce semantică de delivery promite kernelul?  
**Opțiuni:** at-least-once + idempotency/fencing; at-most-once cu loss on crash; per-tool semantic policies.  
**Recomandare de evaluat:** nu promite „exactly once” pentru side effects externe; folosește intent/commit/reconcile și fencing.

### ADR-004 — Independent verifier architecture
**Decizie:** verifier in-process logic vs process separat vs remote verifier.  
**Opțiuni:** deterministic policy verifier; model verifier separat; combinat deterministic + model, cu policy layer având ultimul cuvânt.  
**Cerință:** verifier nu reutilizează authority-ul executorului.

### ADR-005 — Plugin/tool/driver ABI and trust
**Decizie:** modelul de extensie al kernelului.  
**Opțiuni:** Go static plugins (portabilitate slabă); subprocess RPC/gRPC/JSON-RPC cu manifest; WASI components pentru pluginuri pure.  
**Cerințe:** signed/versioned manifest, declared capabilities, resource budget, compatibility/version negotiation.

### ADR-006 — Secrets, audit și artifact provenance
**Decizie:** trust root și formatul auditului.  
**Opțiuni:** OS credential stores + append-only hash-chain log; TPM/DPAPI/Keychain-backed signing where available; software key fallback explicit degraded.  
**Cerință:** secrets nu sunt serializate în task observations/prompt; artifacts și audit entries au identity/version/hash/signature.

---

## Concluzie M0 „Truth”

Current-state-ul sănătos și demonstrat este: **native Windows desktop + local search + Ilaria HTTP contract + approval-gated linear agent + atomic single-run recovery**, plus un **Linux live-RAM pre-alpha**. Aceasta este o fundație utilă, dar M1 cere o schimbare arhitecturală clară: de la „agent cu tools” la „kernel de task-uri cu durable DAG, leases, capability broker, sandbox executors, independent verifier și immutable evidence”.

README/docs care descriu Electron sau integrări mai vechi sunt istorice și nu reflectă HEAD-ul curent; import graph-ul și codul HEAD au prevalat în acest audit.

**UNVERIFIED:** consumul efectiv al cmd/swypik-os/winres de build tooling nu a fost demonstrat printr-o referință în source scan; resourceClass="heavy" nu este expus de schema run_command disponibilă în această sesiune.
