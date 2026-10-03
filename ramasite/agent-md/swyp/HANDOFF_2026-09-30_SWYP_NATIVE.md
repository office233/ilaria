# HANDOFF — SWYP LANG / DIRECT NATIVE BACKEND
Original snapshot: 2026-09-30 00:47+03:00
Updated: 2026-09-30 current work session

Workspace: E:\nexus\swyp

============================================================
0. UPDATE AUTORITATIV — STAREA CURENTA
============================================================
- 2026-10-02 (Copilot, branch `copilot/swyp-runtime-20261002`): paritate runtime nativa reala pe toate tintele executabile disponibile. `cmd/swyp/native_runtime_parity_test.go` ruleaza acelasi corpus (Core argv/IO/fs/net/clock/rng, 38 programe HIR storage/vec/struct/slice/ref, cazuri diferentiale fata de interpretorul Core pentru aritmetica verificata/bucle/spill-uri/apeluri) pe Windows x64 PE, Linux x64 ELF static + PIE si Linux AArch64 ELF static + PIE prin `qemu-aarch64` (`SWYP_QEMU_AARCH64`; CI instaleaza `qemu-user` pe Ubuntu). Rezultat: Windows verde, Linux 475/475 subteste verzi (x64 + AArch64 qemu).
- Bug-uri reale gasite si reparate de corpus (fiecare cu test de regresie red->green cu plan de registre fortat): (1) x64 SSE two-address miscompile cand registrul destinatie era alias cu operandul drept (`a-b`->0, `a/b`->1, `a+b`->2a, `a*b`->a^2) in backend-ul masina CFG si in backend-ul text; (2) `div`/`rem` intreg lipseau complet din backend-urile masina x64/ARM64 — acum verificate (impartire la zero si `MIN/-1` -> status 1, `MIN%-1` -> 0); (3) functiile AArch64 non-leaf nu salvau niciodata `x30`, deci orice functie care apela un helper runtime sau alta functie crapa la `ret` (print, clock, rng, fs, net, storage/vec, apeluri native) — acum slot `x30` in frame + reload inainte de fiecare `ret`; (4) parserul IPv4 AArch64 (net.connect/net.fetch) avea `CBZ` in loc de `CBNZ` dupa al patrulea octet: respingea orice IPv4 valid si accepta gunoi dupa adresa; (5) verificarea overflow la `mul` i64 AArch64 putea citi un operand suprascris (SMULH mutat inaintea MUL).
- Limita onesta: dovada AArch64 este qemu-user, nu hardware fizic; ASLR real pe kernel Linux ARM64 si performanta ARM64 raman de masurat pe hardware.
- Snapshot-ul de mai jos ramane util ca istoric, dar P0/P1 au avansat.
- Gate-ul complet rerulat inainte de noul patch ARM64 a trecut: `go vet ./...`, `go test -count=1 ./...`, `git diff --check -- .` -> exit 0.
- Windows x64 `net.connect` loopback/refused/invalid-endpoint tests au fost rerulate targeted si au trecut; helper-ele Linux x64 au fost recitite pentru close/failure paths, IPv4 literal-only si lipsa DNS implicit.
- Linux AArch64 `net.connect` exista deja in starea curenta: syscalls 198/203/57, capability gate si teste structurale.
- Linux AArch64 `fs.read` parity a fost implementat in sesiunea curenta: lowering `fs.read`, helper `openat(56)/lseek(62)/read(63)/close(57)`, arena mutabila monotona si `bytes.get` capabil sa rezolve descriptorii runtime doar in prefixul committed.
- `arm64MachineHasProcessIO` recunoaste acum explicit si `rng.sample`/`bytes.get`/`fs.read`, eliminand un gap pentru functii standalone care contin doar aceste operatii.
- Testele targeted noi pentru capability gate, syscalls, segmentul `.data` RW/non-X si standalone `bytes.get` au trecut; `go test -count=1 ./internal/coreir ./cmd/swyp` a trecut.
- Runtime AArch64 real nu este disponibil pe aceasta statie; nu declara `fs.read` runtime-validat ARM64 fara QEMU/hardware.
- Full gate post-change este inchis: `gofmt -d` pe fisierele Go atinse, `go vet ./...`, `go test -count=1 ./...` (8/8 pachete) si `git diff --check -- .` au iesit cu cod 0; singurele mesaje sunt warnings LF->CRLF ale worktree-ului existent.
- Cross-build post-change inchis: `CGO_ENABLED=0` pentru linux/amd64, darwin/amd64 si linux/arm64, toate cu exit 0. Artefactele temporare au fost sterse dupa verificare.
- Swyp 1.0 M0 este acum inchis in worktree: diagnostic schema v1 pentru parser/checker, coduri stabile publicate in `language-manifest`, propagare in JSON-ul model-facing, versiune/prompt/backend config deja unificate.
- M1 a avansat end-to-end fara big-bang: `internal/sourcefront` detine preambulul comun `module`/`use`; `swyp module-graph -root DIR` rezolva determinist dependente locale si hash-uieste sursele; `internal/hir` + `swyp hir` emit body HIR tipizat; `swyp hir-link` rezolva apeluri explicite `lib.math.square(x)` la `lib.math::fn::square`, cere direct `use` si verifica semnaturile; `internal/hircore` + `swyp hir-core` traduc bundle-ul linked in Core IR standard; `hir-x64-pack`/`hir-arm64-pack` si `hir-x64-exe`/`hir-arm64-exe` reutilizeaza optimizer/SSA/regalloc/machine backends existente. Effects/capabilities se propaga prin importuri; packed ramane pure-only, standalone cere aceleasi grant-uri sensibile ca single-file Core, iar `process.exec` ramane fail-closed dupa grant.
- M1 richer values: HIR are acum `new Struct {...}` + field projection, enum `Type::Variant(payload)` + `match` exhaustiv, si constructori contextuali `some/none/ok/err` pentru option/result. Linked HIR reverifica schema, payload-urile si exhaustivitatea; Core/native pentru aceste valori ramane fail-closed.
- M1 arrays/slices: literal fix contextual `array<T,N>`, indexing array/slice cu index exact `u64` si view `[start:end)` tipizat `slice<T>` sunt in HIR. Runtime bounds/descriptor ownership si lowering Core/native raman fail-closed.
- Layout/storage: `swyp-fixed-v1` si `swyp-descriptor-v1` raman contractele HIR. Backing store-ul generic din `internal/storageabi` este folosit de Run/RunFast/RunTurbo, iar standalone x64/ARM64 au acum runtime storage bounded propriu peste sectiunea RW process-data: IDs monotone/opace, descriptor validation, load/store/free checked si regiune storage separata de arena fs/net. x64 Windows este runtime-testat cu `array<u64,65>`; ARM64 produce ELF structural valid si cross-build-urile sunt verzi. Packed modules raman stateless si resping `storage.*`; Core `bytes` ABI ramane separat.
- Vec owner/view promotion: `vec<u64>` si `vec<i64>` aloca storage owned; signed i64 este bitcast raw exact la boundary. Index/slice/ref/mutref/store/push sunt checked si folosesc acelasi storage ABI fara raw pointers. `vec_push` suporta reuse/growth x2 peste CFG, iar descriptor state supravietuieste joins/backedges. Windows x64 runtime este verde inclusiv pe negative i64 + mutref/store + ABI de functie; ARM64 este structural/cross-build green. Vec return si layouts beyond raw64 raman fail-closed.
- Large signed arrays: `array<i64,N>` peste pragul de scalarizare foloseste storage raw64, inclusiv `slice<i64>` si descriptor refs. Windows x64 runtime si ARM64 structural sunt verzi pe array de 65 elemente cu valori negative si store prin mutref.
- Bounds evidence: `internal/hir/bounds.go` + `swyp hir-bounds` clasifica fiecare index/range ca `proven` sau `runtime_required`; constant OOB/reversed ranges pe arrays fixe sunt respinse. Evidenta este determinista si nu elimina singura check-uri.
- First richer-value native promotion: `internal/hircore` scalarizeaza acum local fixed arrays `array<T,N>` atunci cand `T` este deja Core-scalar, initializer-ul este literal array si indexul este `u64` compile-time in-range. Fiecare element devine slot Core normal; interpreter, x64 si ARM64 existente sunt reutilizate fara descriptor/raw pointer nou. Dynamic index, slices, array params/results si whole-array assignment raman fail-closed pentru viitorul descriptor/storage lowering.
- Dynamic fixed-array bounds promotion: pentru arrays scalarizate de max 64 elemente, index `u64` runtime genereaza CFG explicit `eq/branch` si OOB `unreachable`; Core executor fail-uieste controlat, iar machine backends x64/ARM64 mapeaza `unreachable` la bounds status ABI `3` (nu illegal instruction). Windows x64 runtime + packed x64/ARM64 sunt targeted-green. Slices/descriptor-backed dynamic storage raman urmatorul pas.
- Fixed slice promotion: `let s = xs[a:b]` peste un fixed array scalarizat este coborat acum ca view peste subsetul de sloturi cand `a`/`b` sunt constante `u64` valide. `s[i]` constant sau dinamic reutilizeaza acelasi bounds CFG/OOB sink ca array indexing; `hir-core` si Windows x64 runtime sunt targeted-green. Dynamic range construction, slice params/results si storage descriptor-backed raman fail-closed.
- Dynamic fixed-slice range: pentru un fixed array scalarizat, `xs[start:end]` accepta acum bounds runtime `u64`; lowerer-ul verifica `start <= end <= N`, iar `s[i]` verifica `i < end-start` inainte de `start+i`. Core executor si Windows x64 runtime sunt targeted-green; slice params/results si descriptor-backed storage raman urmatorul pas.
- Fixed structs promotion: local `new Struct {...}` cu toate campurile Core-scalar este descompus in sloturi Core per camp, iar `value.field` selecteaza slotul corespunzator. Core executor + Windows x64 runtime si packed x64/ARM64 au teste targeted verzi. Struct params/results, nested aggregate fields, move/dynamic fields si whole-struct assignment raman fail-closed.
- Known sums promotion: local `option/result/enum` construit direct intr-o varianta cunoscuta, cu payload Core-scalar, poate fi `match`-uit fara tagged runtime ABI; lowerer-ul pastreaza payload-ul in slot Core si selecteaza static arm-ul potrivit. Core executor + Windows x64 runtime si packed x64/ARM64 au teste targeted verzi. Sum params/results/call-results/reassignment si variante runtime raman fail-closed.
- Local ref promotion: `hircore.Lower` ruleaza mai intai ownership gate-ul; places statice Core-scalar devin alias compile-time la slot Core, iar `vec<u64>[i]` storage-backed (constant sau dinamic) devine ref descriptor `(storage_id,index)` dupa bounds guard. `*r`/`store` folosesc load/store checked; `drop(r)` nu expune pointer. Ref ABI cross-function si richer/non-u64 storage refs raman fail-closed.
- Vec function ABI: raw64 vec params sunt flatten-uiti explicit in trei argumente Core `u64` (`storage_id,length,capacity`) si reconstructuiti local. Vec return foloseste acum un singur handle Core `u64` catre un block descriptor storage de 3 words; caller-ul incarca `(id,len,cap)`, elibereaza descriptor block-ul si preia ownership-ul payload-ului. Nu exista hidden out-pointer. Local si cross-module return sunt runtime-green pe Windows x64; ARM64 este structural/cross-build green.
- Deterministic cleanup v1: `defer_drop(v)` programeaza un owner vec local storage-backed pentru `storage.free` LIFO la scope exit sau inainte de `return`. Dupa scheduling, assignment/move/manual drop/duplicate defer sunt respinse de ownership checker; inspect/mutation raman permise pana la cleanup. Nu exista GC sau host finalizer implicit. Regression-ul x64 descoperit de acest test (dead phi copy clobbering live phi register) a fost reparat simetric in emitters x64/ARM64 prin skip pentru phi destinations fara uses.
- Richer vec storage: `vec<Struct>` este promovat cand struct/record-ul este plat si toate campurile sunt raw64 (`u64/i64/ieee64`). Descriptorul ramane `(storage_id,length,capacity)` in elemente; allocation/copy folosesc stride in words. `v[i].field`, whole-element Copy, `&v[i].field`/`&mut v[i].field`, `vec_push`, param/return ABI si nominalele cross-module sunt runtime-green pe Windows x64; ARM64 este structural green. `slice<Struct>` read-only pastreaza start/end in element units si suporta field access, Copy si shared refs cu bounds inainte de stride. Mutable slice refs si nested/non-raw64 fields raman fail-closed.
- Nested storage update: by-value struct/record nesting este flatten-uit recursiv daca toate leaf-urile sunt raw64. Constructor/push si leaf paths (`v[i].inner.value`, `&mut v[i].inner.value`, `s[i].inner.value`, shared slice refs) sunt runtime-green pe Windows x64 si structural-green ARM64. Whole nested aggregate Copy ramane fail-closed; recursive/non-raw64 leaves sunt respinse.
- Cleanup parameter update: `defer_drop(v)` poate programa un vec parameter move-owned din top-level function body. Cleanup-ul ramane LIFO la return/scope exit; scheduling din block nested este respins pentru a evita branch-dependent destruction in v1.
- Native param materialization fix: x64/ARM64 emitters nu mai copiaza parametri SSA complet morti in registre reutilizate. Regression-ul a fost gasit de vec ABI: un `capacity` mort putea clobbera `storage_id` live la intrarea in callee. x64 runtime regression este verde; ARM64 pastreaza pozitia AAPCS a argumentelor chiar cand un parametru mort nu este materializat.
- Ownership v1: `internal/hir/ownership.go` + `swyp hir-ownership` clasifica recursiv Copy/Move/Borrowed si detecteaza use-after-move, implicit drop, borrowed escape, conditional/match move imbalance si ownership-changing loops. `drop(x)` este consum explicit HIR-only. `vec/string/opaque` sunt move-only, `slice<T>` este borrow-view. Lexical `&`/`&mut`, lifetimes, partial moves si destructori reali raman deschise; ownership checker-ul este momentan promotion gate explicit, nu implicit in vechile comenzi Core.
- Borrow v1: `let r=&x` / `let r=&mut x` produc `ref<T>`/`mutref<T>` si checker-ul urmareste shared/exclusive loans pana la scope exit sau `drop(r)`. `*r` si `store(r,value)` sunt permise numai pentru Copy referents in v1; mutation/move/direct-use conflictual si copierea mutref sunt respinse. `fn ... -> ref<T> borrows x` introduce contract explicit `borrow_from`; provenance este verificat local si cross-module prin FunctionTable, inclusiv reborrow/call-result, iar mismatch/missing contract este fail-closed. `&x.field`, `&mut x.field` si `&x[i]` suporta proiectii non-Copy; field paths statice si indici constanti distincti folosesc analiza disjuncta (`x.a` vs `x.b`, `x[0]` vs `x[1]`), iar indicii dinamici raman conservatori pe container. Dynamic range alias analysis si destructori reali raman deschise.

