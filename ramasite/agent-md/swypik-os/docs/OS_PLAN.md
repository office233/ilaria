# SwypikOS — plan de execuție

27 septembrie 2026. Înlocuiește planurile istorice din arhiva externă.

## Direcție

Construim strict un **SwypikOS independent**. Linux-ul bootabil din repo este
reference/prototype și NU este automat kernelul final. Kernel/platform substrate
se decide prin ADR-OS-BASE-001, prototip și benchmark.

Ilaria nu este „un simplu model”: este organismul cognitiv al platformei.
BitNet/inference, tokenizerul și checkpointurile sunt componente ale cortexului
lingvistic; memoria, atenția, învățarea, consolidarea, planificarea și tool-use
fac parte din Ilaria ca sistem.

SwypikOS deține desktopul, fișierele, aplicațiile, permisiunile, device authority,
Control Kernel, update/recovery și **Swyp Compute Fabric**.

Îmbunătățirea automată a aplicației înseamnă modificare propusă, diff verificabil, teste, evaluare, versiune și rollback. Nu înseamnă modificarea automată a ponderilor sau publicarea necontrolată a schimbărilor.

## Etape și criterii de acceptare

| Etapă | Livrabil | Închidere |
| --- | --- | --- |
| 0. Curățare | Surse, binare, date și arhivă separate; build unic | Build și pornire verificate; date păstrate |
| 1. Stabilitate desktop | Audit fișiere, shell, browser, chat, settings; erori/anulare explicite | Succes, eroare, timeout și restart testate; fără panic în scenarii |
| 2. Ilaria reală | Contract Ilaria, stare conectare, istoric limitat, anulare | Răspuns pe model real; serviciu absent/ocupat tratat corect; fără răspuns fictiv |
| 3. Simplificare | Inventar module/apelanți; eliminare simulări din fluxurile normale; separare componente mari | Eliminările au justificare și verificări de regresie |
| 4. Operații OS | Acțiuni structurate, scope workspace, jurnal, undo unde este posibil | Argumente validate; acces în scope; rezultat reflectă execuția reală |
| 5. Kernel/platform ADR | Swypik-owned kernel/platform vs hybrid vs Linux reference | Aceleași workload-uri măsurate; owner aprobă baza de producție |
| 6. Distribuție | Instalare, update verificat, rollback, diagnostic fără secrete | Path-ul ales bootează/upgradează pe target declarat; rollback păstrează datele |
| 7. Compute coordinator | Protocol independent de cloud vendor: device registry, leases, signed jobs, artifacts, verification | Auth, idempotency, restart/retry, verification și observabilitate testate |
| 8. GPU comunitar | Client opt-in cu limite și oprire imediată | Minimum 2 noduri reale; sarcină Ilaria validată; rezultat acceptat o dată; recuperare după deconectare |

Urmează etapele 1–2. Nu ștergem module doar după nume: unele prototipuri sunt importate de GDI și installer. Nu edităm simultan integrarea la care lucrează agentul Ilaria.

## Swyp Compute Fabric — contribuția GPU/CPU/NPU

Utilizatorul activează contribuția și poate opri workerul imediat. Setări: idle, alimentare, temperatură, putere, VRAM, trafic și spațiu. Fișierele personale și conversațiile nu devin automat date de antrenare.

Protocol: dispozitiv autentificat → capability/throughput measurement → manifest
de sarcină versionat/semnat → lease → execuție izolată și limitată → checkpoint/
heartbeat → rezultat cu hash + semnătură → replicare/spot-check/verificare →
muncă acceptată exact o dată. Tratăm expirare, duplicate, retry, checkpoint,
preemption și revocare. Actualizările nevalidate nu intră direct în model.

Raportăm secunde GPU măsurate și **useful verified compute**, separat de estimări.
Monedele, mining-ul și contoarele SWP existente sunt istorice/simulate și nu fac
parte din produs.

GPU-urile utilizatorilor sunt un pilon strategic de compute, nu un feature
secundar. Un accelerator fleet central poate fi folosit pentru bootstrap,
coordination, gold verification și workload-uri care cer interconnect rapid, dar
nu este singura sursă de compute. GPU-urile eterogene nu formează automat un
cluster sincron; schedulerul Ilaria/SwypikOS alege workload-ul potrivit după VRAM,
throughput, bandwidth, temperatură, power policy și disponibilitate.

## Calitate măsurabilă

Baseline reproductibil: boot, idle RAM, latență UI/IPC, power, erori, recuperare
după crash, task success, search quality, agentic task completion și throughput
compute distribuit. Comparațiile cu Windows/macOS/Linux folosesc aceleași
workload-uri și hardware comparabil.

Fiecare schimbare: problemă demonstrată, modificare limitată, verificare relevantă, limite documentate. Înaintea release-ului public: versionare Git, CI, teste end-to-end Windows și update/rollback. Folderul local nu avea repository Git la audit.
