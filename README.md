# SwypikOS

Proiectul limbajului a fost mutat separat în [D:\swyp lang](../swyp%20lang/README.md). Codul, testele, exemplele și măsurătorile Swyp Lang se găsesc acolo.

Shell desktop Windows în Go, cu UI web inclus în executabil. Rulează peste Windows; nu este încă un sistem bootabil independent. Ilaria din Nexus este singurul creier al produsului.

## Build și pornire

Windows și Go 1.21+, fără npm install. Din rădăcina proiectului:

```powershell
powershell -File scripts/build.ps1
.\Start-SwypikOS.bat
.\bin\swypik-os.exe -headless -port 0
```

Launcherul și shortcutul setează directorul proiectului. `create-shortcut.vbs` creează shortcutul desktop; `bin/SwypikInstaller.exe` recreează launcherul. `-gdi` selectează UI nativ experimental.

Configurație: `.env.example`. Pentru UI editabil fără rebuild: `SWYPIK_STATIC_DIR=ui/web`. API-ul poate executa comenzi cu permisiunile utilizatorului; păstrează bind-ul loopback. Filtrul de comenzi nu este sandbox OS.

Integrarea Ilaria în lucru folosește `http://127.0.0.1:8091`, configurabil prin `-ilaria-url`. Nu planificăm furnizori externi de modele. Vezi [contractul Nexus](docs/NEXUS_CONTRACT.md).

## Organizare

- `cmd`, `core`, `internal`, `config`, `ui`, `installer`, `mobile`: surse și teste, inclusiv prototipuri încă folosite.
- `scripts`: build și mentenanță.
- `bin`: executabile generate, excluse din versionare.
- `data`: stare persistentă, exclusă din versionare.
- `docs`: [plan OS](docs/OS_PLAN.md), [Azure și Brev](docs/AZURE_PLAN.md), contract Nexus și audit anterior.

Arhiva externă: `D:\swypik-os-archive\2026-09-27-cleanup`, cu manifest SHA-256 și copie a stării swarm. Nu este necesară pentru rulare.

## Verificare și limite

```powershell
go test ./...
go vet ./...
go test -race ./...
node --check ui/web/desktop.js
```

Race detector necesită compilator C compatibil. Node este necesar doar verificărilor JavaScript.

Desktopul, fișierele, comenzile locale și sunetul WAV sunt implementate. Antrenarea distribuită și recompensele conțin simulări; contoarele vechi nu dovedesc muncă GPU validată. Telemetria depinde de hardware/drivere. Audio nu implementează recunoaștere vocală; portofelul existent nu criptează cheile. Planul OS urmărește rezolvarea acestor limite.
