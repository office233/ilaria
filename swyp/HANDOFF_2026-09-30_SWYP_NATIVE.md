# HANDOFF — SWYP LANG / DIRECT NATIVE BACKEND
Original snapshot: 2026-09-30 00:47+03:00
Updated: 2026-09-30 current work session

Workspace: E:\nexus\swyp

============================================================
0. UPDATE AUTORITATIV — STAREA CURENTA
============================================================
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