IMPORTANT — DIRTY REPO / CONCURRENCY
Nexus este foarte dirty si exista lucru concurent in ilaria, swypik-os si swyp.
NU folosi git reset --hard, git clean, mass revert, global stash sau overwrite orb.
In aceasta sesiune au existat modificari concurente chiar in aceleasi fisiere Swyp. Reciteste starea curenta inainte de orice patch.

============================================================
1. DIRECTIA PROIECTULUI
============================================================
Swyp Lang este dus spre Semantic Core + limbaj propriu care poate emite direct cod nativ si executabile standalone fara dependenta obligatorie de CRT, assembler sau linker extern.
Directia: Core IR tipizat; effects/capabilities; x86-64; AArch64; packed modules; COFF/ELF/Mach-O; PE DLL/EXE; ELF static/PIE; process runtime; apoi integrare Ilaria + SwypikOS.

============================================================
2. MILESTONE-URI DEJA INCHISE
============================================================
x86-64 direct backend: SSA, CFG, phi, register allocation, GPR/FP spills, ieee64, mixed GPR/FP calls, packed machine code, rel32 relocation.
SysV adapter a fost executat runtime prin GCC sysv_abi pentru mixed bool/ieee64 si 4 GPR + status pointer.

Direct objects exista pentru Windows AMD64 COFF, ELF64/x86-64, Darwin x86-64 Mach-O, ELF64/AArch64, Windows ARM64 COFF si Darwin ARM64 Mach-O.

