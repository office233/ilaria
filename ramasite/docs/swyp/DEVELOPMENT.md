# Dezvoltare locala Swyp pe Windows

Din radacina checkout-ului Nexus, intra in modul cu `Set-Location .\swyp`.
Sursele programelor raman `.swyp`; `.swypb` este modulul compilat,
nu un alt limbaj. Codul Go din proiect implementeaza compilatorul si VM-ul.

## Folosirea utilitarului deja construit

Din PowerShell, in radacina proiectului:

```powershell
.\swyp.cmd version
.\swyp.cmd compile --target stv2 -o .\agent-lab\calcul.swypb .\examples\swyp\sum.stv2.swyp
.\swyp.cmd exec .\agent-lab\calcul.swypb 100
```

Fisierul destinatie trebuie sa fie nou. Daca exista, compilarea refuza sa-l
suprascrie. Rezultatul exemplului este `5050`.
`swyp.cmd` este doar un lansator pentru `bin\swyp.exe`; nu porneste Go.
Se poate apela si direct `.\bin\swyp.exe`.
Executia unui `.swypb` necesita utilitarul Swyp, nu sursa initiala, Go, GCC,
Python sau un serviciu AI. Un modul `.swypb` nu este un executabil nativ autonom.

## Construirea compilatorului dupa modificari

```powershell
.\scripts\build-local.ps1
```

Este necesar Go pentru aceasta operatiune de dezvoltare. Scriptul construieste
mai intai un executabil temporar, verifica pornirea si apoi publica
`bin\swyp.exe`. Executabilul precedent este pastrat sub `agent-lab\build-*`,
impreuna cu un `build.json` care contine hash-ul noului executabil.
Scriptul nu instaleaza unelte, nu schimba PATH-ul permanent si nu face push.
Build-ul si validatorul local folosesc `GOWORK=off`, astfel incat modulul sa
ramana independent de celelalte produse din workspace.

Gate-ul comun pentru Linux si Windows este definit in
[`../../.github/workflows/ci.yml`](../../../.github/workflows/ci.yml). Workflow-ul
STV2 anterior este pastrat numai ca istoric in
[`history/STV2_VALIDATION_WORKFLOW_20260930.yml`](../../agent-md/swyp/history/STV2_VALIDATION_WORKFLOW_20260930.yml).

## Validare reproductibila

```powershell
python .\scripts\validate_local.py --phase all
```

Python este folosit numai pentru orchestrarea testelor si pastrarea dovezilor.
Scriptul foloseste biblioteca standard. Go, GCC si Node sunt necesare pentru
verificarea componentelor de dezvoltare deja prezente in repository.

Fazele includ testele complete cu coverage, `go vet`, detectorul de race
conditions, trei repetitii cu ordinea testelor amestecata, teste de contract,
fuzzing pentru STV1, STV2, assembler, compilator si incarcatorul SWYPB, probe
cap-coada si un benchmark diagnostic. Fuzzing-ul foloseste doi workeri si
15 secunde pe tinta implicit; aceste limite nu reprezinta o dovada formala.

Se poate executa o singura faza sau alege un director comun de rezultate:

```powershell
python .\scripts\validate_local.py --phase smoke
python .\scripts\validate_local.py --phase fuzz-module --fuzz-seconds 30
python .\scripts\validate_local.py --phase tests --output .\agent-lab\validarea-mea
```

Toate rezultatele sunt salvate in subdirectoare noi din `agent-lab`, un director
ignorat de Git. Fiecare faza pastreaza stdout, stderr, exit code, durata si
`result.json`. Un test sarit este raportat separat, nu numarat ca trecut.
Scriptul nu face reset, clean, stash, push sau modificari in sursele existente.

Proba cap-coada construieste utilitarul complet, compileaza o copie generata
a exemplului, sterge numai acea copie si ruleaza modulul in procese noi cu
PATH fara toolchain-uri. Verifica si rezultatele booleene, fisierele corupte,
argumentele gresite, fuel-ul si refuzul suprascrierii. Interpretorul, backendul
nativ prin C/GCC si generarea HTML existente sunt verificate separat.
Generarea HTML nu este echivalenta cu validarea vizuala intr-un browser.

## Teste care cer GCC si paritatea runtime nativa

Fara `gcc` in PATH, aproximativ 37 de teste (backendul C AOT de referinta,
backendul text x64, DLL/COFF, harness-urile FP) sunt sarite tacut. Pe o statie
fara GCC se poate folosi `zig cc` din `E:\nexus\.tools\zig-0.16.0` printr-un
shim numit `gcc` pus primul in PATH (un executabil mic care ruleaza
`zig.exe cc <argumente>`; pe Linux ajunge un script `exec zig cc "$@"`).
Verifica numarul de teste `SKIP` dupa rulare: un skip nu este o validare.

`cmd/swyp/native_runtime_parity_test.go` ruleaza acelasi corpus pe toate
tintele executabile disponibile: Windows x86-64 PE, Linux x86-64 ELF/PIE si
Linux AArch64 ELF/PIE. Pentru AArch64 pe o statie x86-64 se seteaza
`SWYP_QEMU_AARCH64` catre `qemu-aarch64` (user-mode); o valoare setata dar
invalida face testul sa esueze, nu sa sara. Dovada AArch64 prin qemu nu este
validare pe hardware fizic.

```bash
SWYP_QEMU_AARCH64=/usr/bin/qemu-aarch64 go test -count=1 ./cmd/swyp -run '^TestNativeRuntimeParity$'
```

## Istoric si limite STV2

Raportul istoric din 2026-09-28 descrie sincronizarea commit-ului `650d88616da46cbc0f459f7af29991654d00e507`
pe branch-ul `work/local-swyp-validation-20260928`, fara merge in `main` si fara
push. Directorul local necomis `bridge/chatgpt-mcp` nu face parte din aceste
modificari si nu trebuie adaugat automat intr-un commit.

STV2 pastreaza limita actuala de opt registre, o singura functie `main`, pana
la patru argumente si subsetul numeric safe-integer. Memoria temporara,
apelurile de functii, tablourile si componentele UI nu sunt adaugate de aceasta
sincronizare. Vezi `SWYPB_FORMAT.md` pentru formatul modulului.
