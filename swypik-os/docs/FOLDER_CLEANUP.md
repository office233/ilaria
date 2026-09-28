# Reorganizare verificată — 27 septembrie 2026

Sursele rămân în proiect. Executabilele sunt în `bin`, starea swarm existentă în `data`, materialele istorice în `D:\swypik-os-archive\2026-09-27-cleanup`.

Arhivă: cele două planuri vechi din rădăcină, planul anterior de execuție, referința NVIDIA, blueprintul OmniOS, launcherul duplicat Run.bat și două fișiere swarm de test. Starea swarm nevidă are copie de siguranță; mutările inițiale au fost verificate prin SHA-256. Manifestul arhivei permite localizarea fiecărui fișier.

Actualizări: launcher, shortcut desktop, installer și script unic `scripts/build.ps1`. Installerul își găsește rădăcina după locația executabilului, nu după directorul din care este invocat. Testul installerului verifică executabil lipsă și director cu spații.

Verificări trecute după reorganizare:

- Build SwypikOS și installer în `bin`.
- `go test ./...` și `go vet ./...`.
- Smoke test într-un workspace temporar: startup headless pe port alocat, UI embedded, telemetrie/configurație, listare fișiere, protejarea surselor, CORS, validarea inputului și WAV.

Nu s-au modificat fișiere Nexus sau resurse Azure. Testul headless nu validează inferența pe checkpoint real, trainingul GPU sau comportamentul complet al UI-ului Windows. Acestea sunt etape distincte în OS_PLAN.md.

CODE_AUDIT.md este raportul anterior reorganizării; comenzile sale de build care indică executabile în rădăcină sunt istorice. Comanda curentă este în README și scripts/build.ps1.