PE DLL direct: exports Swyp, LoadLibrary/GetProcAddress runtime, mixed FP, .reloc real, DYNAMIC_BASE, HIGH_ENTROPY_VA, NX_COMPAT, dual-copy relocation test.

Standalone PE x86-64: .text/.idata/.reloc, ASLR/NX, ExitProcess, GetCommandLineA cand este nevoie, fara CRT pentru argv.
Standalone ELF x86-64: static ET_EXEC, fara libc/PT_INTERP/dynamic loader/imports, Linux syscalls directe.
Standalone ELF ARM64: static ELF64/AArch64, fara libc, exit(93), AAPCS64 direct.

============================================================
3. TYPED ARGV — INCHIS
============================================================
x86-64 direct executables accepta pana la 4 i64/u64/bool/ieee64.
Parser machine-code validat runtime Windows: INT64_MIN, UINT64_MAX, signed, overflow rejection, bool 0/1/true/false, argc exact, missing/extra/malformed -> exit 2, quoted executable path.
ieee64 parser CRT-free/SSE2: sign, integer, fraction, .5, 1., e/E exponent, IEEE overflow/underflow.

ARM64 typed argv direct din Linux process-entry stack.
AAPCS64: max 7 GPR program args (x7 rezervat status pointer) + max 8 ieee64 FP args; mixed 7 GPR + 8 FP.
Parser ARM64: i64/u64/bool/ieee64, SCVTF/FADD/FMUL/FDIV, sign/fraction/e/E.
ARM64 runtime real NU este inca validat pe aceasta statie; structural tests + linux/arm64 cross-build.

============================================================
4. PIE / ASLR ELF — DEJA IMPLEMENTAT CONCURENT
============================================================
Exista EncodeX64ELFPIEExecutable si EncodeARM64ELFPIEExecutable.
CLI -pie pentru ELF.
ET_DYN zero-based, PC-relative control flow, process runtime rodata/data fixups compatibile cu PIE.
Runtime ASLR Linux real ramane de verificat pe Linux/QEMU/hardware.

============================================================
5. PROCESS RUNTIME NATIV
============================================================
stdout/stderr: print/eprint -> io.stdout/io.stderr; capabilities stdout_write/stderr_write.
Windows: GetStdHandle + WriteFile. Linux x64/AArch64: write syscalls.
Formatter: i64/u64/bool/ieee64; ieee64 canonical hex-float CRT-free.

clock(): effect clock.read, capability clock_read. Windows GetTickCount64; Linux x64 clock_gettime 228; ARM64 syscall 113.
random(): effect rng.sample, capability rng_sample. Windows BCryptGenRandom; Linux x64 getrandom 318; ARM64 278.

============================================================
6. BYTES + FILESYSTEM
============================================================
ByteSpan ABI = offset:u32 + length:u32.
Module immutable arena: PE .rdata / ELF .rodata PF_R.
Runtime mutable arena separata, monotonic allocation, bounds checked.
bytes.len direct x64 + ARM64.
bytes.get direct x64 + ARM64 cu descriptor/span/index validation. Windows runtime: bytes_get("abc",0) -> 97.

write_file(path,data): fs.write(bytes,bytes), capability workspace_write, CLI -allow-fs-write.
Windows runtime creeaza/verifica fisier real. Linux x64 openat/write/close. ARM64 syscalls 56/64/57.

IMPORTANT: fs.read ESTE DEJA IMPLEMENTAT, desi ROADMAP/PERFORMANCE au ramas stale in unele pasaje.
read_file(path): fs.read(bytes)->bytes, capability workspace_read, CLI -allow-fs-read.
Windows runtime tests: file real, bytes_get+bytes_len, multiple reads cu arena monotonic, oversized input fail-closed.
Linux x64 helper: openat/lseek/read/close + mutable runtime arena.
TODO docs: elimina afirmatiile vechi ca fs.read este pending.

============================================================
7. NETWORK — STAREA EXACTA LA INCHIDERE
============================================================
Builtin actual: tcp_connect(host:bytes, port:u64)->bool.
Scop: IPv4 literal TCP connect; fara DNS implicit; fara HTTP implicit.
Core IR op: net.connect.
Effect: net.connect.
Capability: network_connect.
Constant: coreir.EffectNetConnect.

x64 CLI grant: -allow-net-connect.
Fara grant build-ul fail-closed si cere network_connect.

x64 machine backend exista acum:
- emitCFGNetConnectInstruction
- runtime helper __swyp_rt_net_connect
- x64ProcessRuntimeHelper il recunoaste.

Linux x64 runtime exista:
- buildX64LinuxNetConnectHelper
- resolver integration
- module byte arena fixup.

Windows x64 runtime exista:
- buildX64WindowsNetConnectHelper
- resolver integration
- PE IAT integration
- runtime tests in cmd/swyp/core_x64_exe_windows_test.go
- teste gasite pentru loopback si invalid host/port.

VERIFICARE PROASPATA INAINTE DE HANDOFF:
gofmt pe fisierele semantic/lowering/CLI net.connect, apoi:
go test -count=1 ./internal/swyplang ./internal/coreir ./cmd/swyp -run Test.*(TCPConnect|NetConnect|net.connect)
Rezultat: PASS pentru internal/swyplang, internal/coreir si cmd/swyp.

Eroarea intermediara de sintaxa observata imediat dupa primul patch net.connect NU mai este starea curenta. Worktree-ul a avansat concurent si targeted gate este verde.

IMPORTANT: FULL SUITE COMPLET NU A FOST RERULAT DUPA ULTIMELE SCHIMBARI NET.CONNECT.
Nu declara milestone-ul net.connect complet pana nu rulezi gate-ul complet.

============================================================
8. GATE-URI VERZI ANTERIOR
============================================================
Inainte de ultimele schimbari net.connect au trecut:
go vet ./...
go test -count=1 ./...
git diff --check
GOOS=linux GOARCH=amd64 go build ./cmd/swyp
GOOS=darwin GOARCH=amd64 go build ./cmd/swyp
GOOS=linux GOARCH=arm64 go build ./cmd/swyp

Aceste rezultate NU sunt dovada pentru modificarile net.connect aparute ulterior.

============================================================
9. PRIMUL LUCRU DE FACUT MAINE — P0
============================================================
1) Reciteste starea curenta, nu presupune ca snapshot-ul este ultimul:
- internal/coreir/x64_process_runtime.go
- internal/coreir/x64_machine_cfg.go
- internal/coreir/effects.go
- internal/coreir/ir.go
- internal/swyplang/core_lower.go
- cmd/swyp/core_x64_exe.go
- testele net.connect.

2) Ruleaza full gate:
go vet ./...
go test -count=1 ./...
git diff --check

3) Cross-build:
GOOS=linux GOARCH=amd64 go build ./cmd/swyp
GOOS=darwin GOARCH=amd64 go build ./cmd/swyp
GOOS=linux GOARCH=arm64 go build ./cmd/swyp

4) Confirma Windows x64 net.connect runtime:
- listener DOAR loopback local
- successful connection -> true
- refused connection -> contractul documentat
- invalid IPv4
- port 0
- port >65535
- Winsock imports corecte
- WSA/socket cleanup pe toate failure paths.

5) Verifica Linux x64 net.connect helper:
- socket syscall
- sockaddr_in byte order
- connect
- close
- descriptor validation
- no leaked fd
- no DNS
- no hidden ambient network.

============================================================
10. DUPA NET.CONNECT
============================================================
P1: ARM64 net.connect pe Linux AArch64: socket/connect/close syscalls, IPv4 parser, acelasi capability model, structural/opcode tests, linux/arm64 cross-build. Nu pretinde runtime ARM64 fara QEMU/hardware.

P2: actualizeaza ROADMAP/PERFORMANCE pentru fs.read, mutable arena, bytes.get si net.connect.

P3: net.fetch — IMPLEMENTAT in starea curenta. `http_fetch(ipv4,port,path)->bytes` foloseste efect separat `net.fetch` + capability `network_fetch` + grant CLI `-allow-net-fetch`. Contractul v1 este plaintext HTTP/1.1, IPv4 literal-only, fara DNS/TLS/redirect-following; path-ul este absolute visible-ASCII si bounded, raspunsul brut este bounded in arena mutabila, cursorul se commit doar la EOF curat, overflow fail-closed, connect/send/recv au timeout fix, iar socket cleanup este explicit. Windows x64 are runtime loopback/policy/oversize tests; Linux x64 si ARM64 au helper-e native directe, ARM64 ramanand fara validare runtime reala pe aceasta statie.

P4: process.exec — SEMANTIC CONTRACT IMPLEMENTAT, RUNTIME INCA FAIL-CLOSED. Exista `EffectProcessExec`, builtin `process_exec(executable:bytes, argc:u64, argv0:bytes, argv1:bytes, argv2:bytes, argv3:bytes)->u64`, capability simbolica `process_exec` si grant CLI `-allow-process-exec`. Nu exista command string/shell implicit. x64/AArch64 recunosc efectul ca process-only dar refuza explicit build-ul dupa grant cu `process.exec runtime is not implemented`; aceasta este intentionat starea sigura pana cand exista allowlist exact de executabile, timeout/termination, cleanup si politica bounded pentru stdout/stderr.

P5: model.infer/tool.call trebuie host-mediated capability calls, NU ambient native authority.

============================================================
11. SECURITY / ARCHITECTURE INVARIANTS
============================================================
- reusable packed/object/DLL artifacts pure-only
- host effects numai in standalone process backend
- fiecare efect are capability simbolica explicita
- grants CLI explicite pentru authority sensibila
- fara authority token in guest Core IR
- fara raw host pointers in guest
- ByteSpan bounds checked
- module arena read-only
- mutable runtime arena separata
- failure propagation prin backend status
- no silent fallback
- no fabricated entropy/time/data
- no hidden DNS/network/filesystem/process access
- net.connect nu devine DNS/HTTP implicit
- socket handles nu devin accidental integer guest
- cleanup pe toate paths
- bounded resources.

============================================================
12. FISIERE IMPORTANTE
============================================================
Core:
internal/coreir/effects.go
internal/coreir/ir.go
internal/coreir/x64_machine.go
internal/coreir/x64_machine_cfg.go
internal/coreir/x64_process_runtime.go
internal/coreir/x64_exe_args.go
internal/coreir/x64_pe_exe.go
internal/coreir/x64_elf_exe.go
internal/coreir/arm64_machine.go
internal/coreir/arm64_machine_cfg.go
internal/coreir/arm64_process_runtime.go
internal/coreir/arm64_exe_args.go
internal/coreir/arm64_elf_exe.go

Language:
internal/swyplang/core_lower.go
internal/swyplang/core_lower_test.go

CLI:
cmd/swyp/core_x64_exe.go
cmd/swyp/core_x64_exe_test.go
cmd/swyp/core_x64_exe_windows_test.go
cmd/swyp/core_arm64_exe.go
cmd/swyp/core_arm64_exe_test.go

Docs:
docs/PERFORMANCE.md
docs/ROADMAP.md

============================================================
13. GIT / SAFETY
============================================================
Nu s-a cerut commit/push.
Nu executa reset/clean/mass revert.
Verifica status/diff numai scoped pe fisierele atinse.
Read-back dupa patch-uri deoarece exista agenti concurenti.
Targeted diagnostics/tests dupa editari; full gate la milestone.

END HANDOFF